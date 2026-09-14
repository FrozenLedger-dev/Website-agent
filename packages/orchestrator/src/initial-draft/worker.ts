/**
 * The initial-draft worker: the long-running process that continues customer
 * self-service project-creation requests after the HTTP request that
 * submitted them is gone.
 *
 * A separate process from the semantic-edit worker, deliberately. They share
 * the lease/heartbeat/CAS shape (see `../semantic-edit/worker.js`, which this
 * mirrors closely) because that shape is the right one for "durable request,
 * continued by whichever worker holds the lease" in general — but they own
 * different collections, different terminal vocabularies, and drive
 * `runProject` completely differently (a semantic edit resumes one already-
 * claimed job; an initial draft calls `runProject` itself, relying on its own
 * `runIntentHash` resume machinery). Folding this into `SemanticEditWorker`
 * would mean branching that class on "which kind of work is this" — the
 * generic task framework the capability this shipped under was explicitly
 * asked not to build. Two small, single-purpose workers stay easier to reason
 * about than one that grew a second job.
 *
 * Its loop, bounded at every step:
 *
 *   lease one runnable request (never one whose lease is alive)
 *     → renew that lease while working; losing it aborts the execution
 *     → continue exactly that request through `resumeInitialDraftGeneration`,
 *       which reclaims a stuck build job lease and calls `runProject` itself
 *     → classify how it stopped: completed; a known terminal failure
 *       (recorded, never retried automatically); still in progress (lease
 *       released, picked up again — by this worker or another)
 *
 * The worker owns execution only. It never authorises a customer, a project or
 * an account, never mints a project id, and never reaches release or
 * publication — `runProject` is always called with `completionTarget: 'draft'`.
 */
import type { StateStore } from '@statxai/state';
import type { Provider } from '@statxai/agents';
import { InitialDraftAuthorityCorrupt, resumeInitialDraftGeneration, type InitialDraftGenerationOutcome } from './generate.js';
import {
  claimInitialDraftGeneration,
  completeInitialDraftGeneration,
  heartbeatInitialDraftGeneration,
  recordInitialDraftDisposition,
  recordInitialDraftExecutionFailure,
  releaseInitialDraftGeneration,
  type ClaimedInitialDraftGeneration,
} from './execution.js';

export interface InitialDraftWorkerLimits {
  readonly concurrency: number;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly maxExecutionFailures: number;
}

export const INITIAL_DRAFT_WORKER_DEFAULTS: InitialDraftWorkerLimits = Object.freeze({
  concurrency: 1,
  pollMs: 5_000,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxExecutionFailures: 3,
});

export class InitialDraftWorkerConfigInvalid extends Error {
  constructor(detail: string) {
    super(`initial draft worker configuration refused: ${detail}`);
    this.name = 'InitialDraftWorkerConfigInvalid';
  }
}

export function resolveInitialDraftWorkerLimits(overrides: Partial<InitialDraftWorkerLimits> = {}): InitialDraftWorkerLimits {
  const limits = { ...INITIAL_DRAFT_WORKER_DEFAULTS, ...overrides };
  const within = (name: keyof InitialDraftWorkerLimits, min: number, max: number) => {
    const value = limits[name];
    if (!Number.isInteger(value) || value < min || value > max) throw new InitialDraftWorkerConfigInvalid(`${name} must be an integer in [${min}, ${max}], not ${value}`);
  };
  within('concurrency', 1, 16);
  within('pollMs', 50, 300_000);
  within('leaseMs', 1_000, 3_600_000);
  within('heartbeatMs', 50, 1_800_000);
  within('maxExecutionFailures', 1, 20);
  if (limits.heartbeatMs * 2 > limits.leaseMs) throw new InitialDraftWorkerConfigInvalid('heartbeatMs must be at most half of leaseMs, so one missed renewal never loses a live lease');
  return limits;
}

export type InitialDraftWorkerEvent =
  | { readonly event: 'worker_started'; readonly owner: string; readonly limits: InitialDraftWorkerLimits }
  | { readonly event: 'worker_stopping'; readonly owner: string; readonly active: number }
  | { readonly event: 'worker_stopped'; readonly owner: string }
  | { readonly event: 'request_claimed'; readonly requestId: string; readonly projectId: string }
  | { readonly event: 'request_completed'; readonly requestId: string; readonly resultDraftId: string }
  | { readonly event: 'request_waiting'; readonly requestId: string }
  | { readonly event: 'request_failed'; readonly requestId: string; readonly reason: string }
  | { readonly event: 'request_lease_lost'; readonly requestId: string }
  | { readonly event: 'request_error'; readonly requestId: string; readonly failures: number | null; readonly error: string };

export interface InitialDraftWorkerOptions {
  readonly store: StateStore;
  readonly workspacesRoot: string;
  readonly validationWorkspacesRoot: string;
  readonly modelProvider?: Provider;
  /** This process's worker identity: stable for its lifetime, unique among workers. Never authority. */
  readonly owner: string;
  readonly limits?: Partial<InitialDraftWorkerLimits>;
  readonly now?: () => Date;
  readonly log?: (event: InitialDraftWorkerEvent) => void;
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

export class InitialDraftWorker {
  readonly limits: InitialDraftWorkerLimits;
  private readonly store: StateStore;
  private readonly now: () => Date;
  private readonly log: (event: InitialDraftWorkerEvent) => void;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly stopping = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(private readonly options: InitialDraftWorkerOptions) {
    if (!options.owner || options.owner.length > 200) throw new InitialDraftWorkerConfigInvalid('owner must be a non-empty identifier');
    this.limits = resolveInitialDraftWorkerLimits(options.limits);
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

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
   * them — at most `graceMs`. Execution leases that are not released simply
   * expire; another worker continues those requests. Nothing about the
   * project, its binding or its request is touched by stopping.
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

  /** Lease one runnable request and start executing it, if a slot is free. Returns whether it did. */
  async claimOne(): Promise<boolean> {
    if (this.stopping.signal.aborted || this.active.size >= this.limits.concurrency) return false;
    const lease = await claimInitialDraftGeneration(this.store, { owner: this.options.owner, leaseMs: this.limits.leaseMs, now: this.now() });
    if (!lease) return false;
    this.log({ event: 'request_claimed', requestId: lease.requestId, projectId: lease.projectId });
    const controller = new AbortController();
    const done = this.execute(lease, controller).finally(() => this.active.delete(lease.requestId));
    this.active.set(lease.requestId, { controller, done });
    return true;
  }

  /** Wait for every execution this process has started. */
  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }

  private async execute(lease: ClaimedInitialDraftGeneration, controller: AbortController): Promise<void> {
    const { leaseMs, heartbeatMs } = this.limits;
    let beating = true;
    const heartbeat = (async () => {
      while (beating && !controller.signal.aborted) {
        await abortableSleep(heartbeatMs, controller.signal);
        if (!beating || controller.signal.aborted) return;
        const alive = await heartbeatInitialDraftGeneration(this.store, lease, leaseMs, this.now()).catch(() => false);
        if (!alive) {
          this.log({ event: 'request_lease_lost', requestId: lease.requestId });
          controller.abort();
          return;
        }
      }
    })();

    try {
      const result = await resumeInitialDraftGeneration(
        { store: this.store, workspacesRoot: this.options.workspacesRoot, validationWorkspacesRoot: this.options.validationWorkspacesRoot, ...(this.options.modelProvider !== undefined ? { modelProvider: this.options.modelProvider } : {}) },
        { requestId: lease.requestId, projectId: lease.projectId, token: lease.token },
      );
      beating = false;
      await this.settle(lease, result);
    } catch (error) {
      beating = false;
      if (controller.signal.aborted) return;
      if (error instanceof InitialDraftAuthorityCorrupt) {
        await recordInitialDraftDisposition(this.store, lease, 'needs_attention', this.now());
        this.log({ event: 'request_failed', requestId: lease.requestId, reason: 'needs_attention' });
        return;
      }
      const failures = await recordInitialDraftExecutionFailure(this.store, lease, { maxFailures: this.limits.maxExecutionFailures }, this.now());
      this.log({ event: 'request_error', requestId: lease.requestId, failures, error: error instanceof Error ? error.name : 'Error' });
    } finally {
      beating = false;
      controller.abort();
      await heartbeat;
    }
  }

  private async settle(lease: ClaimedInitialDraftGeneration, result: InitialDraftGenerationOutcome): Promise<void> {
    if (result.status === 'completed') {
      await completeInitialDraftGeneration(this.store, lease, result.resultDraftId, this.now());
      this.log({ event: 'request_completed', requestId: lease.requestId, resultDraftId: result.resultDraftId });
      return;
    }
    if (result.status === 'failed') {
      await recordInitialDraftDisposition(this.store, lease, result.reason, this.now());
      this.log({ event: 'request_failed', requestId: lease.requestId, reason: result.reason });
      return;
    }
    // in_progress: the job's own state and attempt bounds decide; try again later.
    await releaseInitialDraftGeneration(this.store, lease, this.now());
    this.log({ event: 'request_waiting', requestId: lease.requestId });
  }
}
