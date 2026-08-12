import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobSpec } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { JobEngine, JobStateConflict } from '../src/index.js';

const PROJECT = 'proj_engine_test';

let store: StateStore;
let engine: JobEngine;

const spec = (jobId: string, output: string[]): JobSpec => ({
  projectId: PROJECT,
  jobId,
  role: 'frontend_backend',
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

    const claimed = await engine.claim('worker-1');
    expect(claimed?._id).toBe('job_a');
    expect(claimed?.state).toBe('running');
    expect(claimed?.lease?.holder).toBe('worker-1');
    expect(claimed?.attempt).toBe(1);
  });

  it('returns null when nothing is runnable', async () => {
    expect(await engine.claim('worker-1')).toBeNull();
  });

  it('never hands the same job to two workers', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });

    const [first, second] = await Promise.all([engine.claim('worker-1'), engine.claim('worker-2')]);
    const claimed = [first, second].filter(Boolean);
    expect(claimed).toHaveLength(1);
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
    const first = await engine.claim('worker-1');
    expect(first?._id).toBe('job_base');
    expect(await engine.claim('worker-2')).toBeNull();

    await engine.submitForValidation('job_base', 'worker-1');
    await engine.accept('job_base', 'sol');

    const second = await engine.claim('worker-2');
    expect(second?._id).toBe('job_dependent');
  });
});

describe('output conflict serialisation', () => {
  it('refuses to run two jobs that write the same file', async () => {
    await engine.enqueue({ spec: spec('job_x', ['src/shared.tsx']), origin: { kind: 'plan' } });
    await engine.enqueue({ spec: spec('job_y', ['src/shared.tsx', 'src/other.tsx']), origin: { kind: 'plan' } });

    expect((await engine.claim('worker-1'))?._id).toBe('job_x');
    expect(await engine.claim('worker-2')).toBeNull();

    await engine.submitForValidation('job_x', 'worker-1');
    await engine.accept('job_x', 'sol');
    expect((await engine.claim('worker-2'))?._id).toBe('job_y');
  });

  it('runs disjoint jobs in parallel', async () => {
    await engine.enqueue({ spec: spec('job_p', ['src/p.tsx']), origin: { kind: 'plan' } });
    await engine.enqueue({ spec: spec('job_q', ['src/q.tsx']), origin: { kind: 'plan' } });

    expect((await engine.claim('worker-1'))?._id).toBe('job_p');
    expect((await engine.claim('worker-2'))?._id).toBe('job_q');
  });
});

describe('lifecycle', () => {
  it('rejects an illegal transition rather than silently applying it', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1');
    // running -> accepted skips validation entirely.
    await expect(engine.accept('job_a', 'sol')).rejects.toBeInstanceOf(JobStateConflict);
  });

  it('retries a failed job while attempts remain, then gives up', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' }, maxAttempts: 2 });

    await engine.claim('worker-1');
    const first = await engine.fail('job_a', 'build error', 'worker-1');
    expect(first.state).toBe('ready');

    await engine.claim('worker-1');
    const second = await engine.fail('job_a', 'build error again', 'worker-1');
    expect(second.state).toBe('failed');
    expect(second.attempt).toBe(2);
  });

  it('records every transition in the audit log', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1');
    await engine.submitForValidation('job_a', 'worker-1');
    await engine.accept('job_a', 'sol');

    const events = await store.auditLog.find({ jobId: 'job_a' }).sort({ at: 1 }).toArray();
    expect(events.map((e) => e.detail['to'])).toEqual(['running', 'validating', 'accepted']);
  });
});

describe('lease reclamation', () => {
  it('returns a crashed worker’s job to the ready pool', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1', { leaseMs: 1 });

    const later = new Date(Date.now() + 60_000);
    expect(await engine.reclaimExpiredLeases(later)).toBe(1);

    const reclaimed = await engine.claim('worker-2');
    expect(reclaimed?._id).toBe('job_a');
    expect(reclaimed?.attempt).toBe(2);
  });

  it('leaves a live lease alone', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1', { leaseMs: 60_000 });
    expect(await engine.reclaimExpiredLeases(new Date())).toBe(0);
  });

  it('refuses a heartbeat from a worker that lost its lease', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.claim('worker-1', { leaseMs: 1 });
    await engine.reclaimExpiredLeases(new Date(Date.now() + 60_000));

    expect(await engine.heartbeat('job_a', 'worker-1')).toBe(false);
  });
});
