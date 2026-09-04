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
   */
  async claim(
    workerId: string,
    tier: AgentTier,
    options: { projectId?: string; leaseMs?: number; now?: Date; roles?: readonly WorkerRole[] } = {},
  ): Promise<JobDocument | null> {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const roles = this.resolveClaimRoles(tier, options.roles);

    return this.store.withTransaction(async (session) => {
      const scope = options.projectId ? { projectId: options.projectId } : {};

      const candidates = await this.store.jobs
        .find({ ...scope, state: 'ready', role: { $in: roles } }, { session, sort: { createdAt: 1 } })
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
   * `session`, when supplied (Phase 5g-2), is used directly and no
   * transaction is opened here — the caller already owns one. Every
   * pre-5g-2 caller omits it and gets exactly the original behaviour: its
   * own transaction, opened and committed by this call alone.
   */
  private async transition(
    jobId: string,
    from: readonly JobState[],
    to: JobState,
    actor: string,
    extra: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<JobDocument> {
    for (const state of from) assertTransition(state, to);

    const run = async (session: ClientSession): Promise<JobDocument> => {
      const now = new Date();
      const updated = await this.store.jobs.findOneAndUpdate(
        { _id: jobId, state: { $in: [...from] } },
        { $set: { state: to, updatedAt: now, ...extra } },
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
        detail: { to, attempt: updated.attempt },
        at: now,
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
