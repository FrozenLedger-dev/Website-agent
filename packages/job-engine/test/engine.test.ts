import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTier, JobSpec, WorkerRole } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import {
  InvalidAcceptanceBinding,
  InvalidClaimRoles,
  JobAcceptanceBindingConflict,
  JobAttemptConflict,
  JobEngine,
  JobLeaseConflict,
  JobNotFound,
  JobStateConflict,
} from '../src/index.js';

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
 * `executionOutputs` (Phase 5f) is `.nullable().default(null)` in the shared
 * `JobRecord` zod schema — the same pattern `lease`/`failure` already use for
 * a field that must be safe to be absent. That default only ever applies
 * when a document is actually parsed through the schema, though, and nothing
 * in this engine does that on read — `store.jobs.findOne` and `claim`'s own
 * `findOneAndUpdate` return whatever Mongo actually stored, trusted directly
 * via the `JobDocument` TypeScript interface, no `.parse()` in between. A
 * document written before this field existed therefore reads back with
 * `executionOutputs: undefined`, not `null` — a real gap between the
 * schema's default and what a legacy document actually contains at runtime.
 *
 * It is a safe gap, not a silent one: nothing here ever *reads* an existing
 * job's `executionOutputs` — it is write-only, set only by the guarded
 * `submitForValidation` transition — so `undefined` where the type says
 * `null` never reaches a comparison that would tell the two apart. These pin
 * that a legacy document (inserted the way one from before Phase 5f would
 * have looked, missing the field entirely) still claims, heartbeats, and
 * submits exactly like a current one, and that reading its `executionOutputs`
 * with the same `?? null` idiom already used everywhere else in this suite
 * (`job?.failure ?? null`, etc.) gives the same answer a current job's
 * genuine `null` would.
 */
describe('legacy JobDocuments (written before executionOutputs existed)', () => {
  const legacySpec = (jobId: string): JobSpec => spec(jobId, [`src/${jobId}.tsx`]);

  /** A job as `enqueue` would have written it before Phase 5f — no `executionOutputs` key at all. */
  const insertLegacyJob = async (jobId: string): Promise<void> => {
    const now = new Date();
    const legacyDoc = {
      _id: jobId,
      projectId: PROJECT,
      role: 'frontend_backend' as const,
      spec: legacySpec(jobId),
      state: 'ready' as const,
      origin: { kind: 'plan' as const },
      dependsOn: [],
      attempt: 0,
      maxAttempts: 3,
      lease: null,
      failure: null,
      // executionOutputs intentionally omitted — the field this test exists for.
      createdAt: now,
      updatedAt: now,
    };
    await store.db.collection<{ _id: string } & Record<string, unknown>>('jobs').insertOne(legacyDoc);
  };

  it('a legacy document with no executionOutputs field is still readable', async () => {
    await insertLegacyJob('job_legacy_read');

    const found = await store.jobs.findOne({ _id: 'job_legacy_read' });
    expect(found).not.toBeNull();
    expect(found?.state).toBe('ready');
    // The honest runtime answer: `undefined`, not `null` — no `.parse()` ever
    // ran to apply the schema's default. `?? null` is what normalises it.
    expect(found?.executionOutputs).toBeUndefined();
    expect(found?.executionOutputs ?? null).toBeNull();
  });

  it('remains claimable, heartbeatable, and submittable exactly like a current job', async () => {
    await insertLegacyJob('job_legacy_lifecycle');

    const claimed = await engine.claim('worker-1', TERRA);
    expect(claimed?._id).toBe('job_legacy_lifecycle');
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.executionOutputs ?? null).toBeNull();

    expect(await engine.heartbeat('job_legacy_lifecycle', 'worker-1', 1)).toBe(true);

    const submitted = await engine.submitForValidation('job_legacy_lifecycle', 'worker-1', 1);
    expect(submitted.state).toBe('validating');
    // No outputs were offered, exactly like an existing void handler — the
    // field stays whatever it already was: absent, read as null.
    expect(submitted.executionOutputs ?? null).toBeNull();
  });

  it('accepts newly-attached outputs on a legacy job exactly like a current one', async () => {
    await insertLegacyJob('job_legacy_outputs');
    await engine.claim('worker-1', TERRA);

    const outputs = [{ name: 'job-output/job_legacy_outputs/1/candidate', version: 1 }];
    const submitted = await engine.submitForValidation('job_legacy_outputs', 'worker-1', 1, { outputs });
    expect(submitted.executionOutputs).toEqual(outputs);
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

/**
 * `tier` is the ceiling (5b); `roles`, when given, narrows within it (5d) —
 * for a specialised worker that only has code for some of what its tier is
 * merely permitted to run. It can only ask for less than the tier grants,
 * never more, and an invalid request is refused before the claim transaction
 * opens, so it mutates nothing.
 */
describe('role-scoped claiming', () => {
  it('claims only the requested subset of the tier', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx'], 'frontend_backend'), origin: { kind: 'plan' } });

    const claimed = await engine.claim('worker-1', TERRA, { roles: ['frontend_backend'] });
    expect(claimed?._id).toBe('job_a');
  });

  it('leaves a same-tier job outside the requested subset untouched', async () => {
    await engine.enqueue({ spec: spec('job_review', ['src/a.tsx'], 'qa_review'), origin: { kind: 'plan' } });

    expect(await engine.claim('worker-1', TERRA, { roles: ['frontend_backend'] })).toBeNull();

    const job = await store.jobs.findOne({ _id: 'job_review' });
    expect(job?.state).toBe('ready');
    expect(job?.attempt).toBe(0);
    expect(job?.lease).toBeNull();
  });

  it('is not head-of-line blocked by an older job outside the requested subset', async () => {
    await engine.enqueue({ spec: spec('job_review', ['src/a.tsx'], 'qa_review'), origin: { kind: 'plan' } });
    await engine.enqueue({ spec: spec('job_build', ['src/b.tsx'], 'frontend_backend'), origin: { kind: 'plan' } });

    const claimed = await engine.claim('worker-1', TERRA, { roles: ['frontend_backend'] });
    expect(claimed?._id).toBe('job_build');
  });

  it('refuses to widen past the supplied tier, mutating nothing', async () => {
    await engine.enqueue({
      spec: spec('job_repair', ['src/a.tsx'], 'repair'),
      origin: { kind: 'repair', defectFingerprint: 'fp1', reviewCycle: 0, parentJobId: 'job_other' },
    });

    await expect(engine.claim('worker-1', TERRA, { roles: ['repair'] })).rejects.toBeInstanceOf(InvalidClaimRoles);

    const job = await store.jobs.findOne({ _id: 'job_repair' });
    expect(job?.state).toBe('ready');
    expect(job?.attempt).toBe(0);
    expect(job?.lease).toBeNull();
    expect(await store.auditLog.countDocuments({ jobId: 'job_repair' })).toBe(0);
  });

  it('refuses a mixed request entirely rather than silently dropping the illegal role', async () => {
    await engine.enqueue({ spec: spec('job_build', ['src/a.tsx'], 'frontend_backend'), origin: { kind: 'plan' } });
    await engine.enqueue({
      spec: spec('job_repair', ['src/b.tsx'], 'repair'),
      origin: { kind: 'repair', defectFingerprint: 'fp1', reviewCycle: 0, parentJobId: 'job_other' },
    });

    await expect(
      engine.claim('worker-1', TERRA, { roles: ['frontend_backend', 'repair'] }),
    ).rejects.toBeInstanceOf(InvalidClaimRoles);

    // Neither job moved — not the illegal one, and not the otherwise-legal one either.
    const build = await store.jobs.findOne({ _id: 'job_build' });
    const repair = await store.jobs.findOne({ _id: 'job_repair' });
    expect(build?.state).toBe('ready');
    expect(repair?.state).toBe('ready');
  });

  it('rejects an empty role request rather than treating it as "claim nothing"', async () => {
    await expect(engine.claim('worker-1', TERRA, { roles: [] })).rejects.toBeInstanceOf(InvalidClaimRoles);
  });

  it('Luna narrowed to repair claims it; Luna narrowed to a Terra role is refused', async () => {
    await engine.enqueue({
      spec: spec('job_repair', ['src/a.tsx'], 'repair'),
      origin: { kind: 'repair', defectFingerprint: 'fp1', reviewCycle: 0, parentJobId: 'job_other' },
    });

    const claimed = await engine.claim('luna-1', 'luna', { roles: ['repair'] });
    expect(claimed?._id).toBe('job_repair');

    await expect(engine.claim('luna-2', 'luna', { roles: ['frontend_backend'] })).rejects.toBeInstanceOf(
      InvalidClaimRoles,
    );
  });

  it('cannot make Sol executable by asking claim() to widen it', async () => {
    await expect(engine.claim('sol-1', 'sol', { roles: ['frontend_backend'] })).rejects.toBeInstanceOf(
      InvalidClaimRoles,
    );
    await expect(engine.claim('sol-1', 'sol', { roles: ['repair'] })).rejects.toBeInstanceOf(InvalidClaimRoles);
  });

  it('omitting roles still means everything the tier permits, unchanged from 5b', async () => {
    await engine.enqueue({ spec: spec('job_review', ['src/a.tsx'], 'qa_review'), origin: { kind: 'plan' } });

    const claimed = await engine.claim('worker-1', TERRA);
    expect(claimed?._id).toBe('job_review');
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

    await engine.submitForValidation('job_base', 'worker-1', first!.attempt);
    await engine.accept('job_base', 'harness:validator');

    const second = await engine.claim('worker-2', TERRA);
    expect(second?._id).toBe('job_dependent');
  });
});

describe('output conflict serialisation', () => {
  it('refuses to run two jobs that write the same file', async () => {
    await engine.enqueue({ spec: spec('job_x', ['src/shared.tsx']), origin: { kind: 'plan' } });
    await engine.enqueue({ spec: spec('job_y', ['src/shared.tsx', 'src/other.tsx']), origin: { kind: 'plan' } });

    const x = await engine.claim('worker-1', TERRA);
    expect(x?._id).toBe('job_x');
    expect(await engine.claim('worker-2', TERRA)).toBeNull();

    await engine.submitForValidation('job_x', 'worker-1', x!.attempt);
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

    const firstClaim = await engine.claim('worker-1', TERRA);
    const first = await engine.fail('job_a', 'build error', 'worker-1', firstClaim!.attempt);
    expect(first.state).toBe('ready');

    const secondClaim = await engine.claim('worker-1', TERRA);
    expect(secondClaim?.attempt).toBe(2);
    const second = await engine.fail('job_a', 'build error again', 'worker-1', secondClaim!.attempt);
    expect(second.state).toBe('failed');
    expect(second.attempt).toBe(2);
  });

  it('records every transition in the audit log', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    const claim = await engine.claim('worker-1', TERRA);
    await engine.submitForValidation('job_a', 'worker-1', claim!.attempt);
    await engine.accept('job_a', 'harness:validator');

    const events = await store.auditLog.find({ jobId: 'job_a' }).sort({ at: 1 }).toArray();
    expect(events.map((e) => e.detail['to'])).toEqual(['running', 'validating', 'accepted']);
  });
});

describe('guarded acceptance (Phase 5g-2)', () => {
  it('accepts when expectedAttempt and expectedOutputs both match the job’s current state', async () => {
    await engine.enqueue({ spec: spec('job_ga', ['src/ga.tsx']), origin: { kind: 'plan' } });
    const claim = await engine.claim('worker-1', TERRA);
    const ref = { name: 'job-output/job_ga/1/build-candidate', version: 1 };
    await engine.submitForValidation('job_ga', 'worker-1', claim!.attempt, { outputs: [ref] });

    const accepted = await engine.accept('job_ga', 'harness:validator', {
      expectedAttempt: claim!.attempt,
      expectedOutputs: [ref],
    });
    expect(accepted.state).toBe('accepted');
  });

  it('rejects when expectedAttempt no longer matches the job’s current attempt', async () => {
    await engine.enqueue({ spec: spec('job_gb', ['src/gb.tsx']), origin: { kind: 'plan' } });
    const claim = await engine.claim('worker-1', TERRA);
    const ref = { name: 'job-output/job_gb/1/build-candidate', version: 1 };
    await engine.submitForValidation('job_gb', 'worker-1', claim!.attempt, { outputs: [ref] });

    await expect(
      engine.accept('job_gb', 'harness:validator', { expectedAttempt: claim!.attempt + 1, expectedOutputs: [ref] }),
    ).rejects.toBeInstanceOf(JobAcceptanceBindingConflict);
    expect((await store.jobs.findOne({ _id: 'job_gb' }))?.state).toBe('validating');
  });

  it('rejects when expectedOutputs no longer matches the job’s current executionOutputs', async () => {
    await engine.enqueue({ spec: spec('job_gc', ['src/gc.tsx']), origin: { kind: 'plan' } });
    const claim = await engine.claim('worker-1', TERRA);
    const ref = { name: 'job-output/job_gc/1/build-candidate', version: 1 };
    const otherRef = { name: 'job-output/job_gc/1/other', version: 1 };
    await engine.submitForValidation('job_gc', 'worker-1', claim!.attempt, { outputs: [ref] });

    await expect(
      engine.accept('job_gc', 'harness:validator', { expectedAttempt: claim!.attempt, expectedOutputs: [otherRef] }),
    ).rejects.toBeInstanceOf(JobAcceptanceBindingConflict);
    expect((await store.jobs.findOne({ _id: 'job_gc' }))?.state).toBe('validating');
  });

  it('rejects expectedAttempt supplied without expectedOutputs, before anything is read', async () => {
    await engine.enqueue({ spec: spec('job_gd', ['src/gd.tsx']), origin: { kind: 'plan' } });
    await expect(engine.accept('job_gd', 'harness:validator', { expectedAttempt: 1 })).rejects.toBeInstanceOf(
      InvalidAcceptanceBinding,
    );
    expect((await store.jobs.findOne({ _id: 'job_gd' }))?.state).toBe('ready');
  });

  it('rejects expectedOutputs supplied without expectedAttempt, before anything is read', async () => {
    await engine.enqueue({ spec: spec('job_ge', ['src/ge.tsx']), origin: { kind: 'plan' } });
    await expect(
      engine.accept('job_ge', 'harness:validator', { expectedOutputs: [{ name: 'x', version: 1 }] }),
    ).rejects.toBeInstanceOf(InvalidAcceptanceBinding);
    expect((await store.jobs.findOne({ _id: 'job_ge' }))?.state).toBe('ready');
  });

  it('an externally supplied session genuinely participates in the caller’s own transaction — a later failure rolls the acceptance back too', async () => {
    // A direct, engine-level proof that `session` is actually used, not
    // merely accepted and ignored: unlike a test that only checks what was
    // passed in, this lets the real guarded write happen and then forces a
    // failure afterward, inside the same transaction — the write can only
    // survive that if it was never really part of the transaction at all.
    await engine.enqueue({ spec: spec('job_gf', ['src/gf.tsx']), origin: { kind: 'plan' } });
    const claim = await engine.claim('worker-1', TERRA);
    const ref = { name: 'job-output/job_gf/1/build-candidate', version: 1 };
    await engine.submitForValidation('job_gf', 'worker-1', claim!.attempt, { outputs: [ref] });

    await expect(
      store.withTransaction(async (session) => {
        await engine.accept('job_gf', 'harness:validator', {
          expectedAttempt: claim!.attempt,
          expectedOutputs: [ref],
          session,
        });
        throw new Error('forced failure after the guarded accept, inside the caller’s own transaction');
      }),
    ).rejects.toThrow('forced failure after the guarded accept');

    expect((await store.jobs.findOne({ _id: 'job_gf' }))?.state).toBe('validating');
    const events = await store.auditLog.find({ jobId: 'job_gf' }).sort({ at: 1 }).toArray();
    expect(events.map((e) => e.detail['to'])).not.toContain('accepted');
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
    const claim = await engine.claim('worker-1', TERRA, { leaseMs: 1 });
    await engine.reclaimExpiredLeases(new Date(Date.now() + 60_000));

    expect(await engine.heartbeat('job_a', 'worker-1', claim!.attempt)).toBe(false);
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
  /** worker-1's attempt throughout this block: always its first (and only, unless noted) claim. */
  const ATTEMPT_1 = 1;

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
      const submitted = await engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, {
        now: new Date(T0.getTime() + 1000),
      });

      expect(submitted.state).toBe('validating');
      expect(submitted.lease).toBeNull();
    });

    it('may report its own failure, and still gets its retry', async () => {
      const job = await claimed();
      expect(job.attempt).toBe(1);

      const after = await engine.fail('job_a', 'build error', 'worker-1', ATTEMPT_1, {
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
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe('running');
      expect(job?.lease?.holder).toBe('worker-1');
    });

    it('may not fail its own still-running job', async () => {
      await claimed();

      await expect(
        engine.fail('job_a', 'late failure', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe('running');
      expect(job?.failure ?? null).toBeNull();
    });

    it('may not extend a lease it no longer has', async () => {
      await claimed();
      expect(await engine.heartbeat('job_a', 'worker-1', ATTEMPT_1, LEASE_MS, { now: AFTER })).toBe(false);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.lease?.expiresAt.getTime()).toBe(T0.getTime() + LEASE_MS);
    });

    it('is out of time at the exact instant its lease ends, not a moment later', async () => {
      // One definition of expiry across the engine. `expiresAt > now` is alive,
      // so `expiresAt === now` is not — and the reaper agrees, or there would be
      // an instant where a lease is too dead to use and too alive to reclaim.
      await claimed();

      expect(await engine.heartbeat('job_a', 'worker-1', ATTEMPT_1, LEASE_MS, { now: AT_EXPIRY })).toBe(false);
      await expect(
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AT_EXPIRY }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);
      expect(await engine.reclaimExpiredLeases(AT_EXPIRY)).toBe(1);
    });

    it('is still alive one millisecond before that', async () => {
      await claimed();
      const justBefore = new Date(T0.getTime() + LEASE_MS - 1);

      expect(await engine.heartbeat('job_a', 'worker-1', ATTEMPT_1, LEASE_MS, { now: justBefore })).toBe(true);
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
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AFTER }),
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
        engine.fail('job_a', 'late failure from the old worker', 'worker-1', ATTEMPT_1, { now: AFTER }),
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
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);
      await expect(
        engine.fail('job_a', 'late failure', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      expect(await transitions('job_a')).toBe(before);
    });

    it('does not stop the new holder finishing', async () => {
      await superseded();
      const submitted = await engine.submitForValidation('job_a', 'worker-2', 2, { now: AFTER });
      expect(submitted.state).toBe('validating');
    });
  });

  describe('a worker that never held it', () => {
    it('may not submit', async () => {
      await claimed();
      await expect(
        engine.submitForValidation('job_a', 'worker-9', ATTEMPT_1, { now: T0 }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);
    });

    it('may not heartbeat', async () => {
      await claimed();
      expect(await engine.heartbeat('job_a', 'worker-9', ATTEMPT_1, LEASE_MS, { now: T0 })).toBe(false);
    });
  });

  describe('what the refusal says', () => {
    it('distinguishes a job that moved on from one that was taken away', async () => {
      // Different facts. "The job moved on" may be retryable; "you lost it"
      // means someone else is doing the work and this worker must stop.
      await claimed();
      await engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: T0 });

      // Now validating, so a running-owned operation is a state conflict.
      await expect(
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: T0 }),
      ).rejects.toBeInstanceOf(JobStateConflict);

      await claimed('job_b');
      await expect(
        engine.submitForValidation('job_b', 'worker-9', ATTEMPT_1, { now: T0 }),
      ).rejects.toBeInstanceOf(JobLeaseConflict);

      await expect(
        engine.submitForValidation('job_missing', 'worker-1', ATTEMPT_1, { now: T0 }),
      ).rejects.toBeInstanceOf(JobNotFound);
    });

    it('names who holds the job now', async () => {
      await claimed();
      await engine.reclaimExpiredLeases(AFTER);
      await engine.claim('worker-2', TERRA, { leaseMs: LEASE_MS, now: AFTER });

      await expect(
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toThrow(/held by worker-2/);
    });
  });

  describe('validation failure is a different authority', () => {
    it('needs no lease, because submission already cleared it', async () => {
      // The harness rejecting finished work is not a worker reporting its own
      // failure. Requiring a lease here would make validation impossible.
      // `attempt` is accepted but unused on this branch — there is no lease
      // left to fence.
      await claimed();
      await engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: T0 });

      const failed = await engine.fail('job_a', 'gates rejected it', 'harness:validator', ATTEMPT_1, {
        now: new Date(T0.getTime() + 1000),
      });

      expect(failed.state).toBe('ready');
      expect(failed.failure?.message).toBe('gates rejected it');
    });
  });

  /**
   * Phase 5f. `lease.holder` alone cannot tell a stale execution of this
   * job apart from the current one when both happen to share the same fixed
   * `workerId` — the shape a `JobRunner` always claims under. `attempt` is
   * what closes that gap: a later claim of the same job always has a larger
   * one (`claim()`'s own `$inc`, never decremented), so it is reused as the
   * execution's generation token rather than inventing a second counter.
   */
  describe('same worker, later attempt of its own job', () => {
    /** worker-1 loses `job_a` to the reaper, then reclaims it — as itself. */
    const sameWorkerReclaim = async () => {
      await claimed();
      expect(await engine.reclaimExpiredLeases(AFTER)).toBe(1);
      const second = await engine.claim('worker-1', TERRA, { leaseMs: LEASE_MS, now: AFTER });
      expect(second?.lease?.holder).toBe('worker-1');
      expect(second?.attempt).toBe(2);
      return second!;
    };

    it('a heartbeat from the stale attempt does not extend the new attempt’s lease', async () => {
      const current = await sameWorkerReclaim();

      expect(await engine.heartbeat('job_a', 'worker-1', ATTEMPT_1, LEASE_MS, { now: AFTER })).toBe(false);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.attempt).toBe(2);
      expect(job?.lease?.expiresAt.getTime()).toBe(current.lease!.expiresAt.getTime());
    });

    it('a heartbeat from the current attempt still works', async () => {
      await sameWorkerReclaim();
      expect(await engine.heartbeat('job_a', 'worker-1', 2, LEASE_MS, { now: AFTER })).toBe(true);
    });

    it('a submit from the stale attempt is a JobAttemptConflict, not a JobLeaseConflict', async () => {
      // Distinct from "someone else holds it": the same workerId holds it,
      // just on a later generation. The error must say which.
      await sameWorkerReclaim();

      await expect(
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobAttemptConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe('running');
      expect(job?.attempt).toBe(2);
    });

    it('a submit from the current attempt still works', async () => {
      await sameWorkerReclaim();
      const submitted = await engine.submitForValidation('job_a', 'worker-1', 2, { now: AFTER });
      expect(submitted.state).toBe('validating');
    });

    it('a running-fail from the stale attempt is rejected and touches nothing about the current one', async () => {
      const current = await sameWorkerReclaim();

      await expect(
        engine.fail('job_a', 'stale failure', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobAttemptConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe('running');
      expect(job?.attempt).toBe(2);
      expect(job?.failure ?? null).toBeNull();
      expect(job?.lease?.holder).toBe('worker-1');
      expect(job?.lease?.expiresAt.getTime()).toBe(current.lease!.expiresAt.getTime());
    });

    it('a running-fail from the current attempt still works', async () => {
      await sameWorkerReclaim();
      const failed = await engine.fail('job_a', 'real failure', 'worker-1', 2, { now: AFTER });
      expect(['ready', 'failed']).toContain(failed.state);
    });

    it('leaves zero transition audit for every rejected stale operation', async () => {
      await sameWorkerReclaim();
      const before = await transitions('job_a');

      await expect(
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobAttemptConflict);
      await expect(
        engine.fail('job_a', 'stale', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobAttemptConflict);
      await engine.heartbeat('job_a', 'worker-1', ATTEMPT_1, LEASE_MS, { now: AFTER });

      expect(await transitions('job_a')).toBe(before);
    });

    it('the current attempt’s lease is byte-for-byte unchanged after every stale operation is rejected', async () => {
      const current = await sameWorkerReclaim();
      const snapshot = {
        state: current.state,
        attempt: current.attempt,
        holder: current.lease?.holder,
        expiresAt: current.lease?.expiresAt.getTime(),
        failure: current.failure,
      };

      await engine.heartbeat('job_a', 'worker-1', ATTEMPT_1, LEASE_MS, { now: AFTER });
      await expect(
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobAttemptConflict);
      await expect(
        engine.fail('job_a', 'stale', 'worker-1', ATTEMPT_1, { now: AFTER }),
      ).rejects.toBeInstanceOf(JobAttemptConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe(snapshot.state);
      expect(job?.attempt).toBe(snapshot.attempt);
      expect(job?.lease?.holder).toBe(snapshot.holder);
      expect(job?.lease?.expiresAt.getTime()).toBe(snapshot.expiresAt);
      expect(job?.failure ?? null).toEqual(snapshot.failure);
    });
  });

  describe('output refs attach atomically with the guarded submit', () => {
    it('attaches exactly the staged refs in the same transition that moves to validating', async () => {
      const job = await claimed();
      const outputs = [{ name: 'job-output/job_a/1/candidate', version: 1 }];

      const submitted = await engine.submitForValidation('job_a', 'worker-1', job.attempt, { now: T0, outputs });

      expect(submitted.state).toBe('validating');
      expect(submitted.executionOutputs).toEqual(outputs);

      const stored = await store.jobs.findOne({ _id: 'job_a' });
      expect(stored?.executionOutputs).toEqual(outputs);
    });

    it('a rejected stale submit attaches nothing, even when it tries to pass outputs', async () => {
      await claimed();
      expect(await engine.reclaimExpiredLeases(AFTER)).toBe(1);
      await engine.claim('worker-1', TERRA, { leaseMs: LEASE_MS, now: AFTER }); // attempt 2, same worker

      const staleOutputs = [{ name: 'job-output/job_a/1/stale', version: 1 }];
      await expect(
        engine.submitForValidation('job_a', 'worker-1', ATTEMPT_1, { now: AFTER, outputs: staleOutputs }),
      ).rejects.toBeInstanceOf(JobAttemptConflict);

      const job = await store.jobs.findOne({ _id: 'job_a' });
      expect(job?.state).toBe('running');
      expect(job?.executionOutputs ?? null).toBeNull();
    });

    it('omitting outputs leaves executionOutputs untouched — existing void handlers stay valid', async () => {
      const job = await claimed();
      const submitted = await engine.submitForValidation('job_a', 'worker-1', job.attempt, { now: T0 });
      expect(submitted.executionOutputs ?? null).toBeNull();
    });
  });
});
