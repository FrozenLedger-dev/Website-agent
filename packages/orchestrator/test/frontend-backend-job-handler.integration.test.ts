/**
 * The production frontend_backend JobHandler, exercised through the real
 * pipeline — and, since Phase 5f, proven to stage rather than publish.
 *
 * Only the model boundary is faked: a `Provider` implementation, not
 * `@statxai/agents` itself, so `ModelClient`, `buildSite`, `routeBuild` and
 * the shared `prepareBuildFromPlan` primitive all run for real.
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
import { JobEngine, JobRunner, type JobHandler } from '@statxai/job-engine';
import type { ArtifactRef, JobSpec, SitePlan } from '@statxai/contracts';
import type { BuildCandidate } from '../src/phases/build.js';
import { discoverProject } from '../src/phases/discover.js';
import {
  createTerraFrontendBackendHandler,
  frontendBackendCandidateName,
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
  return { registry, model, ...overrides };
}

/** Reads back a staged candidate exactly as the handler wrote it — never "latest", the one exact name. */
async function readCandidate(projectId: string, jobId: string, attempt: number): Promise<BuildCandidate> {
  return registry.get<BuildCandidate>(projectId, frontendBackendCandidateName(jobId, attempt));
}

async function candidateArtifactDoc(projectId: string, jobId: string, attempt: number) {
  return store.artifacts.findOne({ projectId, name: frontendBackendCandidateName(jobId, attempt) });
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

function runnerFor(model: ModelClient, workerId = 'terra-frontend-backend-1', overrides: Partial<{ now: () => Date; sleep: ManualScheduler['sleep']; leaseMs: number; heartbeatEveryMs: number }> = {}) {
  return new JobRunner({
    engine,
    identity: { workerId, tier: 'terra' },
    claimableRoles: ['frontend_backend'],
    handlers: new Map([['frontend_backend', createTerraFrontendBackendHandler(handlerDeps(model))]]),
    leaseMs: LEASE_MS,
    heartbeatEveryMs: HEARTBEAT_MS,
    now: () => T0,
    sleep: new ManualScheduler().sleep,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('the real handler stages, it does not publish', () => {
  it('generates through the shared production primitive, stages the candidate, and finishes validating — without touching the canonical workspace', async () => {
    const projectId = 'proj_fb_lifecycle';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('lifecycle'));
    await engine.enqueue({ spec: jobSpec(projectId, 'job_fb_1', profileRef, planRef), origin: { kind: 'plan' } });

    const model = routingModel(() => buildOutput([{ path: 'app/page.tsx', contents: 'export default function Home(){return null}' }]));
    const runner = runnerFor(model);

    const result = await runner.runOnce({ projectId });
    expect(result).toEqual({ kind: 'submitted', jobId: 'job_fb_1', role: 'frontend_backend', attempt: 1 });

    const job = await store.jobs.findOne({ _id: 'job_fb_1' });
    expect(job?.state).toBe('validating');
    expect(job?.lease).toBeNull();
    expect(job?.state).not.toBe('accepted');

    // Real generation: the staged candidate carries Sol's actual routing
    // decision and Terra's actual generated file, from the shared primitive —
    // not a value this test invented directly.
    expect(job?.executionOutputs).toMatchObject([{ name: frontendBackendCandidateName('job_fb_1', 1), version: 1 }]);
    const candidate = await readCandidate(projectId, 'job_fb_1', 1);
    expect(candidate.routeDecisions).toHaveLength(1);
    expect(candidate.routeDecisions[0]!.strategy).toBe('one_shot');
    expect(candidate.files).toEqual([{ path: 'app/page.tsx', contents: 'export default function Home(){return null}' }]);

    // Staged, not published: unaccepted, and no canonical route-decision
    // artifact exists at all — the handler never calls persistRouteDecision.
    const stagedDoc = await candidateArtifactDoc(projectId, 'job_fb_1', 1);
    expect(stagedDoc?.acceptedAt).toBeNull();
    await expect(registry.get(projectId, 'route-decision')).rejects.toThrow();

    // The canonical project workspace is never opened, let alone written to,
    // by this handler: no commit exists, and the handler never even
    // scaffolded it (only buildFromPlan's direct path does that), so the
    // generated file was never written there at all — not merely
    // overwritten with different content.
    const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
    expect(await ws.currentCommit()).toBeNull();
    await expect(ws.readSiteFile('app/page.tsx')).rejects.toThrow();
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
    const runner = runnerFor(model);

    const result = await runner.runOnce({ projectId });
    expect(result.kind).toBe('submitted');
    expect(job.spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan]!.version).toBe(1);

    const buildPrompt = seenPrompts.find((p) => p.includes('v-v1-marker') || p.includes('v-v2-marker'));
    expect(buildPrompt).toContain('v-v1-marker');
    expect(buildPrompt).not.toContain('v-v2-marker');
  });
});

describe('a real build failure at the model boundary', () => {
  it('reports it through fail(), preserving retry, and attaches no output', async () => {
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
    const runner = runnerFor(model);

    const result = await runner.runOnce({ projectId });
    expect(result).toEqual({ kind: 'handler_failed', jobId: 'job_fb_fail', jobState: 'ready', attempt: 1 });

    const job = await store.jobs.findOne({ _id: 'job_fb_fail' });
    expect(job?.state).toBe('ready');
    expect(job?.failure?.message).toContain('terra build rejected');
    expect(job?.executionOutputs ?? null).toBeNull();

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
    const runner = runnerFor(model);

    const result = await runner.runOnce({ projectId });
    expect(result).toEqual({ kind: 'handler_failed', jobId: 'job_fb_fail_2', jobState: 'failed', attempt: 1 });
    expect((await store.jobs.findOne({ _id: 'job_fb_fail_2' }))?.state).toBe('failed');
  });
});

describe('authority loss prevents durable stale publication', () => {
  it('a same-worker stale attempt that finishes staging after being superseded cannot publish', async () => {
    // The mandatory Phase 5f scenario: not a different worker id, but the
    // exact same fixed identity reclaiming its own job — the case workerId
    // alone was never able to distinguish.
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

    // The SAME fixed identity reclaims its own job — a restarted or
    // reconnected worker process presenting the same workerId, exactly the
    // shape workerId alone cannot tell apart from the execution it replaced.
    clock.advance(LEASE_MS + 1);
    expect(await engine.reclaimExpiredLeases(clock.now())).toBe(1);
    const replacement = await engine.claim('terra-frontend-backend-1', 'terra', {
      roles: ['frontend_backend'],
      now: clock.now(),
      leaseMs: LEASE_MS,
    });
    expect(replacement?._id).toBe('job_fb_stale');
    expect(replacement?.attempt).toBe(2);

    // Wake the heartbeat and let its real Mongo round trip land before the
    // "model" is allowed to answer — see the identical comment in job-engine's
    // own runner tests for why this matters.
    await scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    buildGate.resolve(buildOutput([{ path: 'app/page.tsx', contents: 'STALE — must never publish' }]));

    const result = await resultPromise;
    expect(result).toEqual({ kind: 'authority_lost', jobId: 'job_fb_stale', reason: 'heartbeat_lost' });

    // The stale attempt's own staging namespace may hold orphan garbage —
    // that is allowed — but it must never become this job's output.
    const job = await store.jobs.findOne({ _id: 'job_fb_stale' });
    expect(job?.state).toBe('running');
    expect(job?.attempt).toBe(2);
    expect(job?.lease?.holder).toBe('terra-frontend-backend-1');
    expect(job?.executionOutputs ?? null).toBeNull();
    expect(job?.failure ?? null).toBeNull();

    // Canonical resolution is untouched either way: nothing was ever staged
    // under attempt 1 (the handler never reached that line — it was still
    // waiting on the model when authority was lost), and nothing under
    // attempt 2 either, since the runner never even claimed a token for a
    // *second* execution of this handler in this test.
    await expect(registry.get(projectId, frontendBackendCandidateName('job_fb_stale', 1))).rejects.toThrow();

    const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
    expect(await ws.currentCommit()).toBeNull();
  });

  it('retried attempts stage to distinct namespaces; the failed attempt’s candidate is never attached', async () => {
    // Attempt 1 fails at the model boundary and retries; attempt 2 succeeds.
    // Proves candidate identity is attempt-scoped, not merely job-scoped, and
    // that "the job's output" always means the attempt that actually validated.
    const projectId = 'proj_fb_retry_isolation';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('retry'));
    await engine.enqueue({
      spec: jobSpec(projectId, 'job_fb_retry', profileRef, planRef),
      origin: { kind: 'plan' },
      maxAttempts: 2,
    });

    let call = 0;
    const model = routingModel(() => {
      call += 1;
      if (call === 1) throw new Error('attempt 1: terra build rejected');
      return buildOutput([{ path: 'app/page.tsx', contents: 'attempt-2 content' }]);
    });
    const runner = runnerFor(model);

    const first = await runner.runOnce({ projectId });
    expect(first).toEqual({ kind: 'handler_failed', jobId: 'job_fb_retry', jobState: 'ready', attempt: 1 });

    const second = await runner.runOnce({ projectId });
    expect(second).toEqual({ kind: 'submitted', jobId: 'job_fb_retry', role: 'frontend_backend', attempt: 2 });

    const job = await store.jobs.findOne({ _id: 'job_fb_retry' });
    expect(job?.state).toBe('validating');
    expect(job?.executionOutputs).toMatchObject([{ name: frontendBackendCandidateName('job_fb_retry', 2), version: 1 }]);

    // Attempt 1 never reached staging (it failed inside prepare, before any
    // candidate existed), so its namespace holds nothing at all — and even if
    // it had, a different name is a different name.
    await expect(registry.get(projectId, frontendBackendCandidateName('job_fb_retry', 1))).rejects.toThrow();
    const attempt2Candidate = await readCandidate(projectId, 'job_fb_retry', 2);
    expect(attempt2Candidate.files).toEqual([{ path: 'app/page.tsx', contents: 'attempt-2 content' }]);
  });

  it('an attempt whose staging completes after a newer attempt already validated still cannot become current', async () => {
    // Both candidates genuinely exist, in this order — attempt 1 stages
    // *after* attempt 2 has already validated — and canonical resolution
    // (the job's own executionOutputs) must still name attempt 2. Not
    // "whichever staged last": the guarded transition decides, not timing.
    const projectId = 'proj_fb_ordering';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan('ordering'));
    await engine.enqueue({ spec: jobSpec(projectId, 'job_fb_order', profileRef, planRef), origin: { kind: 'plan' } });

    const staleModel = routingModel(() => buildOutput([{ path: 'app/page.tsx', contents: 'stale content, staged last' }]));
    const staleHandler = createTerraFrontendBackendHandler(handlerDeps(staleModel));

    // Wraps the real handler: after it has finished staging its own
    // candidate (attempt 1), and before returning, a second execution claims
    // and validates the same job to completion under a *different* worker —
    // simulating the job moving on while this execution was still working,
    // without needing to race real timers to get both candidates to exist.
    const wrappedStaleHandler: JobHandler = async (job, ctx) => {
      const staged = await staleHandler(job, ctx);

      const now = new Date(T0.getTime() + LEASE_MS + 1);
      await engine.reclaimExpiredLeases(now);
      const currentModel = routingModel(() => buildOutput([{ path: 'app/page.tsx', contents: 'current content' }]));
      const currentRunner = new JobRunner({
        engine,
        identity: { workerId: 'terra-frontend-backend-2', tier: 'terra' },
        claimableRoles: ['frontend_backend'],
        handlers: new Map([['frontend_backend', createTerraFrontendBackendHandler(handlerDeps(currentModel))]]),
        leaseMs: LEASE_MS,
        heartbeatEveryMs: HEARTBEAT_MS,
        now: () => now,
        sleep: new ManualScheduler().sleep,
      });
      const currentResult = await currentRunner.runOnce({ projectId });
      expect(currentResult).toEqual({ kind: 'submitted', jobId: 'job_fb_order', role: 'frontend_backend', attempt: 2 });

      return staged;
    };

    const staleRunner = new JobRunner({
      engine,
      identity: { workerId: 'terra-frontend-backend-1', tier: 'terra' },
      claimableRoles: ['frontend_backend'],
      handlers: new Map([['frontend_backend', wrappedStaleHandler]]),
      leaseMs: LEASE_MS,
      heartbeatEveryMs: HEARTBEAT_MS,
      now: () => T0,
      sleep: new ManualScheduler().sleep,
    });

    const staleResult = await staleRunner.runOnce({ projectId });
    expect(staleResult).toEqual({ kind: 'authority_lost', jobId: 'job_fb_order', reason: 'transition_conflict' });

    // Both candidates now physically exist, staged in this exact order.
    // Canonical resolution — the job's own attached output — is still
    // attempt 2's.
    const job = await store.jobs.findOne({ _id: 'job_fb_order' });
    expect(job?.state).toBe('validating');
    expect(job?.executionOutputs).toMatchObject([{ name: frontendBackendCandidateName('job_fb_order', 2), version: 1 }]);

    const staleCandidate = await readCandidate(projectId, 'job_fb_order', 1); // orphaned, but present
    expect(staleCandidate.files).toEqual([{ path: 'app/page.tsx', contents: 'stale content, staged last' }]);
    const current = await readCandidate(projectId, 'job_fb_order', 2);
    expect(current.files).toEqual([{ path: 'app/page.tsx', contents: 'current content' }]);
  });
});
