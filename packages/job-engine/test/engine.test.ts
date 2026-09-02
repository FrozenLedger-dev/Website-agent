import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTier, JobSpec, WorkerRole } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { JobEngine, JobLeaseConflict, JobNotFound, JobStateConflict } from '../src/index.js';

const PROJECT = 'proj_engine_test';

/** Every fixture job in this file is Terra's role, unless a test says otherwise. */
const TERRA: AgentTier = 'terra';

let store: StateStore;
let engine: JobEngine;

const spec = (jobId: string, output: string[], role: WorkerRole = 'frontend_backend'): JobSpec => ({
  projectId: PROJECT,
  jobId,
  role,
  objective: `build ${jobId}`,
  inputs: { pageSpec: { name: 'pages/home', version: 1 } },
  acceptanceCriteria: ['renders'],
  allowedTools: ['filesystem'],
  output,
});

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  engine = new JobEngine(store);
});

afterAll(async () => {
  await store?.close();
});

beforeEach(async () => {
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
});

describe('claiming', () => {
  it('claims a ready job and leases it', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });

    const claimed = await engine.claim('worker-1', TERRA);
    expect(claimed?._id).toBe('job_a');
    expect(claimed?.state).toBe('running');
    expect(claimed?.lease?.holder).toBe('worker-1');
    expect(claimed?.attempt).toBe(1);
  });

  it('returns null when nothing is runnable', async () => {
    expect(await engine.claim('worker-1', TERRA)).toBeNull();
  });

  it('never hands the same job to two workers', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });

    const [first, second] = await Promise.all([engine.claim('worker-1', TERRA), engine.claim('worker-2', TERRA)]);
    const claimed = [first, second].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });
});

/**
 * A worker id is a claim; `tier` is what the caller actually is. `claim` must
 * narrow the candidate pool by it rather than hand out a job and let something
 * downstream object, because nothing downstream does — a lease is granted, an
 * attempt is spent, and the job is `running` before any role check could fire.
 */
describe('role-aware claiming', () => {
  it('will not hand a Terra job to a Luna worker', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });

    expect(await engine.claim('luna-1', 'luna')).toBeNull();

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('ready');
  });

  it('will not hand a Luna repair job to a Terra worker', async () => {
    await engine.enqueue({
      spec: spec('job_repair', ['src/a.tsx'], 'repair'),
      origin: { kind: 'repair', defectFingerprint: 'fp1', reviewCycle: 0, parentJobId: 'job_a' },
    });

    expect(await engine.claim('worker-1', TERRA)).toBeNull();

    const job = await store.jobs.findOne({ _id: 'job_repair' });
    expect(job?.state).toBe('ready');
  });

  it('lets each tier claim only the roles that belong to it', async () => {
    await engine.enqueue({ spec: spec('job_build', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.enqueue({
      spec: spec('job_repair', ['src/b.tsx'], 'repair'),
      origin: { kind: 'repair', defectFingerprint: 'fp1', reviewCycle: 0, parentJobId: 'job_build' },
    });

    const terraClaim = await engine.claim('worker-1', TERRA);
    expect(terraClaim?._id).toBe('job_build');

    const lunaClaim = await engine.claim('luna-1', 'luna');
    expect(lunaClaim?._id).toBe('job_repair');
  });

  it('is not blocked by an older ineligible job sorting ahead of it', async () => {
    // The repair job is older, so it would sort first by createdAt — but it
    // never enters the candidate set at all, because the role filter is in
    // the query itself. Being first in the queue must not matter when it is
    // the wrong tier's queue.
    await engine.enqueue({
      spec: spec('job_repair', ['src/a.tsx'], 'repair'),
      origin: { kind: 'repair', defectFingerprint: 'fp1', reviewCycle: 0, parentJobId: 'job_other' },
    });
    await engine.enqueue({ spec: spec('job_build', ['src/b.tsx']), origin: { kind: 'plan' } });

    const claimed = await engine.claim('worker-1', TERRA);
    expect(claimed?._id).toBe('job_build');
  });
});

describe('dependency graph', () => {
  it('holds a job back until its dependency is accepted', async () => {
    await engine.enqueue({ spec: spec('job_base', ['src/base.tsx']), origin: { kind: 'plan' } });
    await engine.enqueue({
      spec: spec('job_dependent', ['src/dependent.tsx']),
      origin: { kind: 'plan' },
      dependsOn: ['job_base'],
    });

    // Only the dependency-free job is claimable.
    const first = await engine.claim('worker-1', TERRA);
    expect(first?._id).toBe('job_base');
    expect(await engine.claim('worker-2', TERRA)).toBeNull();

    await engine.submitForValidation('job_base', 'worker-1');
    await engine.accept('job_base', 'harness:validator');

    const second = await engine.claim('worker-2', TERRA);
    expect(second?._id).toBe('job_dependent');
  });
});

describe('output conflict serialisation', () => {
  it('refuses to run two jobs that write the same file', async () => {
    await engine.enqueue({ spec: spec('job_x', ['src/shared.tsx']), origin: { kind: 'plan' } });
    await engine.enqueue({ spec: spec('job_y', ['src/shared.tsx', 'src/other.tsx']), origin: { kind: 'plan' } });

    expect((await engine.claim('worker-1', TERRA))?._id).toBe('job_x');
    expect(await engine.claim('worker-2', TERRA)).toBeNull();

    await engine.submitForValidation('job_x', 'worker-1');
    await engine.accept('job_x', 'harness:validator');
    expect((await engine.claim('worker-2', TERRA))?._id).toBe('job_y');
  });

  it('runs disjoint jobs in parallel', async () => {
    await engine.enqueue({ spec: spec('job_p', ['src/p.tsx']), origin: { kind: 'plan' } });
    await engine.enqueue({ spec: spec('job_q', ['src/q.tsx']), origin: { kind: 'plan' } });

    expect((await engine.claim('worker-1', TERRA))?._id).toBe('job_p');
    expect((await engine.claim('worker-2', TERRA))?._id).toBe('job_q');
  });
});

describe('lifecycle', () => {
  it('rejects an illegal transition rather than silently applying it', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1', TERRA);
    // running -> accepted skips validation entirely.
    await expect(engine.accept('job_a', 'harness:validator')).rejects.toBeInstanceOf(JobStateConflict);
  });

  it('retries a failed job while attempts remain, then gives up', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' }, maxAttempts: 2 });

    await engine.claim('worker-1', TERRA);
    const first = await engine.fail('job_a', 'build error', 'worker-1');
    expect(first.state).toBe('ready');

    await engine.claim('worker-1', TERRA);
    const second = await engine.fail('job_a', 'build error again', 'worker-1');
    expect(second.state).toBe('failed');
    expect(second.attempt).toBe(2);
  });

  it('records every transition in the audit log', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1', TERRA);
    await engine.submitForValidation('job_a', 'worker-1');
    await engine.accept('job_a', 'harness:validator');

    const events = await store.auditLog.find({ jobId: 'job_a' }).sort({ at: 1 }).toArray();
    expect(events.map((e) => e.detail['to'])).toEqual(['running', 'validating', 'accepted']);
  });
});

describe('lease reclamation', () => {
  it('returns a crashed worker’s job to the ready pool', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1', TERRA, { leaseMs: 1 });

    const later = new Date(Date.now() + 60_000);
    expect(await engine.reclaimExpiredLeases(later)).toBe(1);

    const reclaimed = await engine.claim('worker-2', TERRA);
    expect(reclaimed?._id).toBe('job_a');
    expect(reclaimed?.attempt).toBe(2);
  });

  it('leaves a live lease alone', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1', TERRA, { leaseMs: 60_000 });
    expect(await engine.reclaimExpiredLeases(new Date())).toBe(0);
  });

  it('refuses a heartbeat from a worker that lost its lease', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1', TERRA, { leaseMs: 1 });
    await engine.reclaimExpiredLeases(new Date(Date.now() + 60_000));

    expect(await engine.heartbeat('job_a', 'worker-1')).toBe(false);
  });
});

/**
 * A lease is execution authority, not a scheduling note.
 *
 * The engine already handed out leases, but only some methods treated them as
 * authoritative: submitting finished work and reporting a failure both filtered
 * on state alone, so a worker that had lost its job could still advance it. A
 * heartbeat could also revive a lease that had already expired, in the one
 * window where another worker is about to be given the work.
 *
 * These pin what a stale worker may do, which is nothing. Deterministic
 * throughout — every method takes `now`, so no test waits on a clock.
 */
describe('lease authority over a running job', () => {
  const T0 = new Date('2030-01-01T10:00:00.000Z');
  const LEASE_MS = 5 * 60 * 1000;
  /** One millisecond after worker-1's lease ends. */
  const AFTER = new Date(T0.getTime() + LEASE_MS + 1);
  /** The instant it ends. */
  const AT_EXPIRY = new Date(T0.getTime() + LEASE_MS);

  const claimed = async (jobId = 'job_a', worker = 'worker-1', now = T0) => {
    await engine.enqueue({ spec: spec(jobId, [`src/${jobId}.tsx`]), origin: { kind: 'plan' } });
    const job = await engine.claim(worker, TERRA, { leaseMs: LEASE_MS, now });
    expect(job?.lease?.holder).toBe(worker);
    return job!;
  };

  const transitions = async (jobId: string) =>
    store.auditLog.countDocuments({ jobId, kind: 'job_transition' });

  describe('the worker that holds it', () => {
    it('may submit its finished work', async () => {
      await claimed();
      const submitted = await engine.submitForValidation('job_a', 'worker-1', {
        now: new Date(T0.getTime() + 1000),
      });

      expect(submitted.state).toBe('validating');
      expect(submitted.lease).toBeNull();
    });

    it('may report its own failure, and still gets its retry', async () => {
      const job = await claimed();
      expect(job.attempt).toBe(1);

      const after = await engine.fail('job_a', 'build error', 'worker-1', {
        now: new Date(T0.getTime() + 1000),
      });

      expect(after.state).toBe('ready');
      expect(after.failure?.message).toBe('build error');
    });
  });

  describe('a worker whose lease has run out', () => {
    it('may not submit, even before the reaper has noticed', async () => {
      // The reaper is not what makes a lease expire; time is. The document may
      // still say `running` with worker-1 on it, and worker-1 is still done.
      await claimed();

      await expect(
        engine.submitForValidation('job_a', 'worker-1', { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe('running');
      expect(job?.lease?.holder).toBe('worker-1');
    });

    it('may not fail its own still-running job', async () => {
      await claimed();

      await expect(
        engine.fail('job_a', 'late failure', 'worker-1', { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe('running');
      expect(job?.failure ?? null).toBeNull();
    });

    it('may not extend a lease it no longer has', async () => {
      await claimed();
      expect(await engine.heartbeat('job_a', 'worker-1', LEASE_MS, { now: AFTER })).toBe(false);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.lease?.expiresAt.getTime()).toBe(T0.getTime() + LEASE_MS);
    });

    it('is out of time at the exact instant its lease ends, not a moment later', async () => {
      // One definition of expiry across the engine. `expiresAt > now` is alive,
      // so `expiresAt === now` is not — and the reaper agrees, or there would be
      // an instant where a lease is too dead to use and too alive to reclaim.
      await claimed();

      expect(await engine.heartbeat('job_a', 'worker-1', LEASE_MS, { now: AT_EXPIRY })).toBe(false);
      await expect(
        engine.submitForValidation('job_a', 'worker-1', { now: AT_EXPIRY }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);
      expect(await engine.reclaimExpiredLeases(AT_EXPIRY)).toBe(1);
    });

    it('is still alive one millisecond before that', async () => {
      await claimed();
      const justBefore = new Date(T0.getTime() + LEASE_MS - 1);

      expect(await engine.heartbeat('job_a', 'worker-1', LEASE_MS, { now: justBefore })).toBe(true);
      expect(await engine.reclaimExpiredLeases(justBefore)).toBe(0);
    });
  });

  describe('a worker whose job has been given to someone else', () => {
    /** worker-1 loses `job_a` to worker-2 after the reaper runs. */
    const superseded = async () => {
      await claimed();
      expect(await engine.reclaimExpiredLeases(AFTER)).toBe(1);
      const second = await engine.claim('worker-2', TERRA, { leaseMs: LEASE_MS, now: AFTER });
      expect(second?.lease?.holder).toBe('worker-2');
      expect(second?.attempt).toBe(2);
      return second!;
    };

    it('may not submit work the new holder is still doing', async () => {
      await superseded();

      await expect(
        engine.submitForValidation('job_a', 'worker-1', { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe('running');
      expect(job?.lease?.holder).toBe('worker-2');
    });

    it('cannot damage the run that replaced it', async () => {
      // Stronger than asserting a throw: nothing about the live execution may
      // move. A late failure from a dead worker must not consume worker-2's
      // attempt, clear its lease, or write a failure it did not have.
      const before = await superseded();

      await expect(
        engine.fail('job_a', 'late failure from the old worker', 'worker-1', { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      const after = await store.jobs.findOne({ _id: 'job_a' });
      expect(after?.state).toBe(before.state);
      expect(after?.attempt).toBe(before.attempt);
      expect(after?.lease?.holder).toBe(before.lease?.holder);
      expect(after?.lease?.expiresAt.getTime()).toBe(before.lease?.expiresAt.getTime());
      expect(after?.failure ?? null).toBeNull();
    });

    it('leaves no trace in the audit trail', async () => {
      // A refused operation must not read as a successful one afterwards.
      await superseded();
      const before = await transitions('job_a');

      await expect(
        engine.submitForValidation('job_a', 'worker-1', { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);
      await expect(
        engine.fail('job_a', 'late failure', 'worker-1', { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      expect(await transitions('job_a')).toBe(before);
    });

    it('does not stop the new holder finishing', async () => {
      await superseded();
      const submitted = await engine.submitForValidation('job_a', 'worker-2', { now: AFTER });
      expect(submitted.state).toBe('validating');
    });
  });

  describe('a worker that never held it', () => {
    it('may not submit', async () => {
      await claimed();
      await expect(
        engine.submitForValidation('job_a', 'worker-9', { now: T0 }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);
    });

    it('may not heartbeat', async () => {
      await claimed();
      expect(await engine.heartbeat('job_a', 'worker-9', LEASE_MS, { now: T0 })).toBe(false);
    });
  });

  describe('what the refusal says', () => {
    it('distinguishes a job that moved on from one that was taken away', async () => {
      // Different facts. "The job moved on" may be retryable; "you lost it"
      // means someone else is doing the work and this worker must stop.
      await claimed();
      await engine.submitForValidation('job_a', 'worker-1', { now: T0 });

      // Now validating, so a running-owned operation is a state conflict.
      await expect(
        engine.submitForValidation('job_a', 'worker-1', { now: T0 }),
      ).rejects.toBeInstanceOf(JobStateConflict);

      await claimed('job_b');
      await expect(
        engine.submitForValidation('job_b', 'worker-9', { now: T0 }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      await expect(
        engine.submitForValidation('job_missing', 'worker-1', { now: T0 }),
      ).rejects.toBeInstanceOf(JobNotFound);
    });

    it('names who holds the job now', async () => {
      await claimed();
      await engine.reclaimExpiredLeases(AFTER);
      await engine.claim('worker-2', TERRA, { leaseMs: LEASE_MS, now: AFTER });

      await expect(
        engine.submitForValidation('job_a', 'worker-1', { now: AFTER }),
      ).rejects.toThrow(/held by worker-2/);
    });
  });

  describe('validation failure is a different authority', () => {
    it('needs no lease, because submission already cleared it', async () => {
      // The harness rejecting finished work is not a worker reporting its own
      // failure. Requiring a lease here would make validation impossible.
      await claimed();
      await engine.submitForValidation('job_a', 'worker-1', { now: T0 });

      const failed = await engine.fail('job_a', 'gates rejected it', 'harness:validator', {
        now: new Date(T0.getTime() + 1000),
      });

      expect(failed.state).toBe('ready');
      expect(failed.failure?.message).toBe('gates rejected it');
    });
  });
});
