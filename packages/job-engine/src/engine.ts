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
   * Work finished; hand off to validation.
   *
   * Only the current lease holder may do this. A worker whose lease lapsed
   * while it was busy has had its job handed to someone else, and submitting
   * anyway would credit it with execution it did not perform — and overwrite a
   * live worker's job while it is still running.
   */
  async submitForValidation(
    jobId: string,
    workerId: string,
    options: { now?: Date } = {},
  ): Promise<JobDocument> {
    return this.transitionOwnedRunning(jobId, workerId, 'validating', { lease: null }, options.now);
  }

  /** Validation passed. Terminal. */
  async accept(jobId: string, actor: string): Promise<JobDocument> {
    return this.transition(jobId, ['validating'], 'accepted', actor, { lease: null });
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
   */
  async fail(
    jobId: string,
    message: string,
    actor: string,
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
     * broke, so it must still hold the job. A validating job failing is the
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
        ? await this.transitionOwnedRunning(jobId, actor, 'failed', extra, now)
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
   * Extend a lease that is still alive.
   *
   * A lease can only be extended from a lease. Without the expiry condition a
   * worker that stalled past its deadline could revive its own claim in the
   * window before the reaper reaches it, which is the one moment another worker
   * is about to be given the job.
   */
  async heartbeat(
    jobId: string,
    workerId: string,
    leaseMs = DEFAULT_LEASE_MS,
    options: { now?: Date } = {},
  ): Promise<boolean> {
    const now = options.now ?? new Date();
    const result = await this.store.jobs.updateOne(
      {
        _id: jobId,
        state: 'running',
        'lease.holder': workerId,
        'lease.expiresAt': { $gt: now },
      },
      { $set: { 'lease.expiresAt': new Date(now.getTime() + leaseMs), updatedAt: now } },
    );
    return result.matchedCount === 1;
  }

  /**
   * Advance a running job on behalf of the worker that owns it.
   *
   * The ownership test is in the update filter, not in a check before it.
   * Reading the lease and then writing on state alone would leave a window —
   * short, and exactly long enough for the reaper and a new claim to land
   * between them.
   */
  private async transitionOwnedRunning(
    jobId: string,
    workerId: string,
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
          'lease.holder': workerId,
          'lease.expiresAt': { $gt: now },
        },
        { $set: { state: to, updatedAt: now, ...extra } },
        { session, returnDocument: 'after' },
      );

      if (!updated) {
        // Classified from what is actually there, so a caller learns whether it
        // lost the job or the job moved on without it.
        const exists = await this.store.jobs.findOne({ _id: jobId }, { session });
        if (!exists) throw new JobNotFound(jobId);
        if (exists.state !== 'running') throw new JobStateConflict(jobId, ['running']);
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

  private async transition(
    jobId: string,
    from: readonly JobState[],
    to: JobState,
    actor: string,
    extra: Record<string, unknown>,
  ): Promise<JobDocument> {
    for (const state of from) assertTransition(state, to);

    return this.store.withTransaction(async (session) => {
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
    });
  }

  private async audit(session: ClientSession, event: AuditEvent): Promise<void> {
    await this.store.auditLog.insertOne(event, { session });
  }
}
