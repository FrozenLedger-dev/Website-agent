import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rolesForTier, type JobOrigin, type JobSpec, type WorkerRole } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import {
  DEFAULT_LEASE_MS,
  JobEngine,
  JobRunner,
  JobRunnerConfigError,
  type JobHandler,
  type JobWorkerIdentity,
} from '../src/index.js';

const PROJECT = 'proj_runner_test';
const PROJECT_OTHER = 'proj_runner_test_other';

const TERRA_ID: JobWorkerIdentity = { workerId: 'terra-1', tier: 'terra' };
const TERRA_ALL_ROLES: WorkerRole[] = rolesForTier('terra');
const T0 = new Date('2030-01-01T00:00:00.000Z');
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;

let store: StateStore;
let engine: JobEngine;

const spec = (jobId: string, output: string[], role: WorkerRole = 'frontend_backend', projectId = PROJECT): JobSpec => ({
  projectId,
  jobId,
  role,
  objective: `do ${jobId}`,
  inputs: {},
  acceptanceCriteria: ['done'],
  allowedTools: [],
  output,
});

const repairOrigin = (parentJobId: string): JobOrigin => ({
  kind: 'repair',
  defectFingerprint: 'fp1',
  reviewCycle: 0,
  parentJobId,
});

function fullTerraHandlers(impl: JobHandler = async () => {}): Map<WorkerRole, JobHandler> {
  const handlers = new Map<WorkerRole, JobHandler>();
  for (const role of rolesForTier('terra')) handlers.set(role, impl);
  return handlers;
}

/** A full, valid Terra handler registry with `frontend_backend` replaced by the one under test. */
function terraHandlers(frontendBackendHandler: JobHandler): Map<WorkerRole, JobHandler> {
  const handlers = fullTerraHandlers();
  handlers.set('frontend_backend', frontendBackendHandler);
  return handlers;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A clock the test controls, so lease-expiry maths never depends on real wall time. */
class ManualClock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now = (): Date => this.current;
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * A `sleep` the test drives by hand: each call parks until `tick()` releases
 * it (or its signal aborts), so a heartbeat iteration only happens when the
 * test says so — no real timers, no flakiness from scheduler luck.
 */
class ManualScheduler {
  private waiters: Array<() => void> = [];

  sleep = (_ms: number, signal?: AbortSignal): Promise<void> => {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };
      this.waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  pendingCount(): number {
    return this.waiters.length;
  }

  async tick(): Promise<void> {
    const wake = this.waiters.shift();
    if (!wake) throw new Error('ManualScheduler.tick: no pending sleep to wake');
    wake();
    await Promise.resolve();
    await Promise.resolve();
  }
}

/** Heartbeats fail on demand, everything else delegates to the real engine. */
class HeartbeatFailureEngine extends JobEngine {
  private armed = false;

  arm(): void {
    this.armed = true;
  }

  override async heartbeat(
    jobId: string,
    workerId: string,
    leaseMs: number = DEFAULT_LEASE_MS,
    options: { now?: Date } = {},
  ): Promise<boolean> {
    if (this.armed) {
      this.armed = false;
      throw new Error('mongo unavailable');
    }
    return super.heartbeat(jobId, workerId, leaseMs, options);
  }
}

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

describe('construction', () => {
  it('rejects a non-positive lease', () => {
    expect(
      () =>
        new JobRunner({ engine, identity: TERRA_ID, claimableRoles: TERRA_ALL_ROLES, handlers: fullTerraHandlers(), leaseMs: 0 }),
    ).toThrow(JobRunnerConfigError);
  });

  it('rejects a non-positive heartbeat interval', () => {
    expect(
      () =>
        new JobRunner({
          engine,
          identity: TERRA_ID,
          claimableRoles: TERRA_ALL_ROLES,
          handlers: fullTerraHandlers(),
          heartbeatEveryMs: 0,
        }),
    ).toThrow(JobRunnerConfigError);
  });

  it('rejects a heartbeat interval that does not stay under the lease', () => {
    expect(
      () =>
        new JobRunner({
          engine,
          identity: TERRA_ID,
          claimableRoles: TERRA_ALL_ROLES,
          handlers: fullTerraHandlers(),
          leaseMs: 1000,
          heartbeatEveryMs: 1000,
        }),
    ).toThrow(JobRunnerConfigError);
  });

  it('refuses to construct a Sol execution runner, since Sol has no executable roles', () => {
    expect(
      () =>
        new JobRunner({
          engine,
          identity: { workerId: 'sol-1', tier: 'sol' },
          claimableRoles: ['repair'],
          handlers: new Map(),
        }),
    ).toThrow(JobRunnerConfigError);
  });

  it('fails before claiming anything when a role handler its tier may run is missing', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });

    const incomplete = fullTerraHandlers();
    incomplete.delete('qa_review');

    expect(
      () => new JobRunner({ engine, identity: TERRA_ID, claimableRoles: TERRA_ALL_ROLES, handlers: incomplete }),
    ).toThrow(/qa_review/);

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('ready');
    expect(job?.attempt).toBe(0);
    expect(job?.lease).toBeNull();
    expect(await store.auditLog.countDocuments({ jobId: 'job_a' })).toBe(0);
  });
});

describe('idle', () => {
  it('returns idle and never invokes a handler when nothing is claimable', async () => {
    let called = false;
    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: fullTerraHandlers(async () => {
        called = true;
      }),
    });

    expect(await runner.runOnce()).toEqual({ kind: 'idle' });
    expect(called).toBe(false);
  });
});

describe('fixed identity claims only its tier’s roles', () => {
  it('a Terra runner claims a Terra job', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: fullTerraHandlers(),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    expect((await runner.runOnce()).kind).toBe('submitted');
  });

  it('a Luna runner claims the repair job, never the Terra job, regardless of call arguments', async () => {
    await engine.enqueue({ spec: spec('job_build', ['src/a.tsx']), origin: { kind: 'plan' } });
    await engine.enqueue({ spec: spec('job_repair', ['src/b.tsx'], 'repair'), origin: repairOrigin('job_build') });

    const luna = new JobRunner({
      engine,
      identity: { workerId: 'luna-1', tier: 'luna' },
      claimableRoles: ['repair'],
      handlers: new Map<WorkerRole, JobHandler>([['repair', async () => {}]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await luna.runOnce({ projectId: PROJECT });
    expect(result).toMatchObject({ kind: 'submitted', jobId: 'job_repair', role: 'repair' });
  });

  it('honours the project scope option, exactly as claim() does', async () => {
    await engine.enqueue({ spec: spec('job_here', ['src/a.tsx'], 'frontend_backend', PROJECT), origin: { kind: 'plan' } });
    await engine.enqueue({
      spec: spec('job_elsewhere', ['src/b.tsx'], 'frontend_backend', PROJECT_OTHER),
      origin: { kind: 'plan' },
    });

    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: fullTerraHandlers(),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce({ projectId: PROJECT });
    expect(result).toMatchObject({ kind: 'submitted', jobId: 'job_here' });

    const elsewhere = await store.jobs.findOne({ _id: 'job_elsewhere' });
    expect(elsewhere?.state).toBe('ready');
  });
});

/**
 * `identity.tier` is the maximum authority a worker of that tier could ever
 * have. `claimableRoles` is this runner's own fixed, narrower subset of it —
 * what lets a specialised worker (a Terra build worker with code for only
 * `frontend_backend`, say) exist without a fake or throwing-stub handler for
 * every other role Terra is merely permitted to run.
 */
describe('role-scoped worker capabilities', () => {
  it('constructs a specialised Terra runner with only the handler its one claimable role needs', () => {
    expect(
      () =>
        new JobRunner({
          engine,
          identity: { workerId: 'terra-build-1', tier: 'terra' },
          claimableRoles: ['frontend_backend'],
          handlers: new Map<WorkerRole, JobHandler>([['frontend_backend', async () => {}]]),
        }),
    ).not.toThrow();
  });

  it('fails construction when a claimable role in a narrower subset has no handler', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx'], 'frontend_backend'), origin: { kind: 'plan' } });

    expect(
      () =>
        new JobRunner({
          engine,
          identity: { workerId: 'terra-build-1', tier: 'terra' },
          claimableRoles: ['frontend_backend', 'qa_review'],
          handlers: new Map<WorkerRole, JobHandler>([['frontend_backend', async () => {}]]),
        }),
    ).toThrow(JobRunnerConfigError);

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('ready');
    expect(job?.attempt).toBe(0);
    expect(job?.lease).toBeNull();
  });

  it('never claims a role outside claimableRoles even when a handler for it is registered', async () => {
    await engine.enqueue({ spec: spec('job_review', ['src/a.tsx'], 'qa_review'), origin: { kind: 'plan' } });

    // Both roles have handlers; only frontend_backend is claimable. A handler
    // being registered must not be what grants authority to claim its role.
    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-build-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map<WorkerRole, JobHandler>([
        ['frontend_backend', async () => {}],
        ['qa_review', async () => {}],
      ]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    expect(await runner.runOnce()).toEqual({ kind: 'idle' });

    const job = await store.jobs.findOne({ _id: 'job_review' });
    expect(job?.state).toBe('ready');
  });

  it('rejects a claimableRoles entry outside the identity’s tier at construction', () => {
    expect(
      () =>
        new JobRunner({
          engine,
          identity: TERRA_ID,
          claimableRoles: ['repair'],
          handlers: new Map<WorkerRole, JobHandler>([['repair', async () => {}]]),
        }),
    ).toThrow(JobRunnerConfigError);
  });

  it('rejects an empty claimableRoles at construction', () => {
    expect(
      () =>
        new JobRunner({
          engine,
          identity: TERRA_ID,
          claimableRoles: [],
          handlers: fullTerraHandlers(),
        }),
    ).toThrow(JobRunnerConfigError);
  });

  it('canonicalises duplicate claimableRoles entries rather than erroring', () => {
    expect(
      () =>
        new JobRunner({
          engine,
          identity: { workerId: 'terra-build-1', tier: 'terra' },
          claimableRoles: ['frontend_backend', 'frontend_backend'],
          handlers: new Map<WorkerRole, JobHandler>([['frontend_backend', async () => {}]]),
        }),
    ).not.toThrow();
  });

  it('has no per-call way to widen capability: runOnce only ever takes a project scope', async () => {
    await engine.enqueue({ spec: spec('job_review', ['src/a.tsx'], 'qa_review'), origin: { kind: 'plan' } });

    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-build-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map<WorkerRole, JobHandler>([['frontend_backend', async () => {}]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    // The only parameter runOnce accepts is a project scope — see its type in
    // runner.ts (`{ projectId?: string }`). There is no roles/tier/workerId
    // field to pass here even if a caller wanted to widen this call.
    expect(await runner.runOnce({ projectId: PROJECT })).toEqual({ kind: 'idle' });
  });

  it('ignores an out-of-contract roles field a caller sneaks into runOnce’s options', async () => {
    // runOnce's TypeScript type has no `roles` field at all, so this can only
    // be reached by bypassing the type system — exactly what a caller who
    // insisted on widening one call would have to do. It must still do
    // nothing: the runner reads only `this.claimableRoles`, never anything
    // off the options bag.
    await engine.enqueue({ spec: spec('job_review', ['src/a.tsx'], 'qa_review'), origin: { kind: 'plan' } });

    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-build-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map<WorkerRole, JobHandler>([['frontend_backend', async () => {}]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const sneaky = { projectId: PROJECT, roles: ['qa_review'] } as unknown as { projectId?: string };
    expect(await runner.runOnce(sneaky)).toEqual({ kind: 'idle' });

    const job = await store.jobs.findOne({ _id: 'job_review' });
    expect(job?.state).toBe('ready');
  });

  it('runs the full 5c lifecycle unchanged for a specialised single-role runner', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx'], 'frontend_backend'), origin: { kind: 'plan' } });
    let calls = 0;

    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-build-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map<WorkerRole, JobHandler>([
        [
          'frontend_backend',
          async () => {
            calls++;
          },
        ],
      ]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce();
    expect(result).toEqual({ kind: 'submitted', jobId: 'job_a', role: 'frontend_backend', attempt: 1 });
    expect(calls).toBe(1);

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('validating');
    expect(job?.lease).toBeNull();
  });
});

describe('handler dispatch', () => {
  it('invokes exactly the handler registered for the claimed role', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx'], 'frontend_backend'), origin: { kind: 'plan' } });

    const calledRoles: WorkerRole[] = [];
    const handlers = new Map<WorkerRole, JobHandler>();
    for (const role of rolesForTier('terra')) {
      handlers.set(role, async () => {
        calledRoles.push(role);
      });
    }

    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers,
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    await runner.runOnce();
    expect(calledRoles).toEqual(['frontend_backend']);
  });
});

describe('success path', () => {
  it('moves ready -> running -> validating, without accepting, using the fixed identity throughout', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    let calls = 0;
    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(async () => {
        calls++;
      }),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce();
    expect(result).toEqual({ kind: 'submitted', jobId: 'job_a', role: 'frontend_backend', attempt: 1 });
    expect(calls).toBe(1);

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('validating');
    expect(job?.lease).toBeNull();

    const events = await store.auditLog.find({ jobId: 'job_a' }).sort({ at: 1 }).toArray();
    expect(events.map((e) => e.detail['to'])).toEqual(['running', 'validating']);
    expect(events.every((e) => e.actor === 'terra-1')).toBe(true);
  });
});

describe('handler failure path', () => {
  it('reports failure through fail(), preserving retry, without fail() itself incrementing attempt', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' }, maxAttempts: 2 });
    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(async () => {
        throw new Error('build broke');
      }),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce();
    expect(result).toEqual({ kind: 'handler_failed', jobId: 'job_a', jobState: 'ready', attempt: 1 });

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('ready');
    expect(job?.attempt).toBe(1);
    expect(job?.failure?.message).toBe('build broke');
  });

  it('converts a non-Error throw to a stable string message rather than persisting the raw value', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' }, maxAttempts: 2 });
    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(async () => {
        throw 'raw string rejection';
      }),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    await runner.runOnce();
    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.failure?.message).toBe('raw string rejection');
  });

  it('leaves the job failed, with no automatic extra retry, once attempts are exhausted', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' }, maxAttempts: 1 });
    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(async () => {
        throw new Error('build broke again');
      }),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce();
    expect(result).toEqual({ kind: 'handler_failed', jobId: 'job_a', jobState: 'failed', attempt: 1 });

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('failed');
  });
});

describe('heartbeats', () => {
  it('extends the lease past its original expiry while the handler is still running (a specialised, role-narrowed runner)', async () => {
    // Deliberately a single-role runner, not a full-tier one: role narrowing
    // (5d) must not disturb any part of the 5c heartbeat runtime it sits on.
    const clock = new ManualClock(T0);
    const scheduler = new ManualScheduler();
    const gate = deferred<void>();

    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx'], 'frontend_backend'), origin: { kind: 'plan' } });

    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-build-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map<WorkerRole, JobHandler>([
        [
          'frontend_backend',
          async () => {
            await gate.promise;
          },
        ],
      ]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: clock.now,
      sleep: scheduler.sleep,
    });

    const resultPromise = runner.runOnce();

    await waitUntil(() => scheduler.pendingCount() > 0);
    const beforeHeartbeat = await store.jobs.findOne({ _id: 'job_a' });
    const originalExpiry = beforeHeartbeat!.lease!.expiresAt;
    expect(originalExpiry.getTime()).toBe(T0.getTime() + LEASE_MS);

    clock.advance(HEARTBEAT_MS);
    await scheduler.tick();
    await waitUntil(async () => {
      const doc = await store.jobs.findOne({ _id: 'job_a' });
      return (doc?.lease?.expiresAt.getTime() ?? 0) > originalExpiry.getTime();
    });

    const afterHeartbeat = await store.jobs.findOne({ _id: 'job_a' });
    expect(afterHeartbeat!.lease!.expiresAt.getTime()).toBe(clock.now().getTime() + LEASE_MS);
    expect(await engine.reclaimExpiredLeases(originalExpiry)).toBe(0);
    expect((await store.jobs.findOne({ _id: 'job_a' }))?.lease?.holder).toBe('terra-build-1');

    gate.resolve();
    const result = await resultPromise;
    expect(result).toEqual({ kind: 'submitted', jobId: 'job_a', role: 'frontend_backend', attempt: 1 });
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('aborts the handler and reports authority_lost when a heartbeat finds the lease already gone', async () => {
    const clock = new ManualClock(T0);
    const scheduler = new ManualScheduler();
    let observedAbort = false;
    const handlerDone = deferred<void>();

    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });

    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(
        (_job, ctx) =>
          new Promise((resolve) => {
            const onAbort = () => {
              observedAbort = true;
              resolve();
              handlerDone.resolve();
            };
            if (ctx.signal.aborted) onAbort();
            else ctx.signal.addEventListener('abort', onAbort, { once: true });
          }),
      ),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: clock.now,
      sleep: scheduler.sleep,
    });

    const resultPromise = runner.runOnce();
    await waitUntil(() => scheduler.pendingCount() > 0);

    // Simulate the reaper reclaiming this worker's lease, then a second
    // compatible worker taking the job over, before the next heartbeat.
    clock.advance(LEASE_MS + 1);
    expect(await engine.reclaimExpiredLeases(clock.now())).toBe(1);
    const replacement = await engine.claim('terra-2', 'terra', { now: clock.now(), leaseMs: LEASE_MS });
    expect(replacement?._id).toBe('job_a');

    await scheduler.tick();
    await handlerDone.promise;
    const result = await resultPromise;

    expect(result).toEqual({ kind: 'authority_lost', jobId: 'job_a', reason: 'heartbeat_lost' });
    expect(observedAbort).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('running');
    expect(job?.lease?.holder).toBe('terra-2');
    expect(job?.attempt).toBe(2);
    expect(job?.failure ?? null).toBeNull();
  });

  it('fails closed when the heartbeat call itself throws, surfacing the error rather than a job outcome', async () => {
    const clock = new ManualClock(T0);
    const scheduler = new ManualScheduler();
    const gate = deferred<void>();
    let observedAbort = false;

    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    const failingEngine = new HeartbeatFailureEngine(store);

    const runner = new JobRunner({
      engine: failingEngine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(
        (_job, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener(
              'abort',
              () => {
                observedAbort = true;
              },
              { once: true },
            );
            gate.promise.then(resolve);
          }),
      ),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: clock.now,
      sleep: scheduler.sleep,
    });

    const resultPromise = runner.runOnce();
    resultPromise.catch(() => {}); // observed via the assertion below; suppress unhandled-rejection noise

    await waitUntil(() => scheduler.pendingCount() > 0);
    failingEngine.arm();
    await scheduler.tick();
    await waitUntil(() => observedAbort);
    gate.resolve();

    await expect(resultPromise).rejects.toThrow('mongo unavailable');

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('running');
    expect(job?.lease?.holder).toBe('terra-1');
    expect(job?.failure ?? null).toBeNull();
  });

  it('leaves no heartbeat loop running once runOnce has returned', async () => {
    const scheduler = new ManualScheduler();
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });

    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(async () => {}),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: scheduler.sleep,
    });

    await runner.runOnce();
    expect(scheduler.pendingCount()).toBe(0);
    await expect(scheduler.tick()).rejects.toThrow(/no pending sleep/);
  });
});

describe('stale execution cannot damage a replacement worker', () => {
  it('a stale successful handler cannot overwrite the replacement holding the job', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });

    // The handler simulates the exact window Phase 5a's guard exists for:
    // this execution's own lease is stolen while it is still "finishing".
    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(async () => {
        await engine.reclaimExpiredLeases(new Date(T0.getTime() + LEASE_MS + 1));
        await engine.claim('terra-2', 'terra', { now: new Date(T0.getTime() + LEASE_MS + 1), leaseMs: LEASE_MS });
      }),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce();
    expect(result).toEqual({ kind: 'authority_lost', jobId: 'job_a', reason: 'transition_conflict' });

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('running');
    expect(job?.lease?.holder).toBe('terra-2');
    expect(job?.attempt).toBe(2);

    const events = await store.auditLog.find({ jobId: 'job_a' }).sort({ at: 1 }).toArray();
    expect(events.map((e) => e.detail['to'])).toEqual(['running', 'ready', 'running']);
  });

  it('a stale handler failure cannot touch the replacement’s failure field, lease or attempt', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' }, maxAttempts: 5 });

    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(async () => {
        await engine.reclaimExpiredLeases(new Date(T0.getTime() + LEASE_MS + 1));
        await engine.claim('terra-2', 'terra', { now: new Date(T0.getTime() + LEASE_MS + 1), leaseMs: LEASE_MS });
        throw new Error('handler blew up after losing the race');
      }),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce();
    expect(result).toEqual({ kind: 'authority_lost', jobId: 'job_a', reason: 'transition_conflict' });

    const job = await store.jobs.findOne({ _id: 'job_a' });
    expect(job?.state).toBe('running');
    expect(job?.lease?.holder).toBe('terra-2');
    expect(job?.attempt).toBe(2);
    expect(job?.failure ?? null).toBeNull();
  });
});

describe('production defaults', () => {
  it('runs end to end with real timers and no injected seams', async () => {
    await engine.enqueue({ spec: spec('job_a', ['src/a.tsx']), origin: { kind: 'plan' } });
    const runner = new JobRunner({
      engine,
      identity: TERRA_ID,
      claimableRoles: TERRA_ALL_ROLES,
      handlers: terraHandlers(async () => {}),
      leaseMs: 300,
    });

    const result = await runner.runOnce();
    expect(result).toEqual({ kind: 'submitted', jobId: 'job_a', role: 'frontend_backend', attempt: 1 });
  });
});

/**
 * A behavioural guard (`never claims a role outside claimableRoles even when
 * a handler for it is registered`, above) already proves the narrowing
 * holds. This reads the source back too, so a future edit that reintroduces
 * `rolesForTier(identity.tier)` in place of `this.claimableRoles` — one that
 * happens to still pass the behavioural test because nothing exercised the
 * gap that call would reopen — fails immediately and by name instead.
 */
describe('claimableRoles is what reaches claim(), structurally', () => {
  it('runOnce forwards claimableRoles, not the tier’s full role set, to engine.claim()', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const runnerSrc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runner.ts'),
      'utf8',
    );

    expect(runnerSrc).toMatch(/roles:\s*this\.claimableRoles/);
    expect(runnerSrc).not.toMatch(/roles:\s*rolesForTier\(/);
  });
});
