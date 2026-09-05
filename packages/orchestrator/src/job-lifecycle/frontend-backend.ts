/**
 * Harness-owned single `frontend_backend` job lifecycle (Phase 5i).
 *
 * Every individual production piece already exists — a real Terra handler
 * (5e/5f), isolated deterministic validation (5g-1), atomic acceptance
 * (5g-2), replay-safe canonical promotion (5h) — but nothing yet chains them
 * together for one explicit job. This module is that composition, and
 * nothing else: it calls the existing production boundaries in sequence,
 * driven by the job's own durable state, and never reimplements what any of
 * them already does.
 *
 * The legacy direct delivery entrypoint still builds without going through
 * `JobEngine` at all — this module does not replace it, and nothing here
 * changes it. This is the explicit harness-owned lifecycle primitive;
 * wiring a production entrypoint to call it is later work.
 *
 * What this module deliberately is not: a generic multi-role workflow
 * engine, a polling daemon, a plan-to-job compiler, a repair-work router,
 * or a deployment pipeline. It drives exactly one `frontend_backend`
 * `JobSpec`, to at most one Terra worker execution attempt, per call.
 */
import type { ArtifactRef, JobSpec, JobState } from '@statxai/contracts';
import type { JobDocument, StateStore } from '@statxai/state';
import { contentHash, type ArtifactRegistry, type BuildResult } from '@statxai/workspace';
import type { ModelClient } from '@statxai/agents';
import { JobRunner, type JobEngine, type JobWorkerIdentity, type SleepFn } from '@statxai/job-engine';
import {
  createTerraFrontendBackendHandler,
  FRONTEND_BACKEND_INPUT,
} from '../job-handlers/frontend-backend.js';
import {
  createFrontendBackendCandidateValidator,
  type FrontendBackendCandidateValidation,
} from '../job-validation/frontend-backend.js';
import { acceptValidatedFrontendBackendCandidate } from '../job-acceptance/frontend-backend.js';
import { promoteAcceptedFrontendBackendCandidate } from '../job-promotion/frontend-backend.js';
import type { Progress, RunDeps } from '../run-context.js';

const ROLE = 'frontend_backend';

/** Raised at construction; a coordinator that could not possibly run this lifecycle never accepts a job. */
export class FrontendBackendLifecycleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontendBackendLifecycleConfigError';
  }
}

/** The supplied `JobSpec.role` is not `frontend_backend` — this coordinator drives that one role only. */
export class FrontendBackendLifecycleRoleMismatch extends Error {
  constructor(actual: string) {
    super(`frontend_backend lifecycle invoked with a JobSpec whose role is "${actual}", not "${ROLE}"`);
    this.name = 'FrontendBackendLifecycleRoleMismatch';
  }
}

/** A required pinned input is missing from the supplied `JobSpec`, before any job is ever enqueued. */
export class FrontendBackendLifecycleInputInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontendBackendLifecycleInputInvalid';
  }
}

/**
 * `spec.jobId` already names a job, but its immutable `JobSpec` differs from
 * the one just supplied. An explicit rerun of the same lifecycle request
 * must address the same job; a *different* request reusing the same id is a
 * caller error, never silently executed against the existing job nor used
 * to create a second one.
 */
export class FrontendBackendLifecycleJobConflict extends Error {
  constructor(jobId: string) {
    super(
      `job "${jobId}" already exists with a different JobSpec than the one supplied to this lifecycle invocation`,
    );
    this.name = 'FrontendBackendLifecycleJobConflict';
  }
}

export interface FrontendBackendLifecycleDeps {
  readonly store: StateStore;
  readonly registry: ArtifactRegistry;
  readonly engine: JobEngine;
  readonly model: ModelClient;
  /** Must be `tier: 'terra'` — this is specifically the production frontend_backend Terra lifecycle. */
  readonly workerIdentity: JobWorkerIdentity;
  /** Root of the canonical, harness-owned project workspaces Phase 5h promotes into. */
  readonly workspacesRoot: string;
  /** Root under which Phase 5g-1 creates and tears down its own disposable validation workspace per call. */
  readonly validationWorkspacesRoot: string;
  readonly say?: Progress;
  readonly track?: RunDeps['track'];
  readonly leaseMs?: number;
  readonly heartbeatEveryMs?: number;
  readonly now?: () => Date;
  readonly sleep?: SleepFn;
}

/** What deterministic validation found, when it stopped the lifecycle. Never the 5g-1 evidence object itself. */
export interface FrontendBackendLifecycleValidationReport {
  readonly compiled: BuildResult;
  readonly gateRun: FrontendBackendCandidateValidation['gateRun'];
}

export type FrontendBackendLifecycleResult =
  | {
      readonly outcome: 'promoted';
      readonly jobId: string;
      readonly attempt: number;
      readonly candidate: ArtifactRef;
      readonly promotionId: string;
      readonly commitSha: string;
      readonly enqueued: boolean;
      readonly workerExecuted: boolean;
    }
  | {
      readonly outcome: 'validation_failed';
      readonly jobId: string;
      readonly attempt: number;
      readonly report: FrontendBackendLifecycleValidationReport;
      readonly enqueued: boolean;
      readonly workerExecuted: boolean;
    }
  | {
      readonly outcome:
        | 'in_progress'
        | 'retry_ready'
        | 'not_claimable'
        | 'failed'
        | 'repair_requested'
        | 'blocked'
        | 'draft';
      readonly jobId: string;
      readonly state: JobState;
      readonly enqueued: boolean;
      readonly workerExecuted: boolean;
    };

export interface FrontendBackendLifecycleCoordinator {
  run(spec: JobSpec): Promise<FrontendBackendLifecycleResult>;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

function requirePinnedInput(spec: JobSpec, key: string): void {
  if (!spec.inputs[key]) {
    throw new FrontendBackendLifecycleInputInvalid(
      `frontend_backend lifecycle: JobSpec "${spec.jobId}" is missing required pinned input "${key}"`,
    );
  }
}

/**
 * Whole-`JobSpec` structural equality, independent of object-key order —
 * exactly `JobPromotionRecord`'s own identity primitive (`contentHash`,
 * `@statxai/workspace`), reused rather than a second equality scheme.
 * `JobSpec` carries only immutable fields to begin with (`state`, `attempt`,
 * `lease`, `failure`, `executionOutputs` all live as siblings on
 * `JobDocument`, never nested inside `.spec`), so comparing two `.spec`
 * values this way can never accidentally compare mutable runtime state.
 */
function sameJobSpec(a: JobSpec, b: JobSpec): boolean {
  return contentHash(a) === contentHash(b);
}

/**
 * Compose the existing production `frontend_backend` pieces into one
 * explicit, harness-owned lifecycle for one stable `JobSpec`/`jobId`.
 *
 * `deps.workerIdentity.tier` must be `'terra'` — checked here, explicitly,
 * rather than left to `JobRunner`'s own incidental rejection of a
 * `claimableRoles: ['frontend_backend']` runner backed by a tier that
 * cannot execute it. The `JobRunner` this constructs is fixed to exactly
 * that one claimable role: this lifecycle claims and runs `frontend_backend`
 * jobs only, never any other Terra role its tier ceiling would otherwise
 * permit.
 */
export function createFrontendBackendLifecycleCoordinator(
  deps: FrontendBackendLifecycleDeps,
): FrontendBackendLifecycleCoordinator {
  if (deps.workerIdentity.tier !== 'terra') {
    throw new FrontendBackendLifecycleConfigError(
      `frontend_backend lifecycle requires a Terra worker identity; got tier "${deps.workerIdentity.tier}"`,
    );
  }

  const handler = createTerraFrontendBackendHandler({
    registry: deps.registry,
    model: deps.model,
    ...(deps.say !== undefined ? { say: deps.say } : {}),
    ...(deps.track !== undefined ? { track: deps.track } : {}),
  });

  const runner = new JobRunner({
    engine: deps.engine,
    identity: deps.workerIdentity,
    claimableRoles: [ROLE],
    handlers: new Map([[ROLE, handler]]),
    ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
    ...(deps.heartbeatEveryMs !== undefined ? { heartbeatEveryMs: deps.heartbeatEveryMs } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
  });

  const validate = createFrontendBackendCandidateValidator({
    registry: deps.registry,
    validationWorkspacesRoot: deps.validationWorkspacesRoot,
  });

  async function readJob(jobId: string): Promise<JobDocument> {
    const job = await deps.store.jobs.findOne({ _id: jobId });
    if (!job) throw new Error(`frontend_backend lifecycle: job "${jobId}" disappeared from durable state`);
    return job;
  }

  /**
   * Idempotent ensure/enqueue (§9-11 of the brief this shipped under): read
   * whether `spec.jobId` already exists; if absent, enqueue it through
   * `JobEngine.enqueue` — never a raw `store.jobs` insert; if present,
   * verify it is the same immutable request rather than executing against,
   * or silently coexisting with, a different one. A concurrent second
   * caller that loses the race on the unique `_id` re-reads and verifies
   * the same way, rather than ever producing a second job.
   */
  async function ensureJob(spec: JobSpec): Promise<{ job: JobDocument; enqueued: boolean }> {
    const existing = await deps.store.jobs.findOne({ _id: spec.jobId });
    if (existing) {
      if (!sameJobSpec(existing.spec, spec)) throw new FrontendBackendLifecycleJobConflict(spec.jobId);
      return { job: existing, enqueued: false };
    }
    try {
      const created = await deps.engine.enqueue({ spec, origin: { kind: 'plan' } });
      return { job: created, enqueued: true };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await deps.store.jobs.findOne({ _id: spec.jobId });
      if (!raced) throw error;
      if (!sameJobSpec(raced.spec, spec)) throw new FrontendBackendLifecycleJobConflict(spec.jobId);
      return { job: raced, enqueued: false };
    }
  }

  /**
   * Advance the lifecycle from the job's current, freshly-read durable
   * state. Recurses forward after a durable transition this call itself
   * caused — the happy path may run `ready -> ... -> promoted` in one
   * invocation — but a `ready` state reached a *second* time within one
   * call always stops without claiming again: `workerExecuted` is the one
   * flag that bounds this to at most one Terra worker execution attempt.
   */
  async function advance(
    job: JobDocument,
    enqueued: boolean,
    workerExecuted: boolean,
  ): Promise<FrontendBackendLifecycleResult> {
    switch (job.state) {
      case 'draft':
        // A fresh enqueue from this coordinator never sets `draft: true`, so
        // reaching this means a *pre-existing* job was created that way by
        // something else. Releasing it is policy/control-plane authority
        // this lifecycle does not hold — stop, do not release.
        return { outcome: 'draft', jobId: job._id, state: job.state, enqueued, workerExecuted };

      case 'blocked':
        // Blocking is policy/control-plane authority too; never auto-released here.
        return { outcome: 'blocked', jobId: job._id, state: job.state, enqueued, workerExecuted };

      case 'failed':
        // Exhausted retries (or equivalent existing terminal failure). No
        // reset, no replacement job — repair semantics are later work.
        return { outcome: 'failed', jobId: job._id, state: job.state, enqueued, workerExecuted };

      case 'repair_requested':
        // No repair-tier handler is wired in this phase. Stop.
        return { outcome: 'repair_requested', jobId: job._id, state: job.state, enqueued, workerExecuted };

      case 'running':
        // Someone already holds this job's lease — steal nothing, run
        // nothing a second time, mutate nothing.
        return { outcome: 'in_progress', jobId: job._id, state: job.state, enqueued, workerExecuted };

      case 'ready': {
        if (workerExecuted) {
          // This invocation already ran one Terra attempt; existing
          // JobEngine retry semantics put the job back to `ready`. The only
          // permitted loop is deterministic state progression *after* one
          // worker attempt — never a second attempt in the same call.
          return { outcome: 'retry_ready', jobId: job._id, state: job.state, enqueued, workerExecuted };
        }

        // Exact-job scoped: this call may only ever execute *this* job, not
        // whichever ready frontend_backend job happens to be oldest.
        const result = await runner.runOnce({ jobId: job._id });
        const fresh = await readJob(job._id);

        if (result.kind === 'idle') {
          if (fresh.state === 'ready') {
            // Still ready, still unclaimed by us: an existing claim rule —
            // an unmet dependency, an output conflict with something
            // running — genuinely refused it. Not a race; report it.
            return { outcome: 'not_claimable', jobId: job._id, state: fresh.state, enqueued, workerExecuted: false };
          }
          // A concurrent caller claimed (or otherwise advanced) it between
          // our read and this attempt. Follow the durable state; no worker
          // execution happened in *this* call.
          return advance(fresh, enqueued, false);
        }

        // A worker attempt genuinely executed — submitted, handler_failed,
        // or authority_lost all count. Bounded to exactly one from here on.
        return advance(fresh, enqueued, true);
      }

      case 'validating': {
        // Reruns fresh every time, including after a process restart: 5g-1
        // evidence is process-local and never persisted (§26), so a
        // `validating` job found on a brand-new coordinator instance simply
        // gets validated again, from durable state alone.
        const validation = await validate(job);

        if (!validation.ok) {
          // Stop. Do not accept, promote, request repair, fail the job, or
          // route it anywhere else — the job stays exactly `validating`,
          // precisely as 5g-1 itself leaves it.
          return {
            outcome: 'validation_failed',
            jobId: job._id,
            attempt: job.attempt,
            report: { compiled: validation.compiled, gateRun: validation.gateRun },
            enqueued,
            workerExecuted,
          };
        }

        // The exact object 5g-1 just returned, passed directly — no clone,
        // no serialization boundary, no reconstruction. 5g-2's provenance is
        // process-local and object-identity authenticated; anything else
        // makes it reject this as inauthentic (see AcceptanceEvidenceNotAuthentic).
        await acceptValidatedFrontendBackendCandidate(validation, {
          store: deps.store,
          registry: deps.registry,
          engine: deps.engine,
        });

        const fresh = await readJob(job._id);
        return advance(fresh, enqueued, workerExecuted);
      }

      case 'accepted': {
        // 5h alone, exactly as it already is: exact accepted candidate,
        // deterministic receipt, base-HEAD fencing, marker recovery, dirty-
        // worktree protection, idempotent replay. No lifecycle-specific
        // Git path, no re-validation, no re-acceptance.
        const promotion = await promoteAcceptedFrontendBackendCandidate(job._id, {
          store: deps.store,
          registry: deps.registry,
          workspacesRoot: deps.workspacesRoot,
        });
        return {
          outcome: 'promoted',
          jobId: promotion.jobId,
          attempt: promotion.attempt,
          candidate: promotion.candidate,
          promotionId: promotion.promotionId,
          commitSha: promotion.commitSha,
          enqueued,
          workerExecuted,
        };
      }

      default: {
        const exhaustive: never = job.state;
        throw new Error(`frontend_backend lifecycle: unhandled job state "${exhaustive as string}"`);
      }
    }
  }

  return {
    async run(spec: JobSpec): Promise<FrontendBackendLifecycleResult> {
      if (spec.role !== ROLE) throw new FrontendBackendLifecycleRoleMismatch(spec.role);
      requirePinnedInput(spec, FRONTEND_BACKEND_INPUT.businessProfile);
      requirePinnedInput(spec, FRONTEND_BACKEND_INPUT.sitePlan);

      const { job, enqueued } = await ensureJob(spec);
      return advance(job, enqueued, false);
    },
  };
}
