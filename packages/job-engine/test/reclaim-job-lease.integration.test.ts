/**
 * Reclaiming one exact job whose execution lease expired, and the fence that
 * makes the dead execution's tokens worthless afterwards.
 *
 * Integration: needs the Mongo replica set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobSpec } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { JobAttemptConflict, JobEngine, JobLeaseConflict, JobStateConflict } from '../src/index.js';

const PROJECT = 'proj_reclaim_test';
let store: StateStore;
let engine: JobEngine;

const spec = (jobId: string): JobSpec => ({
  projectId: PROJECT,
  jobId,
  role: 'frontend_backend',
  objective: `build ${jobId}`,
  inputs: { pageSpec: { name: 'pages/home', version: 1 } },
  acceptanceCriteria: ['renders'],
  allowedTools: ['filesystem'],
  output: [`app/${jobId}/`],
});

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  engine = new JobEngine(store);
});
afterAll(async () => {
  await store?.close();
});
beforeEach(async () => {
  await store.jobs.deleteMany({ projectId: PROJECT });
  await store.auditLog.deleteMany({ projectId: PROJECT });
});

const t0 = new Date('2026-09-14T10:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

async function runningJob(jobId: string, maxAttempts = 3) {
  await engine.enqueue({ spec: spec(jobId), origin: { kind: 'plan' }, maxAttempts });
  const claimed = await engine.claim('worker-a', 'terra', { jobId, leaseMs: 60_000, now: t0 });
  expect(claimed?.attempt).toBe(1);
  return claimed!;
}

describe('reclaiming one exact job', () => {
  it('never takes a lease that has not expired — however long the work has run', async () => {
    await runningJob('job_live');
    expect(await engine.reclaimExpiredJobLease('job_live', 'worker-b', at(59_999))).toBeNull();
    expect(await store.jobs.findOne({ _id: 'job_live' })).toMatchObject({ state: 'running', attempt: 1, lease: { holder: 'worker-a' } });
  });

  it('returns an expired job to ready on its same identity, and records who reclaimed it and why', async () => {
    await runningJob('job_dead');
    const reclaimed = await engine.reclaimExpiredJobLease('job_dead', 'worker-b', at(60_000));
    expect(reclaimed).toMatchObject({ _id: 'job_dead', state: 'ready', attempt: 1, lease: null });
    const audit = await store.auditLog.findOne({ jobId: 'job_dead', 'detail.reason': 'lease_expired' });
    expect(audit).toMatchObject({ actor: 'worker-b', detail: { from: 'running', to: 'ready', attempt: 1, heldBy: 'worker-a' } });
    expect(await store.jobs.countDocuments({ projectId: PROJECT })).toBe(1);
  });

  it('reclaims only the job it names, and nothing that is not running', async () => {
    await runningJob('job_one');
    await engine.enqueue({ spec: spec('job_two'), origin: { kind: 'plan' } });
    await engine.claim('worker-a', 'terra', { jobId: 'job_two', leaseMs: 1, now: t0 });
    expect(await engine.reclaimExpiredJobLease('job_one', 'worker-b', at(60_000))).not.toBeNull();
    expect((await store.jobs.findOne({ _id: 'job_two' }))?.state).toBe('running');
    expect(await engine.reclaimExpiredJobLease('job_one', 'worker-b', at(120_000))).toBeNull();
    expect(await engine.reclaimExpiredJobLease('job_missing', 'worker-b', at(120_000))).toBeNull();
  });

  it('an execution that died on its final attempt spent it: the job fails, and no extra attempt is granted', async () => {
    await runningJob('job_last', 1);
    const reclaimed = await engine.reclaimExpiredJobLease('job_last', 'worker-b', at(60_000));
    expect(reclaimed).toMatchObject({ state: 'failed', attempt: 1, failure: { message: 'the execution lease expired on the final attempt' } });
    expect(await engine.claim('worker-b', 'terra', { jobId: 'job_last', now: at(60_001) })).toBeNull();
  });

  it('the dead execution\'s tokens are stale: it can neither heartbeat, submit a candidate nor fail the job — and the new attempt proceeds', async () => {
    await runningJob('job_race');
    await engine.reclaimExpiredJobLease('job_race', 'worker-b', at(60_000));

    // Before anyone re-claims: the old execution finds no running job.
    expect(await engine.heartbeat('job_race', 'worker-a', 1, 60_000, { now: at(60_001) })).toBe(false);
    await expect(engine.submitForValidation('job_race', 'worker-a', 1, { now: at(60_001), outputs: [{ name: 'job-output/job_race/1/build-candidate', version: 1 }] })).rejects.toBeInstanceOf(JobStateConflict);

    const current = await engine.claim('worker-b', 'terra', { jobId: 'job_race', leaseMs: 60_000, now: at(60_002) });
    expect(current).toMatchObject({ state: 'running', attempt: 2, lease: { holder: 'worker-b' } });

    // After the re-claim: another holder, or the same worker id on a stale attempt.
    await expect(engine.submitForValidation('job_race', 'worker-a', 1, { now: at(60_003), outputs: [{ name: 'job-output/job_race/1/build-candidate', version: 1 }] })).rejects.toBeInstanceOf(JobLeaseConflict);
    expect(await engine.heartbeat('job_race', 'worker-a', 1, 60_000, { now: at(60_003) })).toBe(false);
    await expect(engine.fail('job_race', 'late', 'worker-a', 1, { now: at(60_003) })).rejects.toBeInstanceOf(JobLeaseConflict);
    await expect(engine.submitForValidation('job_race', 'worker-b', 1, { now: at(60_003) })).rejects.toBeInstanceOf(JobAttemptConflict);

    const submitted = await engine.submitForValidation('job_race', 'worker-b', 2, { now: at(60_004), outputs: [{ name: 'job-output/job_race/2/build-candidate', version: 1 }] });
    expect(submitted).toMatchObject({ state: 'validating', attempt: 2, executionOutputs: [{ name: 'job-output/job_race/2/build-candidate', version: 1 }] });
    // The dead attempt's candidate is attached nowhere, and acceptance is bound to the current attempt's outputs.
    await expect(engine.accept('job_race', 'harness', { expectedAttempt: 1, expectedOutputs: [{ name: 'job-output/job_race/1/build-candidate', version: 1 }] })).rejects.toThrow();
    expect((await store.jobs.findOne({ _id: 'job_race' }))?.state).toBe('validating');
  });
});
