/**
 * In-process job runner (Phase 5c, narrowed by 5d).
 *
 * A runner claims one job at a fixed, harness-owned identity, runs the
 * harness-registered handler for its role, keeps the lease alive while the
 * handler works, and reports the outcome back through {@link JobEngine}. It
 * composes 5a (lease authority) and 5b (role-aware claiming) rather than
 * reimplementing either: every transition still goes through `JobEngine`,
 * so its transactions, guarded filters and audit writes stay authoritative.
 *
 * Deliberately absent: the handler never receives `JobEngine`, never submits,
 * fails or accepts a job itself, and never chooses its own identity, tier or
 * claimable roles. "Which worker am I, and what may I claim" is a
 * control-plane fact fixed at construction, not something a handler call — or
 * a `runOnce` caller — can renegotiate per job.
 *
 * `identity.tier` is the maximum authority a worker of this tier could ever
 * have (5b's `rolesForTier`). `claimableRoles` is this *particular* worker's
 * fixed subset of it — how a specialised worker (a Terra build worker that
 * only knows `frontend_backend`, say) can exist without fake or
 * throwing-stub handlers for every other role its tier is merely permitted
 * to run. It can only narrow the tier's authority, never widen it; 5b's
 * `ROLE_TIER` stays the one canonical permission table.
 */
import { rolesForTier, type AgentTier, type ArtifactRef, type WorkerRole } from '@statxai/contracts';
import type { JobDocument } from '@statxai/state';
import { DEFAULT_LEASE_MS, JobAttemptConflict, JobLeaseConflict, JobStateConflict, type JobEngine } from './engine.js';

/**
 * The exact execution generation a claim granted (Phase 5f).
 *
 * A worker id is who the caller is; `attempt` is *which claim* of the job
 * this execution is. Both are needed: `JobRunner` always claims under one
 * fixed `workerId`, so if this job's lease expires and this same worker
 * claims it back, `workerId` alone can no longer distinguish the new
 * execution from the one that just lost authority over it. `attempt` is what
 * `JobEngine.claim` already increments on every successful claim (5a/enqueue)
 * and never decrements — a later claim of the same job always has a larger
 * one — so it is reused here rather than inventing a second counter.
 *
 * Captured exactly once, from the `JobDocument` `claim()` itself returned,
 * and never recomputed: an old execution stays permanently associated with
 * its own token, even after the job has moved on to a newer one.
 */
export interface JobExecutionToken {
  readonly jobId: string;
  readonly workerId: string;
  readonly attempt: number;
}

/**
 * The namespace a `JobHandler`'s output refs must live under to be accepted
 * (Phase 5f). Job ids are unique across the whole `jobs` collection (Mongo's
 * own `_id` uniqueness), so a ref actually named under *this* job's *this*
 * attempt could only have been produced by this exact execution — no other
 * job, in any project, can collide with it, and no other attempt of this same
 * job can either. This is the only namespacing rule `job-engine` enforces; it
 * has no idea what a "site file" or a "route decision" is, only that an
 * output must own the execution that produced it.
 */
export function jobOutputNamespace(jobId: string, attempt: number): string {
  return `job-output/${jobId}/${attempt}/`;
}

/**
 * Raised when a handler's returned output refs are not namespaced under the
 * execution that produced them. Defense at the harness boundary (§29 of the
 * brief this shipped under): a handler cannot make its own output
 * authoritative by construction, but nothing stops one from *trying* to
 * return a ref it does not own, and this is what catches that before
 * `submitForValidation` would otherwise attach it.
 */
export class InvalidJobOutputRefs extends Error {
  constructor(
    readonly jobId: string,
    readonly attempt: number,
    readonly invalidNames: readonly string[],
  ) {
    super(
      `Job ${jobId} attempt ${attempt}: output ref(s) not namespaced under ` +
        `${jobOutputNamespace(jobId, attempt)}: ${invalidNames.join(', ')}`,
    );
    this.name = 'InvalidJobOutputRefs';
  }
}

/**
 * What the runner is, fixed for its lifetime. Not worker-supplied and not
 * part of `JobSpec`: a worker identity is a fact the harness asserts about
 * itself, not model output, and letting a caller pick a different tier per
 * `runOnce` call would make claiming only as role-aware as its caller chose
 * to be honest about.
 */
export interface JobWorkerIdentity {
  readonly workerId: string;
  readonly tier: AgentTier;
}

export interface JobHandlerContext {
  /**
   * Aborted the moment this execution is known to have lost authority over
   * the job — a lost heartbeat, a heartbeat that could not reach the store,
   * or (later, once handlers exist) a normal cancellation. A handler that
   * ignores it still cannot affect the job: the runner never submits or
   * fails on its behalf once authority is gone.
   */
  readonly signal: AbortSignal;
}

/**
 * What a handler actually produced, if anything (Phase 5f). `outputs`, when
 * given, must be namespaced under {@link jobOutputNamespace} for this job's
 * claimed attempt — checked before they can ever be attached, so a handler
 * cannot make output authoritative merely by returning it.
 *
 * Optional refs on an optional result: a handler that returns nothing, or
 * returns `undefined`/`void`, stays perfectly valid — existing handlers that
 * predate this field are not required to invent output to remain correct.
 */
export interface JobHandlerResult {
  readonly outputs?: readonly ArtifactRef[];
}

/**
 * Does the work for one claimed job. Returns when the work is done, optionally
 * with what it produced; throws when it fails. The runner — not the handler —
 * decides what that becomes: `submitForValidation` (with those outputs
 * attached, atomically, in the same transition) on success, `fail` on
 * rejection, and neither once authority over the job is lost.
 */
export type JobHandler = (job: JobDocument, context: JobHandlerContext) => Promise<JobHandlerResult | void>;

export type AuthorityLostReason = 'heartbeat_lost' | 'transition_conflict';

export type JobRunOnceResult =
  | { kind: 'idle' }
  | { kind: 'submitted'; jobId: string; role: WorkerRole; attempt: number }
  | { kind: 'handler_failed'; jobId: string; jobState: 'ready' | 'failed'; attempt: number }
  | { kind: 'authority_lost'; jobId: string; reason: AuthorityLostReason };

/** Raised at construction; a runner that cannot possibly execute never claims. */
export class JobRunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobRunnerConfigError';
  }
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface JobRunnerOptions {
  engine: JobEngine;
  identity: JobWorkerIdentity;
  /**
   * The non-empty subset of {@link rolesForTier}(`identity.tier`) this
   * runner may claim. Fixed for its lifetime, exactly like `identity` — a
   * `runOnce` caller cannot widen it per call. Duplicate entries are
   * canonicalised, not rejected.
   */
  claimableRoles: readonly WorkerRole[];
  /**
   * Must cover every role in `claimableRoles` — not every role the tier
   * merely permits. A handler for a role outside `claimableRoles` may be
   * present; it is simply never reachable, since `claim` is never asked for
   * that role, so registering one grants no authority.
   */
  handlers: ReadonlyMap<WorkerRole, JobHandler>;
  leaseMs?: number;
  /** How often the lease is renewed while a handler runs. Default `leaseMs / 3`. */
  heartbeatEveryMs?: number;
  now?: () => Date;
  sleep?: SleepFn;
}

type HeartbeatOutcome = { kind: 'ok' } | { kind: 'lost' } | { kind: 'error'; error: unknown };

export class JobRunner {
  private readonly engine: JobEngine;
  private readonly identity: JobWorkerIdentity;
  private readonly claimableRoles: readonly WorkerRole[];
  private readonly handlers: ReadonlyMap<WorkerRole, JobHandler>;
  private readonly leaseMs: number;
  private readonly heartbeatEveryMs: number;
  private readonly now: () => Date;
  private readonly sleep: SleepFn;

  constructor(options: JobRunnerOptions) {
    this.engine = options.engine;
    this.identity = options.identity;
    this.handlers = options.handlers;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatEveryMs = options.heartbeatEveryMs ?? Math.floor(this.leaseMs / 3);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;

    if (this.leaseMs <= 0) {
      throw new JobRunnerConfigError('leaseMs must be greater than 0');
    }
    if (this.heartbeatEveryMs <= 0) {
      throw new JobRunnerConfigError('heartbeatEveryMs must be greater than 0');
    }
    if (this.heartbeatEveryMs >= this.leaseMs) {
      throw new JobRunnerConfigError('heartbeatEveryMs must be less than leaseMs, or the lease expires between renewals');
    }

    // `rolesForTier` is the same table 5b's `claim` filters candidates by; a
    // second, independent permission list here could only ever drift from it.
    // This is the ceiling `claimableRoles` is checked against below, not the
    // runner's own claim set — a tier with no executable roles (Sol) can
    // never back a runner regardless of what `claimableRoles` requests.
    const tierRoles = rolesForTier(this.identity.tier);
    if (tierRoles.length === 0) {
      throw new JobRunnerConfigError(
        `Tier "${this.identity.tier}" has no executable roles; it cannot back a job runner`,
      );
    }

    if (options.claimableRoles.length === 0) {
      throw new JobRunnerConfigError('claimableRoles must be non-empty');
    }
    const outsideTier = options.claimableRoles.filter((role) => !tierRoles.includes(role));
    if (outsideTier.length > 0) {
      throw new JobRunnerConfigError(
        `claimableRoles must be a subset of what tier "${this.identity.tier}" may execute; ` +
          `outside its authority: ${outsideTier.join(', ')}`,
      );
    }
    // Canonicalise duplicates rather than reject them: a repeated role is
    // redundant configuration, not a conflicting one.
    this.claimableRoles = [...new Set(options.claimableRoles)];

    const missing = this.claimableRoles.filter((role) => !this.handlers.has(role));
    if (missing.length > 0) {
      throw new JobRunnerConfigError(`Missing handler(s) for claimable role(s): ${missing.join(', ')}`);
    }
  }

  /**
   * Claim and run at most one job. Never claims more than one, never retries
   * on `idle`, never loops — a caller composes repeated calls into whatever
   * scheduling policy it wants; this is only the unit it repeats.
   */
  async runOnce(options: { projectId?: string } = {}): Promise<JobRunOnceResult> {
    const claimed = await this.engine.claim(this.identity.workerId, this.identity.tier, {
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      leaseMs: this.leaseMs,
      now: this.now(),
      roles: this.claimableRoles,
    });
    if (!claimed) return { kind: 'idle' };

    // The execution token: captured once, from the document claim() itself
    // returned, and reused for every authority-bearing call this execution
    // makes. Never recomputed by rereading the job later — an execution that
    // has lost authority has no way back to a token that would grant it any.
    const token: JobExecutionToken = {
      jobId: claimed._id,
      workerId: this.identity.workerId,
      attempt: claimed.attempt,
    };

    // Guaranteed by the constructor's coverage check plus the role filter on
    // `claim` (now `claimableRoles`, itself checked at construction to be a
    // subset of 5b's tier authority): a claimed job's role is always one
    // this runner may run, and every such role has a handler. Defensive, not
    // reachable.
    const handler = this.handlers.get(claimed.role);
    if (!handler) {
      throw new Error(`No handler registered for claimed role "${claimed.role}"; this should be unreachable`);
    }

    return this.execute(claimed, handler, token);
  }

  private async execute(job: JobDocument, handler: JobHandler, token: JobExecutionToken): Promise<JobRunOnceResult> {
    const controller = new AbortController();
    let stopped = false;

    const heartbeatLoop = async (): Promise<HeartbeatOutcome> => {
      while (!stopped) {
        await this.sleep(this.heartbeatEveryMs, controller.signal);
        if (stopped) break;
        try {
          const alive = await this.engine.heartbeat(token.jobId, token.workerId, token.attempt, this.leaseMs, {
            now: this.now(),
          });
          if (!alive) {
            controller.abort();
            return { kind: 'lost' };
          }
        } catch (error) {
          controller.abort();
          return { kind: 'error', error };
        }
      }
      return { kind: 'ok' };
    };

    const heartbeatDone = heartbeatLoop();

    let handlerOutcome: { ok: true; outputs: readonly ArtifactRef[] | undefined } | { ok: false; error: unknown };
    try {
      const result = await handler(job, { signal: controller.signal });
      const outputs = result?.outputs;
      if (outputs !== undefined) this.assertOwnedOutputs(token, outputs);
      handlerOutcome = { ok: true, outputs };
    } catch (error) {
      handlerOutcome = { ok: false, error };
    }

    // Stop and fully drain the heartbeat loop before any authoritative
    // transition. A heartbeat that is still in flight, or one that started
    // just before the handler settled, must be allowed to finish and be
    // accounted for — a late "lost" must still cancel the submit that would
    // otherwise follow, not race it.
    stopped = true;
    controller.abort();
    const heartbeatResult = await heartbeatDone;

    if (heartbeatResult.kind === 'error') {
      // Fail closed: the control plane could not be asked whether this
      // worker still holds the job, so it must not act as though it does.
      // Recovery is the lease reaper's job, not a fabricated handler failure.
      throw heartbeatResult.error;
    }
    if (heartbeatResult.kind === 'lost') {
      return { kind: 'authority_lost', jobId: token.jobId, reason: 'heartbeat_lost' };
    }

    if (handlerOutcome.ok) {
      try {
        const submitted = await this.engine.submitForValidation(token.jobId, token.workerId, token.attempt, {
          now: this.now(),
          ...(handlerOutcome.outputs !== undefined ? { outputs: handlerOutcome.outputs } : {}),
        });
        return { kind: 'submitted', jobId: submitted._id, role: submitted.role, attempt: submitted.attempt };
      } catch (error) {
        if (this.isAuthorityConflict(error)) {
          return { kind: 'authority_lost', jobId: token.jobId, reason: 'transition_conflict' };
        }
        throw error;
      }
    }

    const message = handlerOutcome.error instanceof Error ? handlerOutcome.error.message : String(handlerOutcome.error);
    try {
      const failed = await this.engine.fail(token.jobId, message, token.workerId, token.attempt, { now: this.now() });
      // `fail` only ever returns a job in 'ready' (a retry remains) or
      // 'failed' (attempts exhausted) — see JobEngine.fail.
      const jobState = failed.state as 'ready' | 'failed';
      return { kind: 'handler_failed', jobId: failed._id, jobState, attempt: failed.attempt };
    } catch (error) {
      if (this.isAuthorityConflict(error)) {
        return { kind: 'authority_lost', jobId: token.jobId, reason: 'transition_conflict' };
      }
      throw error;
    }
  }

  private isAuthorityConflict(error: unknown): boolean {
    return error instanceof JobLeaseConflict || error instanceof JobStateConflict || error instanceof JobAttemptConflict;
  }

  /**
   * The harness-side half of Phase 5f: a handler cannot make its own output
   * authoritative merely by returning it. Every ref must be namespaced under
   * this exact execution's own {@link jobOutputNamespace} — not any other
   * job's, and not an earlier or later attempt of this same job's.
   */
  private assertOwnedOutputs(token: JobExecutionToken, outputs: readonly ArtifactRef[]): void {
    const prefix = jobOutputNamespace(token.jobId, token.attempt);
    const invalid = outputs.filter((ref) => !ref.name.startsWith(prefix)).map((ref) => ref.name);
    if (invalid.length > 0) {
      throw new InvalidJobOutputRefs(token.jobId, token.attempt, invalid);
    }
  }
}
