/**
 * Job engine (v1.2 §4).
 *
 * Owns the job lifecycle: enqueue, claim, transition, retry, reclaim. Every
 * state change is a guarded update — the filter always includes the state the
 * caller believes the job is in, so two workers racing on one job cannot both
 * win, and a stale view of the world cannot advance a job it no longer owns.
 */
import type { ClientSession } from 'mongodb';
import {
  assertTransition,
  outputsConflict,
  rolesForTier,
  type AgentTier,
  type ArtifactRef,
  type JobOrigin,
  type JobPromotionFence,
  type JobSpec,
  type JobState,
  type WorkerRole,
} from '@statxai/contracts';
import type { AuditEvent, JobDocument, StateStore } from '@statxai/state';

export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export class JobNotFound extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} not found`);
    this.name = 'JobNotFound';
  }
}

/**
 * Raised when a running job is mutated by someone who does not currently own it.
 *
 * Distinct from {@link JobStateConflict} on purpose. "The job moved on" and
 * "you lost it" are different facts, and a worker that has been superseded
 * needs to know which one happened: the first may be retryable, the second
 * means another worker is already doing the work and this one must stop.
 */
export class JobLeaseConflict extends Error {
  constructor(
    readonly jobId: string,
    readonly workerId: string,
    /** Who holds it now, if anyone. Null when the lease was cleared. */
    readonly heldBy: string | null,
  ) {
    super(
      `Job ${jobId} is not leased to ${workerId}` +
        (heldBy === null ? ' (no current lease)' : ` (held by ${heldBy})`),
    );
    this.name = 'JobLeaseConflict';
  }
}

/**
 * Whether a worker may advance a running job right now.
 *
 * All three conditions are required, and none of them is a worker's own
 * assertion: a worker id is a claim, a past lease is history, and a lease that
 * expired a millisecond ago is not authority. The document decides.
 *
 * Expiry is exclusive — `expiresAt > now` — so a lease expiring exactly now is
 * already gone. `reclaimExpiredLeases` uses `<= now` for the same reason: any
 * other pairing leaves an instant where a lease is too dead to use and too
 * alive to reclaim.
 */
export function hasActiveLease(job: JobDocument, workerId: string, now: Date): boolean {
  return (
    job.state === 'running' &&
    job.lease?.holder === workerId &&
    job.lease.expiresAt.getTime() > now.getTime()
  );
}

/** Raised when a job is not in the state the caller expected. */
export class JobStateConflict extends Error {
  constructor(
    readonly jobId: string,
    readonly expected: readonly JobState[],
  ) {
    super(`Job ${jobId} is not in expected state(s) ${expected.join('|')}`);
    this.name = 'JobStateConflict';
  }
}

/**
 * Raised when a running job is mutated by the worker that currently holds the
 * lease — but for an execution generation ("attempt") that is no longer the
 * job's own (Phase 5f).
 *
 * Distinct from {@link JobLeaseConflict} on purpose: that error means someone
 * *else* holds the job. This means the *same* workerId holds it again, on a
 * later attempt — the job expired and was reclaimed, and this fixed-identity
 * worker (a `JobRunner` always claims under one unchanging `workerId`) simply
 * claimed its own job back. `lease.holder` alone cannot see that; `attempt` is
 * what distinguishes the stale execution from the current one.
 */
export class JobAttemptConflict extends Error {
  constructor(
    readonly jobId: string,
    readonly workerId: string,
    readonly attempt: number,
    readonly currentAttempt: number,
  ) {
    super(
      `Job ${jobId} attempt ${attempt} is stale for worker ${workerId}; the job is now on attempt ${currentAttempt}`,
    );
    this.name = 'JobAttemptConflict';
  }
}

/**
 * Raised by the guarded form of `accept` (Phase 5g-2) when a `validating`
 * job's current `attempt` or `executionOutputs` no longer match what the
 * caller has evidence for — the job moved on to a later execution, or its
 * staged output changed, since whoever is accepting last knew about it.
 *
 * Distinct from {@link JobAttemptConflict} on purpose: that error belongs to
 * the *running*-job authority domain (a worker's lease generation).
 * `validating` has no lease to fence — this is a different fact, about
 * whether accepted evidence still describes the job's current state at all.
 */
export class JobAcceptanceBindingConflict extends Error {
  constructor(
    readonly jobId: string,
    readonly reason: 'attempt' | 'outputs',
  ) {
    super(`Job ${jobId}: current ${reason} no longer matches what this acceptance expected`);
    this.name = 'JobAcceptanceBindingConflict';
  }
}

/**
 * Raised when `accept`'s guard options are supplied inconsistently — one of
 * `expectedAttempt`/`expectedOutputs` given without the other. Together they
 * identify one execution's binding; neither means anything alone, so a
 * caller supplying only one is almost certainly a mistake, not a looser
 * guard, and is rejected before anything is read or written.
 */
export class InvalidAcceptanceBinding extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAcceptanceBinding';
  }
}

function sameOutputs(current: readonly ArtifactRef[] | null, expected: readonly ArtifactRef[]): boolean {
  if (current === null || current.length !== expected.length) return false;
  return current.every((ref, i) => {
    const other = expected[i]!;
    return ref.name === other.name && ref.version === other.version && ref.contentHash === other.contentHash;
  });
}

/** Exact `ArtifactRef` field equality — never object identity. Reused by `acquirePromotionFence` for the one-ref (not array) comparisons a fence needs. */
function sameRef(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.name === b.name && a.version === b.version && a.contentHash === b.contentHash;
}

function sameFence(a: JobPromotionFence, b: { promotionId: string; attempt: number; candidate: ArtifactRef; baseCommit: string | null }): boolean {
  return a.promotionId === b.promotionId && a.attempt === b.attempt && a.baseCommit === b.baseCommit && sameRef(a.candidate, b.candidate);
}

/**
 * Raised when `claim()` is asked to narrow to a role set that is not a
 * non-empty subset of what the supplied tier may execute (Phase 5d).
 *
 * `ROLE_TIER` / `rolesForTier` stay the ceiling on authority; a caller may
 * only ask `claim` for less of it than the tier already grants, never more.
 * This is checked before the claim transaction opens, so an invalid request
 * mutates nothing.
 */
export class InvalidClaimRoles extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidClaimRoles';
  }
}

/**
 * `supersede()` was called with an empty (or whitespace-only) reason.
 *
 * Superseding a job is a permanent, harness-owned revocation with no
 * automatic trigger (Phase 5m) — the audit trail is the only record of why
 * a specific execution was abandoned, and an empty reason would leave that
 * question unanswerable to anyone reading the trail later.
 */
export class InvalidSupersessionReason extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSupersessionReason';
  }
}

/**
 * `acquirePromotionFence` was asked for a fence whose `attempt` or
 * `candidate` does not match what the authoritative `accepted` job
 * currently carries (Phase 5n). Never overwritten with the caller's
 * version — the job's own durable state is authority, not what a caller
 * believes it accepted.
 */
export class PromotionFenceBindingConflict extends Error {
  constructor(
    readonly jobId: string,
    readonly reason: 'attempt' | 'candidate',
  ) {
    super(`job ${jobId}: current ${reason} no longer matches what this promotion fence acquisition expected`);
    this.name = 'PromotionFenceBindingConflict';
  }
}

/**
 * A `promotionFence` already exists on this job, but for a *different*
 * promotion authority — a different `promotionId`, `attempt`, `candidate`,
 * or `baseCommit` — than the one just requested. Never overwritten: once
 * acquired, a fence is permanent evidence that may already describe
 * canonical filesystem/Git mutation that has happened.
 */
export class PromotionFenceConflict extends Error {
  constructor(
    readonly jobId: string,
    readonly existingPromotionId: string,
    readonly requestedPromotionId: string,
  ) {
    super(
      `job ${jobId} already owns promotion fence "${existingPromotionId}"; refusing to acquire a different one ` +
        `("${requestedPromotionId}")`,
    );
    this.name = 'PromotionFenceConflict';
  }
}

/**
 * `supersedeAcceptedBeforePromotion` found the job still `accepted` but
 * already owning a `promotionFence` — promotion has already obtained
 * authority over it, so abandonment loses and must not touch the job.
 * Distinct from {@link JobStateConflict}: the state guard (`accepted`) is
 * satisfied here, and this is specifically the fence guard losing instead.
 */
export class PromotionFenceOwned extends Error {
  constructor(
    readonly jobId: string,
    readonly promotionId: string,
  ) {
    super(`job ${jobId}: promotion fence "${promotionId}" already owns this accepted job; refusing to supersede it`);
    this.name = 'PromotionFenceOwned';
  }
}

export interface EnqueueParams {
  spec: JobSpec;
  origin: JobOrigin;
  dependsOn?: string[];
  maxAttempts?: number;
  /** Jobs start `ready` unless held back as `draft` for a plan under assembly. */
  draft?: boolean;
}

export class JobEngine {
  constructor(private readonly store: StateStore) {}

  async enqueue(params: EnqueueParams): Promise<JobDocument> {
    const now = new Date();
    const doc: JobDocument = {
      _id: params.spec.jobId,
      projectId: params.spec.projectId,
      role: params.spec.role,
      spec: params.spec,
      state: params.draft ? 'draft' : 'ready',
      origin: params.origin,
      dependsOn: params.dependsOn ?? [],
      attempt: 0,
      maxAttempts: params.maxAttempts ?? 3,
      lease: null,
      failure: null,
      executionOutputs: null,
      promotionFence: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.jobs.insertOne(doc);
    return doc;
  }

  /**
   * Claim one runnable job of the caller's tier, or return null.
   *
   * Eligibility is not expressible as a single-document filter, because two of
   * the four conditions are cross-document:
   *
   *   1. the job is `ready`                          — single document
   *   2. the job's role is in the resolved claim set — single document
   *   3. every dependency has been accepted          — other job documents
   *   4. no running job writes an overlapping path   — other job documents
   *
   * So the whole selection runs inside a transaction. Snapshot isolation gives
   * a consistent view of (3) and (4), and the final guarded update makes the
   * claim itself atomic: if another worker took the job first, the update
   * matches nothing and the transaction aborts and retries.
   *
   * Condition (2) is what makes claiming role-aware: `tier` is what the caller
   * *is* (which model stands behind it), not a preference, so it narrows the
   * candidate set rather than being checked afterward — a Luna worker cannot
   * see a Terra job to race for it in the first place. This is what has to be
   * true before real Terra and Luna workers can share the same queue; a repair
   * job left open to any tier would let a Terra worker execute a Luna-priced
   * repair, or Luna hold a judgment seat §7 reserves for Terra's reviewer.
   *
   * `options.roles`, when given, narrows further still (Phase 5d): a
   * specialised worker — one built to run only `frontend_backend`, say —
   * passes the single role it actually has code for, and the resolved set is
   * that role alone rather than everything Terra may claim. `tier` remains
   * the ceiling: every requested role must already belong to
   * `rolesForTier(tier)`, checked and thrown on (`InvalidClaimRoles`, before
   * the transaction opens) rather than silently clamped, and an empty request
   * is rejected the same way — "narrow to nothing" is a configuration error,
   * not a valid way to claim nothing. Omitting `roles` entirely preserves the
   * original behaviour: the caller may claim anything its tier can.
   *
   * Condition (4) is what keeps parallel workers from corrupting a single
   * project repository. §2 promises parallel execution and §1 gives each
   * project one Git repo; the declared `output` list is what reconciles them.
   *
   * `options.jobId`, when given (Phase 5i), narrows condition (1) to that
   * exact job — a caller driving one specific `JobSpec` needs "claim this
   * job or nothing," never "claim whatever is oldest and ready." Every other
   * condition still applies unchanged: a job outside the resolved role set,
   * with an unmet dependency, or output-conflicted with something already
   * running is still not claimed, exact match or not. Omitted, behaviour is
   * exactly what it always has been — the oldest eligible `ready` job.
   */
  async claim(
    workerId: string,
    tier: AgentTier,
    options: { projectId?: string; leaseMs?: number; now?: Date; roles?: readonly WorkerRole[]; jobId?: string } = {},
  ): Promise<JobDocument | null> {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const roles = this.resolveClaimRoles(tier, options.roles);

    return this.store.withTransaction(async (session) => {
      const scope = options.projectId ? { projectId: options.projectId } : {};
      const exact = options.jobId !== undefined ? { _id: options.jobId } : {};

      const candidates = await this.store.jobs
        .find({ ...scope, ...exact, state: 'ready', role: { $in: roles } }, { session, sort: { createdAt: 1 } })
        .toArray();
      if (candidates.length === 0) return null;

      const running = await this.store.jobs.find({ ...scope, state: 'running' }, { session }).toArray();

      for (const candidate of candidates) {
        if (!(await this.dependenciesSatisfied(candidate, session))) continue;

        const conflicts = running.some(
          (other) => other.projectId === candidate.projectId && outputsConflict(candidate.spec, other.spec),
        );
        if (conflicts) continue;

        const now = options.now ?? new Date();
        const claimed = await this.store.jobs.findOneAndUpdate(
          { _id: candidate._id, state: 'ready' },
          {
            $set: {
              state: 'running',
              lease: { holder: workerId, expiresAt: new Date(now.getTime() + leaseMs) },
              updatedAt: now,
            },
            $inc: { attempt: 1 },
          },
          { session, returnDocument: 'after' },
        );
        if (!claimed) continue;

        await this.audit(session, {
          projectId: claimed.projectId,
          jobId: claimed._id,
          kind: 'job_transition',
          actor: workerId,
          detail: { from: 'ready', to: 'running', attempt: claimed.attempt },
          at: now,
        });
        return claimed;
      }

      return null;
    });
  }

  /**
   * `tier` sets the ceiling (5b); `requested`, when given, narrows within it
   * (5d). Duplicates in `requested` are canonicalised rather than rejected —
   * a repeated role is redundant configuration, not a conflicting one.
   */
  private resolveClaimRoles(tier: AgentTier, requested: readonly WorkerRole[] | undefined): WorkerRole[] {
    const tierRoles = rolesForTier(tier);
    if (requested === undefined) return tierRoles;

    if (requested.length === 0) {
      throw new InvalidClaimRoles('claim() roles, when given, must be non-empty');
    }
    const outsideTier = requested.filter((role) => !tierRoles.includes(role));
    if (outsideTier.length > 0) {
      throw new InvalidClaimRoles(
        `claim() requested role(s) outside tier "${tier}"'s authority: ${outsideTier.join(', ')}`,
      );
    }
    return [...new Set(requested)];
  }

  private async dependenciesSatisfied(job: JobDocument, session: ClientSession): Promise<boolean> {
    if (job.dependsOn.length === 0) return true;
    const accepted = await this.store.jobs.countDocuments(
      { _id: { $in: job.dependsOn }, state: 'accepted' },
      { session },
    );
    return accepted === job.dependsOn.length;
  }

  /**
   * Work finished; hand off to validation — and, in the same guarded
   * transition, attach exactly what that execution produced.
   *
   * Only the current lease holder, on its own claimed `attempt`, may do this
   * (Phase 5a's lease check, Phase 5f's attempt check). A worker whose lease
   * lapsed while it was busy — or the same workerId, now on a later attempt
   * of its own job — has had this job handed to someone else, and submitting
   * anyway would credit it with execution it did not perform, or worse,
   * attach its stale output as if it were the current attempt's.
   *
   * `options.outputs`, when given, is written by the *same* `$set` that
   * changes `state` and clears `lease` — one atomic mutation, not a write
   * followed by a transition. A stale attempt that loses this race attaches
   * nothing: the guarded filter matches no document, so neither the state
   * change nor the output write ever happens. Omitting `outputs` leaves
   * `executionOutputs` untouched (`null` from `enqueue`), so a handler that
   * returns nothing stays valid.
   */
  async submitForValidation(
    jobId: string,
    workerId: string,
    attempt: number,
    options: { now?: Date; outputs?: readonly ArtifactRef[] } = {},
  ): Promise<JobDocument> {
    const extra: Record<string, unknown> = { lease: null };
    if (options.outputs !== undefined) extra.executionOutputs = options.outputs;
    return this.transitionOwnedRunning(jobId, workerId, attempt, 'validating', extra, options.now);
  }

  /**
   * Validation passed. Terminal.
   *
   * `options.expectedAttempt`/`options.expectedOutputs`, when both given
   * (Phase 5g-2), additionally guard the transition on the job's *current*
   * `attempt` and `executionOutputs` still matching exactly — proven by a
   * read inside the same transaction this method performs, not merely
   * checked beforehand and trusted. Omitted, `accept` behaves exactly as it
   * always has: any `validating` job is accepted by state alone. Supplying
   * only one of the pair is rejected outright, before anything is read or
   * written — see {@link InvalidAcceptanceBinding}.
   *
   * `options.session`, when supplied, is used directly and no transaction is
   * opened here — the caller already owns one, typically because it must
   * also accept a candidate artifact this same acceptance is for,
   * atomically, in the one Mongo transaction. Omitted, this opens its own,
   * exactly like every other guarded method in this file.
   */
  async accept(
    jobId: string,
    actor: string,
    options: {
      expectedAttempt?: number;
      expectedOutputs?: readonly ArtifactRef[];
      session?: ClientSession;
    } = {},
  ): Promise<JobDocument> {
    if ((options.expectedAttempt === undefined) !== (options.expectedOutputs === undefined)) {
      throw new InvalidAcceptanceBinding(
        'JobEngine.accept: expectedAttempt and expectedOutputs must be supplied together, or not at all',
      );
    }
    if (options.expectedAttempt !== undefined) {
      return this.acceptGuarded(jobId, actor, options.expectedAttempt, options.expectedOutputs!, options.session);
    }
    return this.transition(jobId, ['validating'], 'accepted', actor, { lease: null }, options.session);
  }

  /**
   * The guarded half of {@link accept}. Reads the job first — inside the
   * same transaction/session the write below uses — so a stale `attempt` or
   * `executionOutputs` is caught by comparing values in code, not by trying
   * to express array/document equality inside a Mongo filter (BSON compares
   * embedded documents field-by-field in stored order, which this repo's own
   * `ArtifactRef` objects have never needed to promise). Snapshot isolation
   * inside one transaction is what keeps this safe: a concurrent write from
   * *outside* it either lands before this transaction starts (so this read
   * already sees it) or conflicts with it at commit time (so the write below
   * fails and the whole transaction aborts) — never silently in between.
   */
  private async acceptGuarded(
    jobId: string,
    actor: string,
    expectedAttempt: number,
    expectedOutputs: readonly ArtifactRef[],
    session?: ClientSession,
  ): Promise<JobDocument> {
    assertTransition('validating', 'accepted');

    const run = async (session: ClientSession): Promise<JobDocument> => {
      const now = new Date();

      const current = await this.store.jobs.findOne({ _id: jobId }, { session });
      if (!current) throw new JobNotFound(jobId);
      if (current.state !== 'validating') throw new JobStateConflict(jobId, ['validating']);
      if (current.attempt !== expectedAttempt) throw new JobAcceptanceBindingConflict(jobId, 'attempt');
      if (!sameOutputs(current.executionOutputs, expectedOutputs)) {
        throw new JobAcceptanceBindingConflict(jobId, 'outputs');
      }

      const updated = await this.store.jobs.findOneAndUpdate(
        { _id: jobId, state: 'validating', attempt: expectedAttempt },
        { $set: { state: 'accepted', updatedAt: now, lease: null } },
        { session, returnDocument: 'after' },
      );

      if (!updated) {
        // Something changed between the read above and this write, inside
        // the same transaction — a concurrent transaction elsewhere must
        // have committed first. Reclassified from what is actually there
        // now, the same idiom every other guarded transition in this file
        // uses on a failed match.
        const exists = await this.store.jobs.findOne({ _id: jobId }, { session });
        if (!exists) throw new JobNotFound(jobId);
        if (exists.state !== 'validating') throw new JobStateConflict(jobId, ['validating']);
        throw new JobAcceptanceBindingConflict(jobId, 'attempt');
      }

      await this.audit(session, {
        projectId: updated.projectId,
        jobId,
        kind: 'job_transition',
        actor,
        detail: { to: 'accepted', attempt: updated.attempt },
        at: now,
      });
      return updated;
    };

    if (session) return run(session);
    return this.store.withTransaction(run);
  }

  /** Validation failed with a defect that warrants a repair job. */
  async requestRepair(jobId: string, actor: string): Promise<JobDocument> {
    return this.transition(jobId, ['validating', 'failed'], 'repair_requested', actor, { lease: null });
  }

  /**
   * Record a failure, returning the job to `ready` while retry attempts remain.
   *
   * Note the ordering: the job always passes through `failed` rather than going
   * straight back to `ready`, so the failure is durably recorded and visible in
   * the audit trail even when the retry immediately succeeds.
   *
   * `attempt` fences the running branch only (Phase 5f) — see the authority
   * note below. It is accepted unconditionally, and simply unused, when the
   * job is actually in `validating`: that branch has no lease to fence in the
   * first place, so there is no generation for it to be stale against.
   */
  async fail(
    jobId: string,
    message: string,
    actor: string,
    attempt: number,
    options: { policyViolation?: boolean; now?: Date } = {},
  ): Promise<JobDocument> {
    const now = options.now ?? new Date();
    const extra = {
      lease: null,
      failure: { message, at: now, policyViolation: options.policyViolation ?? false },
    };

    /**
     * The two failures this method serves have different authority.
     *
     * A running job failing is the executing worker reporting that its own work
     * broke, so it must still hold the job — on the exact attempt it claimed,
     * not merely under its own workerId, since that same worker may since have
     * reclaimed this job as a later attempt. A validating job failing is the
     * harness rejecting finished work — the execution lease was cleared on
     * submission, and requiring one would make validation impossible.
     *
     * Reading the state first is not the guard; the guarded write is. If the
     * job moves between the two, the update filter fails and the error is
     * classified from what is actually there.
     */
    const current = await this.store.jobs.findOne({ _id: jobId });
    if (!current) throw new JobNotFound(jobId);

    const failed =
      current.state === 'running'
        ? await this.transitionOwnedRunning(jobId, actor, attempt, 'failed', extra, now)
        : await this.transition(jobId, ['validating'], 'failed', actor, extra);

    if (failed.attempt >= failed.maxAttempts) return failed;
    return this.transition(jobId, ['failed'], 'ready', actor, {});
  }

  /** Dependency problem; job cannot proceed (§4). */
  async block(jobId: string, actor: string, reason: string): Promise<JobDocument> {
    return this.transition(jobId, ['draft', 'ready', 'failed', 'repair_requested'], 'blocked', actor, {
      lease: null,
      failure: { message: reason, at: new Date(), policyViolation: false },
    });
  }

  /** Release a draft job into the schedulable pool. */
  async release(jobId: string, actor: string): Promise<JobDocument> {
    return this.transition(jobId, ['draft', 'blocked'], 'ready', actor, {});
  }

  /**
   * Permanently revoke a job's pre-acceptance execution authority (Phase
   * 5m). Harness-owned, explicit-only — nothing in this file ever calls it:
   * there is no automatic supersession for a timeout, a lease expiry, a
   * `retry_ready`, or a `validation_failed`. A caller (Phase 5m's own
   * `abandonFrontendBackendBuild`) decides when to invoke this; `JobEngine`
   * itself holds no opinion about when a job should be abandoned.
   *
   * Legal from every pre-acceptance state — `draft`, `ready`, `running`,
   * `validating`, `failed`, `repair_requested`, `blocked` — and from
   * nowhere else: `accepted` is deliberately excluded from the guarded
   * filter below, so an attempt against an already-accepted job matches
   * nothing and fails closed with {@link JobStateConflict} naming the
   * legal source states, exactly like every other guarded transition here
   * that a caller aims at the wrong state. No special-cased "is it
   * accepted?" check exists in this method for that reason — the guard
   * *is* the check.
   *
   * A `running` job's lease is cleared unconditionally, regardless of who
   * currently holds it or whether it has expired — this is harness
   * authority overriding a worker's claim, not a worker relinquishing its
   * own. Once this transaction commits, the stale worker's own lease-bound
   * calls (`heartbeat`, `submitForValidation`, `fail`) all guard on
   * `state: 'running'`, which no longer matches, so none of them can
   * advance the job again — see `hasActiveLease`/`transitionOwnedRunning`.
   * A worker may still produce immutable staged bytes after losing
   * authority; those stay orphaned, unaccepted and noncanonical, which is
   * acceptable and never cleaned up here (Phase 5m's own scope boundary).
   *
   * `superseded` is terminal (`TRANSITIONS.superseded === []`) and is
   * deliberately excluded from `TERMINAL_JOB_STATES`: that array means
   * *successful* completion, and a dependency on a superseded job must
   * never become satisfied merely because it can no longer progress — see
   * `TERMINAL_JOB_STATES`'s own doc comment.
   *
   * `reason` is required and may not be empty/whitespace-only — the audit
   * trail this produces is the only durable record of why a specific
   * execution was permanently revoked. `bindingId`, when given, is carried
   * into the audit detail alongside it purely as evidence linking this
   * supersession to the Phase 5k build binding that caused it — this
   * method has no idea what a "build binding" is and reads nothing from
   * one.
   *
   * `options.session`, when supplied, is used directly and no transaction
   * is opened here — the caller already owns one, typically because it
   * must also transition a `FrontendBackendBuildBindingDocument`
   * `prepared -> abandoned` atomically with this. Omitted, this opens its
   * own transaction, exactly like every other guarded method in this file.
   */
  async supersede(
    jobId: string,
    actor: string,
    options: { reason: string; bindingId?: string; now?: Date; session?: ClientSession },
  ): Promise<JobDocument> {
    if (options.reason.trim() === '') {
      throw new InvalidSupersessionReason('JobEngine.supersede: reason must not be empty');
    }
    return this.transition(
      jobId,
      ['draft', 'ready', 'running', 'validating', 'failed', 'repair_requested', 'blocked'],
      'superseded',
      actor,
      { lease: null },
      options.session,
      options.now,
      { reason: options.reason, ...(options.bindingId !== undefined ? { bindingId: options.bindingId } : {}) },
    );
  }

  /**
   * Durably acquire promotion-ownership authority over one `accepted` job
   * (Phase 5n) — the fence that serialises canonical promotion (Phase 5h)
   * against accepted-state abandonment (Phase 5m's
   * `supersedeAcceptedBeforePromotion`, below). Once this returns
   * successfully, the job's `promotionFence` durably names exactly this
   * `(promotionId, attempt, candidate, baseCommit)`, and nothing in this
   * file will ever clear, expire, or overwrite it — there is deliberately
   * no `releasePromotionFence`. See `JobPromotionFence`'s own doc comment
   * (`@statxai/contracts`) for why: canonical filesystem/Git mutation may
   * already have happened by the time anything reads this again, so
   * nothing may ever "reclaim" it the way a worker lease can.
   *
   * Legal only from `state: 'accepted'` — the guarded filter below simply
   * never matches any other state, so a caller that races this against,
   * say, a stale `validating` read fails closed with {@link JobStateConflict}
   * the same way every other guarded method here does.
   *
   * Three outcomes:
   *
   *   1. **No fence yet**, and `attempt`/`candidate` match the job's own
   *      current durable state (checked by reading fresh, inside the same
   *      transaction, before the guarded write — the same "read then
   *      guard" idiom {@link acceptGuarded} already uses): the fence is
   *      written, once, and returned.
   *   2. **The exact same fence already exists** (`promotionId`, `attempt`,
   *      `candidate`, `baseCommit` all agree): idempotent replay — the
   *      existing job is returned as-is, no second write, no duplicate
   *      audit entry. This is what makes calling this on every single
   *      promotion attempt safe, including pure replays of an
   *      already-`committed` historical promotion.
   *   3. **A *different* fence already exists**, or `attempt`/`candidate`
   *      disagree with the job's own current state: fails closed —
   *      {@link PromotionFenceConflict} or {@link PromotionFenceBindingConflict}
   *      respectively. Never overwritten.
   *
   * `baseCommit` is accepted as given, not re-derived here — the caller
   * (Phase 5h) is the one with canonical workspace access; this method
   * only persists whatever it is told as part of the fence's own
   * permanent identity.
   *
   * `options.session`, when supplied, participates in the caller's own
   * transaction — no second one opened. Phase 5h calls this with no
   * session (its own top-level operation); a legacy-receipt backfill or a
   * future caller sharing a transaction may supply one.
   */
  async acquirePromotionFence(
    jobId: string,
    options: {
      promotionId: string;
      attempt: number;
      candidate: ArtifactRef;
      baseCommit: string | null;
      actor: string;
      now?: Date;
      session?: ClientSession;
    },
  ): Promise<JobDocument> {
    const run = async (session: ClientSession): Promise<JobDocument> => {
      const now = options.now ?? new Date();
      const current = await this.store.jobs.findOne({ _id: jobId }, { session });
      if (!current) throw new JobNotFound(jobId);
      if (current.state !== 'accepted') throw new JobStateConflict(jobId, ['accepted']);

      const existingFence = current.promotionFence ?? null;
      if (existingFence) {
        if (sameFence(existingFence, options)) return current;
        throw new PromotionFenceConflict(jobId, existingFence.promotionId, options.promotionId);
      }

      if (current.attempt !== options.attempt) throw new PromotionFenceBindingConflict(jobId, 'attempt');
      if (!sameOutputs(current.executionOutputs, [options.candidate])) {
        throw new PromotionFenceBindingConflict(jobId, 'candidate');
      }

      const fence: JobPromotionFence = {
        promotionId: options.promotionId,
        attempt: options.attempt,
        candidate: options.candidate,
        baseCommit: options.baseCommit,
        acquiredAt: now,
      };

      const updated = await this.store.jobs.findOneAndUpdate(
        // `promotionFence: null` matches both an explicit `null` and a
        // missing key (Mongo's own query semantics) — exactly the "no
        // fence acquired" meaning `JobPromotionFence`'s own doc comment
        // documents, with no special-casing needed here for either shape.
        { _id: jobId, state: 'accepted', attempt: options.attempt, promotionFence: null },
        { $set: { promotionFence: fence, updatedAt: now } },
        { session, returnDocument: 'after' },
      );

      if (!updated) {
        // Raced inside this same transaction attempt: re-read and
        // classify from what is actually there, rather than trust the
        // read above.
        const exists = await this.store.jobs.findOne({ _id: jobId }, { session });
        if (!exists) throw new JobNotFound(jobId);
        if (exists.state !== 'accepted') throw new JobStateConflict(jobId, ['accepted']);
        const raceFence = exists.promotionFence ?? null;
        if (raceFence) {
          if (sameFence(raceFence, options)) return exists;
          throw new PromotionFenceConflict(jobId, raceFence.promotionId, options.promotionId);
        }
        // Fence still absent, state still accepted, yet the guarded write
        // did not match: the job's `attempt` moved between the read above
        // and this write.
        throw new PromotionFenceBindingConflict(jobId, 'attempt');
      }

      await this.audit(session, {
        projectId: updated.projectId,
        jobId,
        kind: 'job_transition',
        actor: options.actor,
        detail: { event: 'promotion_fence_acquired', promotionId: options.promotionId, attempt: options.attempt, baseCommit: options.baseCommit },
        at: now,
      });

      return updated;
    };

    if (options.session) return run(options.session);
    return this.store.withTransaction(run);
  }

  /**
   * The one narrow edge `accepted -> superseded` is legal through (Phase
   * 5n) — deliberately not folded into the generic {@link supersede},
   * which stays exactly what Phase 5m left it: pre-acceptance only, by the
   * simple absence of `'accepted'` from its own guarded `from` list.
   *
   * Requires, atomically, in one guarded filter: `state: 'accepted'` *and*
   * `promotionFence: null` (matching both a real `null` and a missing
   * key). An accepted job that already owns a fence fails closed with
   * {@link PromotionFenceOwned} — promotion already holds authority, and
   * this never clears or overwrites that fence to make room for itself.
   *
   * Everything else mirrors {@link supersede} exactly: `reason` required
   * and non-empty, `bindingId` carried into the same audit detail shape,
   * `options.session` used directly when supplied so this can commit
   * atomically alongside a `FrontendBackendBuildBindingDocument`
   * `prepared -> abandoned` transition.
   */
  async supersedeAcceptedBeforePromotion(
    jobId: string,
    actor: string,
    options: { reason: string; bindingId?: string; now?: Date; session?: ClientSession },
  ): Promise<JobDocument> {
    if (options.reason.trim() === '') {
      throw new InvalidSupersessionReason('JobEngine.supersedeAcceptedBeforePromotion: reason must not be empty');
    }
    assertTransition('accepted', 'superseded');

    const run = async (session: ClientSession): Promise<JobDocument> => {
      const now = options.now ?? new Date();
      const updated = await this.store.jobs.findOneAndUpdate(
        { _id: jobId, state: 'accepted', promotionFence: null },
        { $set: { state: 'superseded', updatedAt: now } },
        { session, returnDocument: 'after' },
      );

      if (!updated) {
        const exists = await this.store.jobs.findOne({ _id: jobId }, { session });
        if (!exists) throw new JobNotFound(jobId);
        if (exists.state !== 'accepted') throw new JobStateConflict(jobId, ['accepted']);
        // State is accepted, so the fence guard is what lost.
        throw new PromotionFenceOwned(jobId, exists.promotionFence!.promotionId);
      }

      await this.audit(session, {
        projectId: updated.projectId,
        jobId,
        kind: 'job_transition',
        actor,
        detail: { to: 'superseded', attempt: updated.attempt, reason: options.reason, ...(options.bindingId !== undefined ? { bindingId: options.bindingId } : {}) },
        at: now,
      });

      return updated;
    };

    if (options.session) return run(options.session);
    return this.store.withTransaction(run);
  }

  /**
   * Return jobs whose lease has expired to the `ready` pool.
   *
   * Without this a crashed worker strands its job in `running` forever: nothing
   * else can claim it, and its outputs keep blocking every conflicting job.
   */
  async reclaimExpiredLeases(now: Date = new Date()): Promise<number> {
    const expired = await this.store.jobs
      .find({ state: 'running', 'lease.expiresAt': { $lte: now } })
      .toArray();

    let reclaimed = 0;
    for (const job of expired) {
      const result = await this.store.withTransaction(async (session) => {
        const updated = await this.store.jobs.findOneAndUpdate(
          { _id: job._id, state: 'running', 'lease.expiresAt': { $lte: now } },
          { $set: { state: 'ready', lease: null, updatedAt: now } },
          { session, returnDocument: 'after' },
        );
        if (!updated) return false;
        await this.audit(session, {
          projectId: job.projectId,
          jobId: job._id,
          kind: 'job_transition',
          actor: 'system:lease-reaper',
          detail: { from: 'running', to: 'ready', reason: 'lease_expired', heldBy: job.lease?.holder ?? null },
          at: now,
        });
        return true;
      });
      if (result) reclaimed++;
    }
    return reclaimed;
  }

  /**
   * Reclaim one exact job whose execution lease has expired — the job a caller
   * already owns by durable authority, never any job that happens to be stale.
   *
   * Only a `running` job whose lease has actually expired (`expiresAt <= now`,
   * the exact complement of `hasActiveLease`) on its current attempt is touched.
   * With attempts remaining it returns to `ready`, and the next claim is a new
   * attempt — so every token the dead execution held (`attempt`, lease) is stale
   * for submit, heartbeat and fail. On its final attempt it is `failed`, because
   * an execution that died is still an attempt spent: reclaiming never grants an
   * extra one. Returns the reclaimed job, or `null` when there was nothing to
   * reclaim (not running, or its lease is still alive).
   */
  async reclaimExpiredJobLease(jobId: string, actor: string, now: Date = new Date()): Promise<JobDocument | null> {
    return this.store.withTransaction(async (session) => {
      const job = await this.store.jobs.findOne({ _id: jobId, state: 'running', 'lease.expiresAt': { $lte: now } }, { session });
      if (!job) return null;
      const exhausted = job.attempt >= job.maxAttempts;
      const updated = await this.store.jobs.findOneAndUpdate(
        { _id: jobId, state: 'running', attempt: job.attempt, 'lease.expiresAt': { $lte: now } },
        {
          $set: exhausted
            ? { state: 'failed', lease: null, failure: { message: 'the execution lease expired on the final attempt', at: now, policyViolation: false }, updatedAt: now }
            : { state: 'ready', lease: null, updatedAt: now },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) return null;
      await this.audit(session, {
        projectId: job.projectId,
        jobId,
        kind: 'job_transition',
        actor,
        detail: { from: 'running', to: updated.state, reason: 'lease_expired', attempt: job.attempt, heldBy: job.lease?.holder ?? null },
        at: now,
      });
      return updated;
    });
  }

  /**
   * Extend a lease that is still alive, on the exact attempt that claimed it.
   *
   * A lease can only be extended from a lease. Without the expiry condition a
   * worker that stalled past its deadline could revive its own claim in the
   * window before the reaper reaches it, which is the one moment another worker
   * is about to be given the job.
   *
   * `attempt` closes the gap `lease.holder` alone leaves (Phase 5f): a
   * `JobRunner` always heartbeats under one fixed `workerId`, so if this same
   * job expires and this same worker claims it back, `lease.holder` matches
   * again on the new attempt — and a heartbeat left over from the old one,
   * arriving late, would otherwise extend a lease it was never granted.
   */
  async heartbeat(
    jobId: string,
    workerId: string,
    attempt: number,
    leaseMs = DEFAULT_LEASE_MS,
    options: { now?: Date } = {},
  ): Promise<boolean> {
    const now = options.now ?? new Date();
    const result = await this.store.jobs.updateOne(
      {
        _id: jobId,
        state: 'running',
        attempt,
        'lease.holder': workerId,
        'lease.expiresAt': { $gt: now },
      },
      { $set: { 'lease.expiresAt': new Date(now.getTime() + leaseMs), updatedAt: now } },
    );
    return result.matchedCount === 1;
  }

  /**
   * Advance a running job on behalf of the exact execution that owns it.
   *
   * The ownership test is in the update filter, not in a check before it.
   * Reading the lease and then writing on state alone would leave a window —
   * short, and exactly long enough for the reaper and a new claim to land
   * between them. `attempt` is part of that same filter (Phase 5f), for the
   * same reason it is on `heartbeat`: `lease.holder` alone cannot tell this
   * worker's current execution apart from an earlier one of its own that the
   * reaper already reclaimed and this same `workerId` has since re-claimed.
   */
  private async transitionOwnedRunning(
    jobId: string,
    workerId: string,
    attempt: number,
    to: JobState,
    extra: Record<string, unknown>,
    at?: Date,
  ): Promise<JobDocument> {
    assertTransition('running', to);

    return this.store.withTransaction(async (session) => {
      const now = at ?? new Date();
      const updated = await this.store.jobs.findOneAndUpdate(
        {
          _id: jobId,
          state: 'running',
          attempt,
          'lease.holder': workerId,
          'lease.expiresAt': { $gt: now },
        },
        { $set: { state: to, updatedAt: now, ...extra } },
        { session, returnDocument: 'after' },
      );

      if (!updated) {
        // Classified from what is actually there, so a caller learns whether it
        // lost the job, the job moved on to someone else, or — same worker,
        // stale generation — it moved on without ever leaving this workerId.
        const exists = await this.store.jobs.findOne({ _id: jobId }, { session });
        if (!exists) throw new JobNotFound(jobId);
        if (exists.state !== 'running') throw new JobStateConflict(jobId, ['running']);
        if (exists.lease?.holder !== workerId) {
          throw new JobLeaseConflict(jobId, workerId, exists.lease?.holder ?? null);
        }
        if (exists.attempt !== attempt) {
          throw new JobAttemptConflict(jobId, workerId, attempt, exists.attempt);
        }
        // Holder and attempt both match; only the lease's expiry could have
        // failed the guard.
        throw new JobLeaseConflict(jobId, workerId, exists.lease?.holder ?? null);
      }

      await this.audit(session, {
        projectId: updated.projectId,
        jobId,
        kind: 'job_transition',
        actor: workerId,
        detail: { to, attempt: updated.attempt },
        at: now,
      });
      return updated;
    });
  }

  /**
   * `session`, when supplied (Phase 5g-2, Phase 5m), is used directly and no
   * transaction is opened here — the caller already owns one. Every caller
   * that omits it gets exactly the original behaviour: its own transaction,
   * opened and committed by this call alone.
   *
   * `now`/`auditDetail` (Phase 5m) are both optional and additive: every
   * pre-5m caller omits them and gets exactly the original behaviour — the
   * current clock, and an audit detail of exactly `{ to, attempt }`.
   * `auditDetail`, when given, is merged in alongside those two rather than
   * replacing them, so a caller (`supersede`) can attach evidence — a
   * reason, a binding id — without this method needing to know what that
   * evidence means.
   */
  private async transition(
    jobId: string,
    from: readonly JobState[],
    to: JobState,
    actor: string,
    extra: Record<string, unknown>,
    session?: ClientSession,
    now?: Date,
    auditDetail?: Record<string, unknown>,
  ): Promise<JobDocument> {
    for (const state of from) assertTransition(state, to);

    const run = async (session: ClientSession): Promise<JobDocument> => {
      const at = now ?? new Date();
      const updated = await this.store.jobs.findOneAndUpdate(
        { _id: jobId, state: { $in: [...from] } },
        { $set: { state: to, updatedAt: at, ...extra } },
        { session, returnDocument: 'after' },
      );

      if (!updated) {
        const exists = await this.store.jobs.findOne({ _id: jobId }, { session });
        if (!exists) throw new JobNotFound(jobId);
        throw new JobStateConflict(jobId, from);
      }

      await this.audit(session, {
        projectId: updated.projectId,
        jobId,
        kind: 'job_transition',
        actor,
        detail: { to, attempt: updated.attempt, ...auditDetail },
        at,
      });
      return updated;
    };

    if (session) return run(session);
    return this.store.withTransaction(run);
  }

  private async audit(session: ClientSession, event: AuditEvent): Promise<void> {
    await this.store.auditLog.insertOne(event, { session });
  }
}
