/**
 * The semantic-edit worker: the long-running process that continues submitted
 * semantic edits after the request that submitted them is gone.
 *
 * Its loop, bounded at every step:
 *
 *   lease one runnable intent (never one whose lease is alive)
 *     → renew that lease while working; losing it aborts the execution
 *     → if the edit's own job is `running` on an expired lease, reclaim exactly
 *       that job (a dead worker's attempt is spent; its tokens go stale)
 *     → continue exactly that intent through the one semantic-edit continuation
 *     → classify how it stopped: completed; a known terminal outcome (recorded,
 *       never retried automatically); retryable (lease released, picked up again)
 *
 * The worker owns execution only. It never claims, releases or re-derives a
 * draft, never builds a second edit, never looks anything up as "latest", and
 * never reaches release or publication. It holds no customer identity: it trusts
 * the exact intent a caller already authorised and submitted.
 */
import type { StateStore } from '@statxai/state';
import { JobEngine } from '@statxai/job-engine';
import { CanonicalDraftAuthorityCorrupt, CanonicalDraftConclusionRefused } from '../canonical-draft/authority.js';
import type { FrontendBackendLifecycleResult } from '../job-lifecycle/frontend-backend.js';
import { SemanticEditAuthorityCorrupt, SemanticEditExecutionLeaseLost, resumeSemanticEditIntent, type SemanticEditDeps, type SemanticEditResult } from './apply.js';
import {
  claimSemanticEditExecution,
  heartbeatSemanticEditExecution,
  recordSemanticEditDisposition,
  recordSemanticEditExecutionFailure,
  releaseSemanticEditExecution,
  type ClaimedSemanticEditExecution,
} from './execution.js';

export interface SemanticEditWorkerLimits {
  /** Edits this process executes at once. */
  readonly concurrency: number;
  /** How long to wait before looking for work again when there is none. Latency only. */
  readonly pollMs: number;
  /** An execution lease's lifetime without renewal. */
  readonly leaseMs: number;
  /** How often a live execution renews it; well under `leaseMs`. */
  readonly heartbeatMs: number;
  /** Unexpected continuation failures, or evaluations that could not complete, before an edit stops being retried. */
  readonly maxExecutionFailures: number;
}

export const SEMANTIC_EDIT_WORKER_DEFAULTS: SemanticEditWorkerLimits = Object.freeze({
  concurrency: 1,
  pollMs: 5_000,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxExecutionFailures: 3,
});

export class SemanticEditWorkerConfigInvalid extends Error {
  constructor(detail: string) {
    super(`semantic edit worker configuration refused: ${detail}`);
    this.name = 'SemanticEditWorkerConfigInvalid';
  }
}

/** Bounds every limit; nothing correctness depends on is left to tuning. */
export function resolveSemanticEditWorkerLimits(overrides: Partial<SemanticEditWorkerLimits> = {}): SemanticEditWorkerLimits {
  const limits = { ...SEMANTIC_EDIT_WORKER_DEFAULTS, ...overrides };
  const within = (name: keyof SemanticEditWorkerLimits, min: number, max: number) => {
    const value = limits[name];
    if (!Number.isInteger(value) || value < min || value > max) throw new SemanticEditWorkerConfigInvalid(`${name} must be an integer in [${min}, ${max}], not ${value}`);
  };
  within('concurrency', 1, 16);
  within('pollMs', 50, 300_000);
  within('leaseMs', 1_000, 3_600_000);
  within('heartbeatMs', 50, 1_800_000);
  within('maxExecutionFailures', 1, 20);
  if (limits.heartbeatMs * 2 > limits.leaseMs) throw new SemanticEditWorkerConfigInvalid('heartbeatMs must be at most half of leaseMs, so one missed renewal never loses a live lease');
  return limits;
}

/** Lifecycle stops a worker does not retry: the job will not produce a different result by being run again. */
const TERMINAL_LIFECYCLE: Readonly<Partial<Record<Exclude<FrontendBackendLifecycleResult['outcome'], 'promoted'>, 'validation_failed' | 'build_failed'>>> = Object.freeze({
  validation_failed: 'validation_failed',
  failed: 'build_failed',
  blocked: 'build_failed',
  superseded: 'build_failed',
  repair_requested: 'build_failed',
  draft: 'build_failed',
});

export type SemanticEditWorkerEvent =
  | { readonly event: 'worker_started'; readonly owner: string; readonly limits: SemanticEditWorkerLimits }
  | { readonly event: 'worker_stopping'; readonly owner: string; readonly active: number }
  | { readonly event: 'worker_stopped'; readonly owner: string }
  | { readonly event: 'intent_claimed' | 'intent_resumed'; readonly intentId: string; readonly projectId: string }
  | { readonly event: 'job_lease_reclaimed'; readonly intentId: string; readonly jobId: string; readonly jobState: string }
  | { readonly event: 'intent_completed'; readonly intentId: string; readonly resultDraftId: string | null }
  | { readonly event: 'intent_waiting'; readonly intentId: string; readonly outcome: string }
  | { readonly event: 'intent_failed'; readonly intentId: string; readonly reason: string }
  | { readonly event: 'intent_lease_lost'; readonly intentId: string }
  | { readonly event: 'intent_error'; readonly intentId: string; readonly failures: number | null; readonly error: string };

export interface SemanticEditWorkerOptions extends SemanticEditDeps {
  /** This process's worker identity: stable for its lifetime, unique among workers. Never authority. */
  readonly owner: string;
  readonly limits?: Partial<SemanticEditWorkerLimits>;
  /** Lease timings for the edit's build job, when a test needs them shorter. */
  readonly jobLeaseMs?: number;
  readonly jobHeartbeatEveryMs?: number;
  readonly now?: () => Date;
  readonly log?: (event: SemanticEditWorkerEvent) => void;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Errors that mean durable authority contradicts itself: an operator must look; retrying cannot help. */
function isAuthorityCorrupt(error: unknown): boolean {
  return error instanceof SemanticEditAuthorityCorrupt || error instanceof CanonicalDraftAuthorityCorrupt || error instanceof CanonicalDraftConclusionRefused;
}

export class SemanticEditWorker {
  readonly limits: SemanticEditWorkerLimits;
  private readonly store: StateStore;
  private readonly engine: JobEngine;
  private readonly now: () => Date;
  private readonly log: (event: SemanticEditWorkerEvent) => void;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly stopping = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(private readonly options: SemanticEditWorkerOptions) {
    if (!options.owner || options.owner.length > 200) throw new SemanticEditWorkerConfigInvalid('owner must be a non-empty identifier');
    this.limits = resolveSemanticEditWorkerLimits(options.limits);
    this.store = options.store;
    this.engine = new JobEngine(options.store);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /** How many edits this process is executing right now. Never more than `limits.concurrency`. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Start the poll loop. Resolves when the worker has stopped. */
  start(): Promise<void> {
    if (this.loop) return this.loop;
    this.log({ event: 'worker_started', owner: this.options.owner, limits: this.limits });
    this.loop = this.run();
    return this.loop;
  }

  /**
   * Stop claiming, abort running executions between their steps, and wait for
   * them — at most `graceMs`. Draft claims are never touched; execution leases
   * that are not released simply expire, and another worker continues the edits.
   */
  async stop(graceMs = 30_000): Promise<void> {
    this.log({ event: 'worker_stopping', owner: this.options.owner, active: this.active.size });
    this.stopping.abort();
    for (const { controller } of this.active.values()) controller.abort();
    const settled = Promise.allSettled([...this.active.values()].map((a) => a.done));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, graceMs))]);
    await this.loop?.catch(() => undefined);
    this.log({ event: 'worker_stopped', owner: this.options.owner });
  }

  private async run(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      const claimed = this.active.size < this.limits.concurrency ? await this.claimOne().catch(() => null) : null;
      if (claimed) continue;
      await abortableSleep(this.limits.pollMs, this.stopping.signal);
    }
  }

  /**
   * Lease one runnable edit and start executing it, if a slot is free. Returns
   * whether it did. Exposed for tests and one-shot drains; the loop uses it too.
   */
  async claimOne(): Promise<boolean> {
    if (this.stopping.signal.aborted || this.active.size >= this.limits.concurrency) return false;
    const lease = await claimSemanticEditExecution(this.store, { owner: this.options.owner, leaseMs: this.limits.leaseMs, now: this.now() });
    if (!lease) return false;
    this.log({ event: 'intent_claimed', intentId: lease.intentId, projectId: lease.projectId });
    const controller = new AbortController();
    const done = this.execute(lease, controller).finally(() => this.active.delete(lease.intentId));
    this.active.set(lease.intentId, { controller, done });
    return true;
  }

  /** Wait for every execution this process has started. */
  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }

  private async execute(lease: ClaimedSemanticEditExecution, controller: AbortController): Promise<void> {
    const { leaseMs, heartbeatMs } = this.limits;
    let beating = true;
    const heartbeat = (async () => {
      while (beating && !controller.signal.aborted) {
        await abortableSleep(heartbeatMs, controller.signal);
        if (!beating || controller.signal.aborted) return;
        const alive = await heartbeatSemanticEditExecution(this.store, lease, leaseMs, this.now()).catch(() => false);
        if (!alive) {
          this.log({ event: 'intent_lease_lost', intentId: lease.intentId });
          controller.abort();
          return;
        }
      }
    })();

    try {
      // A build job left `running` by a dead worker: reclaimed exactly, and only once its lease has really expired.
      if (lease.status === 'building') {
        const job = await this.store.jobs.findOne({ _id: lease.jobId, projectId: lease.projectId });
        if (job?.state === 'running' && job.lease && job.lease.expiresAt.getTime() <= this.now().getTime()) {
          const reclaimed = await this.engine.reclaimExpiredJobLease(job._id, `semantic-edit-worker:${this.options.owner}`, this.now());
          if (reclaimed) this.log({ event: 'job_lease_reclaimed', intentId: lease.intentId, jobId: job._id, jobState: reclaimed.state });
        }
      }

      this.log({ event: 'intent_resumed', intentId: lease.intentId, projectId: lease.projectId });
      const result = await resumeSemanticEditIntent(this.options, { projectId: lease.projectId, intentId: lease.intentId }, {
        leaseToken: lease.token,
        signal: controller.signal,
        jobWorkerId: `semantic-edit-worker:${this.options.owner}`,
        ...(this.options.jobLeaseMs !== undefined ? { jobLeaseMs: this.options.jobLeaseMs } : {}),
        ...(this.options.jobHeartbeatEveryMs !== undefined ? { jobHeartbeatEveryMs: this.options.jobHeartbeatEveryMs } : {}),
      });
      beating = false;
      await this.settle(lease, result);
    } catch (error) {
      beating = false;
      if (controller.signal.aborted || error instanceof SemanticEditExecutionLeaseLost) {
        // Lease lost or shutting down: this execution writes nothing more; the lease expires or is already another's.
        return;
      }
      if (isAuthorityCorrupt(error)) {
        await recordSemanticEditDisposition(this.store, lease, 'authority_corrupt', this.now());
        this.log({ event: 'intent_failed', intentId: lease.intentId, reason: 'authority_corrupt' });
        return;
      }
      const failures = await recordSemanticEditExecutionFailure(this.store, lease, { maxFailures: this.limits.maxExecutionFailures, failureReason: 'execution_failed' }, this.now());
      this.log({ event: 'intent_error', intentId: lease.intentId, failures, error: error instanceof Error ? error.name : 'Error' });
    } finally {
      beating = false;
      controller.abort();
      await heartbeat;
    }
  }

  private async settle(lease: ClaimedSemanticEditExecution, result: SemanticEditResult | null): Promise<void> {
    if (!result) {
      await recordSemanticEditDisposition(this.store, lease, 'authority_corrupt', this.now());
      this.log({ event: 'intent_failed', intentId: lease.intentId, reason: 'authority_corrupt' });
      return;
    }
    if (result.status === 'completed') {
      await releaseSemanticEditExecution(this.store, lease);
      this.log({ event: 'intent_completed', intentId: lease.intentId, resultDraftId: result.resultDraftId });
      return;
    }
    const terminal = result.lifecycleOutcome ? TERMINAL_LIFECYCLE[result.lifecycleOutcome] : undefined;
    if (terminal) {
      await recordSemanticEditDisposition(this.store, lease, terminal, this.now());
      this.log({ event: 'intent_failed', intentId: lease.intentId, reason: terminal });
      return;
    }
    if (result.evaluationUnavailable !== null) {
      await recordSemanticEditExecutionFailure(this.store, lease, { maxFailures: this.limits.maxExecutionFailures, failureReason: 'evaluation_unavailable' }, this.now());
      this.log({ event: 'intent_waiting', intentId: lease.intentId, outcome: 'evaluation_unavailable' });
      return;
    }
    // retry_ready, in_progress, not_claimable: the job's own state and attempt bounds decide; try again later.
    await releaseSemanticEditExecution(this.store, lease);
    this.log({ event: 'intent_waiting', intentId: lease.intentId, outcome: result.lifecycleOutcome ?? 'unknown' });
  }
}
