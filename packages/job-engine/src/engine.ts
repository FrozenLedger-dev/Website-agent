/**
 * Job engine (v1.2 §4).
 *
 * Owns the job lifecycle: enqueue, claim, transition, retry, reclaim. Every
 * state change is a guarded update — the filter always includes the state the
 * caller believes the job is in, so two workers racing on one job cannot both
 * win, and a stale view of the world cannot advance a job it no longer owns.
 */
import type { ClientSession } from 'mongodb';
import { assertTransition, outputsConflict, type JobOrigin, type JobSpec, type JobState } from '@statxai/contracts';
import type { AuditEvent, JobDocument, StateStore } from '@statxai/state';

export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export class JobNotFound extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} not found`);
    this.name = 'JobNotFound';
  }
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
   * Claim one runnable job, or return null.
   *
   * Eligibility is not expressible as a single-document filter, because two of
   * the three conditions are cross-document:
   *
   *   1. the job is `ready`                        — single document
   *   2. every dependency has been accepted        — other job documents
   *   3. no running job writes an overlapping path — other job documents
   *
   * So the whole selection runs inside a transaction. Snapshot isolation gives
   * a consistent view of (2) and (3), and the final guarded update makes the
   * claim itself atomic: if another worker took the job first, the update
   * matches nothing and the transaction aborts and retries.
   *
   * Condition (3) is what keeps parallel workers from corrupting a single
   * project repository. §2 promises parallel execution and §1 gives each
   * project one Git repo; the declared `output` list is what reconciles them.
   */
  async claim(
    workerId: string,
    options: { projectId?: string; leaseMs?: number; now?: Date } = {},
  ): Promise<JobDocument | null> {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

    return this.store.withTransaction(async (session) => {
      const scope = options.projectId ? { projectId: options.projectId } : {};

      const candidates = await this.store.jobs
        .find({ ...scope, state: 'ready' }, { session, sort: { createdAt: 1 } })
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

  private async dependenciesSatisfied(job: JobDocument, session: ClientSession): Promise<boolean> {
    if (job.dependsOn.length === 0) return true;
    const accepted = await this.store.jobs.countDocuments(
      { _id: { $in: job.dependsOn }, state: 'accepted' },
      { session },
    );
    return accepted === job.dependsOn.length;
  }

  /** Work finished; hand off to validation. */
  async submitForValidation(jobId: string, actor: string): Promise<JobDocument> {
    return this.transition(jobId, ['running'], 'validating', actor, { lease: null });
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
  async fail(jobId: string, message: string, actor: string, options: { policyViolation?: boolean } = {}): Promise<JobDocument> {
    const now = new Date();
    const failed = await this.transition(jobId, ['running', 'validating'], 'failed', actor, {
      lease: null,
      failure: { message, at: now, policyViolation: options.policyViolation ?? false },
    });

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
      .find({ state: 'running', 'lease.expiresAt': { $lt: now } })
      .toArray();

    let reclaimed = 0;
    for (const job of expired) {
      const result = await this.store.withTransaction(async (session) => {
        const updated = await this.store.jobs.findOneAndUpdate(
          { _id: job._id, state: 'running', 'lease.expiresAt': { $lt: now } },
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

  /** Extend a lease held by `workerId`. Fails if the lease was reclaimed. */
  async heartbeat(jobId: string, workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
    const now = new Date();
    const result = await this.store.jobs.updateOne(
      { _id: jobId, state: 'running', 'lease.holder': workerId },
      { $set: { 'lease.expiresAt': new Date(now.getTime() + leaseMs), updatedAt: now } },
    );
    return result.matchedCount === 1;
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
