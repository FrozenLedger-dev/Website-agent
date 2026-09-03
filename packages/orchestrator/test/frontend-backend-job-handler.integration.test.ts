/**
 * The first production JobHandler, exercised through the real pipeline.
 *
 * Only the model boundary is faked: a `Provider` implementation, not
 * `@statxai/agents` itself, so `ModelClient`, `buildSite`, `buildAnchor`,
 * `routeBuild` and the shared `buildFromPlan` primitive all run for real.
 * `createTerraFrontendBackendHandler` is the actual production handler, not a
 * stub — proving that is most of what this file exists to do.
 *
 * Integration: needs the Mongo replica set and a real (temp) Git workspace.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import { ModelClient, type Provider, type ProviderRequest, type ProviderResponse } from '@statxai/agents';
import { JobEngine, JobLeaseConflict, JobRunner } from '@statxai/job-engine';
import type { ArtifactRef, JobSpec, SitePlan } from '@statxai/contracts';
import { discoverProject } from '../src/phases/discover.js';
import {
  createTerraFrontendBackendHandler,
  FRONTEND_BACKEND_INPUT,
  FrontendBackendInputInvalid,
  FrontendBackendRoleMismatch,
  type FrontendBackendHandlerDeps,
} from '../src/job-handlers/frontend-backend.js';

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const T0 = new Date('2030-01-01T00:00:00.000Z');

let store: StateStore;
let registry: ArtifactRegistry;
let engine: JobEngine;
let workspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  engine = new JobEngine(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-handler-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTAKE = {
  businessName: 'Harrowgate Joinery',
  industry: 'Joinery',
  location: 'Harrogate',
  audience: 'Homeowners',
  services: [{ name: 'Wardrobes', description: 'Fitted wardrobes.' }],
  differentiators: ['Two joiners'],
  contact: { email: 'workshop@harrowgatejoinery.co.uk', phone: '01423 887 214' },
  tone: 'Warm',
  goals: ['Enquiries'],
};

const onePagePlan = (marker: string): SitePlan =>
  ({
    strategy: 's',
    valueProposition: `v-${marker}`,
    brandSystem: {
      palette: { background: '#fff', surface: '#fff', text: '#111', muted: '#ccc', accent: '#0a0', accentText: '#fff', border: '#ddd' },
      typography: { headingFamily: 'Inter', bodyFamily: 'Inter', baseSize: '16px', scale: '1.2' },
      artDirection: `direction-${marker}`,
      radius: 'square',
      rationale: 'r',
    },
    sitemap: { pages: [{ route: '/', title: 'Home', metaDescription: 'd', goal: 'g', primaryAction: 'call', sections: [{ id: 'hero', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }] }] },
    acceptanceCriteria: ['a', 'b', 'c'],
  }) as unknown as SitePlan;

/** Every field this handler needs, standing the project up through the real discovery phase. */
async function setupProject(projectId: string): Promise<ArtifactRef> {
  const result = await discoverProject({
    projectId,
    intake: INTAKE,
    store,
    registry,
    workspacesRoot,
    autonomyMode: 'full_autonomous',
    say: () => {},
  });
  if (!result.ok) throw new Error('fixture setup: discoverProject refused the fixture intake');
  const profileDoc = await store.artifacts.findOne(
    { projectId, name: 'business-profile' },
    { sort: { version: -1 } },
  );
  return { name: 'business-profile', version: profileDoc!.version };
}

async function putPlan(projectId: string, plan: SitePlan): Promise<ArtifactRef> {
  const ref = await registry.put(projectId, 'site-plan', plan);
  await registry.accept(projectId, ref);
  return ref;
}

function jobSpec(projectId: string, jobId: string, profileRef: ArtifactRef, planRef: ArtifactRef): JobSpec {
  return {
    projectId,
    jobId,
    role: 'frontend_backend',
    objective: 'Build the site from the approved plan.',
    inputs: { [FRONTEND_BACKEND_INPUT.businessProfile]: profileRef, [FRONTEND_BACKEND_INPUT.sitePlan]: planRef },
    acceptanceCriteria: ['site files written from the approved plan'],
    allowedTools: [],
    output: ['app/page.tsx'],
  };
}

function handlerDeps(model: ModelClient, overrides: Partial<FrontendBackendHandlerDeps> = {}): FrontendBackendHandlerDeps {
  return { store, registry, model, workspacesRoot, ...overrides };
}

// ---------------------------------------------------------------------------
// The model boundary — the only thing this file fakes.
// ---------------------------------------------------------------------------

class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly schemaDialect = 'standard' as const;
  constructor(private readonly respond: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>) {}
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    return this.respond(request);
  }
}

const solRouteOneShot = (): ProviderResponse => ({
  text: JSON.stringify({ action: 'one_shot', reason: 'single-page plan', confidence: 0.95, workstreams: null }),
  model: 'fake-sol',
  inputTokens: 1,
  outputTokens: 1,
  stopReason: 'complete',
});

const buildOutput = (files: { path: string; contents: string }[]): ProviderResponse => ({
  text: JSON.stringify({ files, notes: 'test fixture' }),
  model: 'fake-terra',
  inputTokens: 1,
  outputTokens: 1,
  stopReason: 'complete',
});

/** Routes by the two calls this build makes; anything else is a test bug. */
function routingModel(terraBuild: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>): ModelClient {
  return new ModelClient(
    new FakeProvider((request) => {
      if (request.schemaName.startsWith('sol_route')) return solRouteOneShot();
      if (request.schemaName.startsWith('terra_build')) return terraBuild(request);
      throw new Error(`unexpected model call in test: ${request.schemaName}`);
    }),
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
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

/** Same pattern as job-engine's own runner tests: a `sleep` the test drives by hand. */
class ManualScheduler {
  private waiters: Array<() => void> = [];
  sleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        this.waiters = this.waiters.filter((w) => w !== wake);
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

// ---------------------------------------------------------------------------

describe('the real handler, run through JobRunner', () => {
  it('builds the real site through the shared production primitive, and finishes validating', async () => {
    const projectId = 'proj_fb_lifecycle';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('lifecycle'));
    await engine.enqueue({ spec: jobSpec(projectId, 'job_fb_1', profileRef, planRef), origin: { kind: 'plan' } });

    const model = routingModel(() => buildOutput([{ path: 'app/page.tsx', contents: 'export default function Home(){return null}' }]));
    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-frontend-backend-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map([['frontend_backend', createTerraFrontendBackendHandler(handlerDeps(model))]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce({ projectId });
    expect(result).toEqual({ kind: 'submitted', jobId: 'job_fb_1', role: 'frontend_backend', attempt: 1 });

    const job = await store.jobs.findOne({ _id: 'job_fb_1' });
    expect(job?.state).toBe('validating');
    expect(job?.lease).toBeNull();
    expect(job?.state).not.toBe('accepted');

    // The real output of the real build primitive: a file on disk, written by
    // ProjectWorkspace.writeSiteFiles, not a value invented by this test.
    const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
    // ProjectWorkspace.siteRoot is itself a Next.js project root (scaffolded
    // by scaffoldSite), so a generated file's path — "app/page.tsx", exactly
    // what routeToSourcePath('/') gives real Terra — is relative to *that*,
    // landing at <siteRoot>/app/page.tsx.
    expect(await ws.readSiteFile('app/page.tsx')).toBe('export default function Home(){return null}');
    expect(await ws.currentCommit()).not.toBeNull();

    // The route decision Sol actually made is on record too.
    const routeDecision = await registry.get<{ strategy: string }>(projectId, 'route-decision');
    expect(routeDecision.strategy).toBe('one_shot');
  });

  it('rejects a job whose role is not frontend_backend, without touching the job', async () => {
    const projectId = 'proj_fb_role_guard';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('guard'));
    const model = routingModel(() => buildOutput([{ path: 'app/page.tsx', contents: 'x' }]));
    const handler = createTerraFrontendBackendHandler(handlerDeps(model));

    const wrongRoleJob = await engine.enqueue({
      spec: { ...jobSpec(projectId, 'job_wrong_role', profileRef, planRef), role: 'qa_review' },
      origin: { kind: 'plan' },
    });

    await expect(handler(wrongRoleJob, { signal: new AbortController().signal })).rejects.toBeInstanceOf(
      FrontendBackendRoleMismatch,
    );
  });

  it('fails closed before any model call when a required pinned input is missing', async () => {
    const projectId = 'proj_fb_missing_input';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('missing'));
    let modelCalled = false;
    const model = routingModel(() => {
      modelCalled = true;
      return buildOutput([{ path: 'app/page.tsx', contents: 'x' }]);
    });
    const handler = createTerraFrontendBackendHandler(handlerDeps(model));

    const spec = jobSpec(projectId, 'job_missing_input', profileRef, planRef);
    delete spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan];
    const job = await engine.enqueue({ spec, origin: { kind: 'plan' } });

    await expect(handler(job, { signal: new AbortController().signal })).rejects.toBeInstanceOf(
      FrontendBackendInputInvalid,
    );
    expect(modelCalled).toBe(false);
  });
});

describe('pinned means pinned', () => {
  it('builds from the version the job pinned, even after a newer version exists', async () => {
    const projectId = 'proj_fb_pinned';
    const profileRef = await setupProject(projectId);
    const v1 = await putPlan(projectId, onePagePlan('v1-marker'));
    const job = await engine.enqueue({ spec: jobSpec(projectId, 'job_pinned', profileRef, v1), origin: { kind: 'plan' } });

    // A newer version exists by execution time. The pinned ref must win.
    await putPlan(projectId, onePagePlan('v2-marker'));

    const seenPrompts: string[] = [];
    const model = routingModel((request) => {
      seenPrompts.push(request.prompt);
      return buildOutput([{ path: 'app/page.tsx', contents: 'from-v1' }]);
    });
    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-frontend-backend-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map([['frontend_backend', createTerraFrontendBackendHandler(handlerDeps(model))]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce({ projectId });
    expect(result.kind).toBe('submitted');
    expect(job.spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan]!.version).toBe(1);

    const buildPrompt = seenPrompts.find((p) => p.includes('v-v1-marker') || p.includes('v-v2-marker'));
    expect(buildPrompt).toContain('v-v1-marker');
    expect(buildPrompt).not.toContain('v-v2-marker');
  });
});

describe('a real build failure at the model boundary', () => {
  it('reports it through fail(), preserving retry, and writes no validating transition', async () => {
    const projectId = 'proj_fb_build_fails';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('fails'));
    await engine.enqueue({
      spec: jobSpec(projectId, 'job_fb_fail', profileRef, planRef),
      origin: { kind: 'plan' },
      maxAttempts: 2,
    });

    const model = routingModel(() => {
      throw new Error('terra build rejected: output did not satisfy the schema');
    });
    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-frontend-backend-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map([['frontend_backend', createTerraFrontendBackendHandler(handlerDeps(model))]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce({ projectId });
    expect(result).toEqual({ kind: 'handler_failed', jobId: 'job_fb_fail', jobState: 'ready', attempt: 1 });

    const job = await store.jobs.findOne({ _id: 'job_fb_fail' });
    expect(job?.state).toBe('ready');
    expect(job?.failure?.message).toContain('terra build rejected');

    const events = await store.auditLog.find({ jobId: 'job_fb_fail' }).sort({ at: 1 }).toArray();
    expect(events.map((e) => e.detail['to'])).not.toContain('validating');
  });

  it('leaves the job failed once attempts are exhausted, with no automatic retry', async () => {
    const projectId = 'proj_fb_build_fails_exhausted';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('exhausted'));
    await engine.enqueue({
      spec: jobSpec(projectId, 'job_fb_fail_2', profileRef, planRef),
      origin: { kind: 'plan' },
      maxAttempts: 1,
    });

    const model = routingModel(() => {
      throw new Error('terra build rejected again');
    });
    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-frontend-backend-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map([['frontend_backend', createTerraFrontendBackendHandler(handlerDeps(model))]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const result = await runner.runOnce({ projectId });
    expect(result).toEqual({ kind: 'handler_failed', jobId: 'job_fb_fail_2', jobState: 'failed', attempt: 1 });
    expect((await store.jobs.findOne({ _id: 'job_fb_fail_2' }))?.state).toBe('failed');
  });
});

describe('authority loss prevents durable stale output', () => {
  it('does not persist site files generated after the lease was lost mid-build', async () => {
    const projectId = 'proj_fb_authority_loss';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('stale'));
    await engine.enqueue({ spec: jobSpec(projectId, 'job_fb_stale', profileRef, planRef), origin: { kind: 'plan' } });

    const clock = new ManualClock(T0);
    const scheduler = new ManualScheduler();
    const buildGate = deferred<ProviderResponse>();
    let terraBuildCallStarted = false;

    const model = routingModel((_request) => {
      terraBuildCallStarted = true;
      return buildGate.promise;
    });

    const runner = new JobRunner({
      engine,
      identity: { workerId: 'terra-frontend-backend-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map([['frontend_backend', createTerraFrontendBackendHandler(handlerDeps(model))]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: clock.now,
      sleep: scheduler.sleep,
    });

    const resultPromise = runner.runOnce({ projectId });

    // Wait until the fake model has actually received the terra:build request
    // and the heartbeat loop has started — i.e. until real work is genuinely
    // "in flight", the same state a real Terra call would leave it in.
    await waitUntil(() => terraBuildCallStarted && scheduler.pendingCount() > 0);

    const beforeCommit = await (await ProjectWorkspace.open(projectId, workspacesRoot)).currentCommit();

    // The reaper reclaims the lease, and a second compatible worker takes the
    // job over — exactly the window Phase 5a's guard exists for.
    clock.advance(LEASE_MS + 1);
    expect(await engine.reclaimExpiredLeases(clock.now())).toBe(1);
    const replacement = await engine.claim('terra-frontend-backend-2', 'terra', {
      roles: ['frontend_backend'],
      now: clock.now(),
      leaseMs: LEASE_MS,
    });
    expect(replacement?._id).toBe('job_fb_stale');

    // Wake the heartbeat: it calls the real JobEngine.heartbeat, a genuine
    // Mongo round trip this test cannot directly await (it happens inside
    // JobRunner's private execute()). scheduler.tick() only releases the
    // sleep that precedes that call; a short real wait is what lets it
    // actually finish — and so lets the runner actually abort the handler's
    // signal — before the "model" is allowed to answer. Resolving the gate
    // first would race the abort and could let a stale write through on
    // this very test's own machine, which is the failure mode this test
    // exists to catch in production.
    await scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    buildGate.resolve(buildOutput([{ path: 'app/page.tsx', contents: 'STALE — must never land' }]));

    const result = await resultPromise;
    expect(result).toEqual({ kind: 'authority_lost', jobId: 'job_fb_stale', reason: 'heartbeat_lost' });

    // The critical assertion: the stale generated content never reached disk.
    // app/page.tsx exists regardless — it ships with the scaffolded Next.js
    // template — so the proof is its *content*, not its presence.
    const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
    expect(await ws.readSiteFile('app/page.tsx')).not.toContain('STALE');
    expect(await ws.currentCommit()).toBe(beforeCommit);

    // Runner A neither submitted nor failed; the replacement is untouched.
    const job = await store.jobs.findOne({ _id: 'job_fb_stale' });
    expect(job?.state).toBe('running');
    expect(job?.lease?.holder).toBe('terra-frontend-backend-2');
    expect(job?.attempt).toBe(2);
    expect(job?.failure ?? null).toBeNull();

    await expect(
      engine.submitForValidation('job_fb_stale', 'terra-frontend-backend-1', { now: clock.now() }),
    ).rejects.toBeInstanceOf(JobLeaseConflict);
  });
});
