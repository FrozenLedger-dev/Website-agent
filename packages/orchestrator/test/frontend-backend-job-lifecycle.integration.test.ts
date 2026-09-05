/**
 * Harness-owned single `frontend_backend` job lifecycle (Phase 5i) — end to
 * end, against a real Mongo replica set, a real temp canonical Git
 * workspace, and the real production boundaries it composes: `JobEngine`,
 * `JobRunner`, the real Terra `frontend_backend` handler, Phase 5g-1's real
 * validator, Phase 5g-2's real acceptance, and Phase 5h's real promotion.
 *
 * Only two boundaries are faked, exactly as the phases this composes
 * already fake them in their own test files: the model transport (a
 * `Provider` implementation, not `@statxai/agents` itself — see
 * `frontend-backend-job-handler.integration.test.ts`), and the build
 * pipeline's own compiler/gate runner (`buildSite`/`readBuiltFiles`/
 * `readExportFiles`/`runGates` — see
 * `frontend-backend-job-validation.integration.test.ts`). Everything the
 * lifecycle itself does — enqueue, claim, stage, validate, accept, promote —
 * runs for real.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Collection } from 'mongodb';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace, type BuildResult } from '@statxai/workspace';
import type * as Workspace from '@statxai/workspace';
import type * as Gates from '@statxai/gates';
import { ModelClient, type Provider, type ProviderRequest, type ProviderResponse } from '@statxai/agents';
import { JobEngine } from '@statxai/job-engine';
import type { ArtifactRef, JobSpec, SitePlan } from '@statxai/contracts';
import type { BuildCandidate } from '../src/phases/build.js';
import { discoverProject } from '../src/phases/discover.js';
import { frontendBackendCandidateName, FRONTEND_BACKEND_INPUT } from '../src/job-handlers/frontend-backend.js';
import { AcceptanceBindingStale } from '../src/job-acceptance/frontend-backend.js';
import * as acceptanceModule from '../src/job-acceptance/frontend-backend.js';
import { PromotionCandidateShapeInvalid } from '../src/job-promotion/frontend-backend.js';
import * as promotionModule from '../src/job-promotion/frontend-backend.js';
import {
  createFrontendBackendLifecycleCoordinator,
  FrontendBackendLifecycleInputInvalid,
  FrontendBackendLifecycleJobConflict,
  FrontendBackendLifecycleRoleMismatch,
  type FrontendBackendLifecycleDeps,
} from '../src/job-lifecycle/frontend-backend.js';

const execFileAsync = promisify(execFile);

let compileSeen: string[] = [];
let gateVerdict: { passed: boolean; findings: unknown[]; gatesRun: string[] } = { passed: true, findings: [], gatesRun: ['claims'] };
let buildOk = true;

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async (siteRoot: string): Promise<BuildResult> => {
      const { readFile } = await import('node:fs/promises');
      const contents = await readFile(join(siteRoot, 'app', 'page.tsx'), 'utf8').catch(() => '<unreadable>');
      compileSeen.push(contents);
      return { ok: buildOk, durationMs: 5, output: buildOk ? '' : 'compile error: x', outDir: join(siteRoot, 'out') };
    }),
    readBuiltFiles: vi.fn(async () => [{ path: 'index.html', contents: '<html></html>' }]),
    readExportFiles: vi.fn(async () => []),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return {
    ...actual,
    runGates: vi.fn(() => gateVerdict),
  };
});

vi.mock('../src/job-acceptance/frontend-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof acceptanceModule>();
  return { ...actual, acceptValidatedFrontendBackendCandidate: vi.fn(actual.acceptValidatedFrontendBackendCandidate) };
});

vi.mock('../src/job-promotion/frontend-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof promotionModule>();
  return { ...actual, promoteAcceptedFrontendBackendCandidate: vi.fn(actual.promoteAcceptedFrontendBackendCandidate) };
});

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const T0 = new Date('2031-01-01T00:00:00.000Z');

let store: StateStore;
let registry: ArtifactRegistry;
let engine: JobEngine;
let workspacesRoot: string;
let validationWorkspacesRoot: string;
/**
 * `discoverProject` materialises `client/business-profile.json` into
 * whichever `ProjectWorkspace` it is given — a direct-path-only side effect
 * (in `runProject`, the first real build's own commit sweeps it up
 * alongside the site files). The job-engine path's real handler never opens
 * the canonical workspace at all, so fixtures here use discovery only to
 * produce a real, accepted `business-profile` artifact — pointed at a
 * throwaway workspace root, never the canonical one Phase 5h promotes into.
 */
let discoveryWorkspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  engine = new JobEngine(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-lifecycle-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-lifecycle-validate-'));
  discoveryWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-lifecycle-discovery-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
  if (discoveryWorkspacesRoot) await rm(discoveryWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
  await store.promotions.deleteMany({});
  compileSeen = [];
  gateVerdict = { passed: true, findings: [], gatesRun: ['claims'] };
  buildOk = true;
});

afterEach(() => {
  vi.mocked(acceptanceModule.acceptValidatedFrontendBackendCandidate).mockRestore?.();
  vi.mocked(promotionModule.promoteAcceptedFrontendBackendCandidate).mockRestore?.();
  vi.restoreAllMocks();
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

async function setupProject(projectId: string): Promise<ArtifactRef> {
  const result = await discoverProject({
    projectId,
    intake: INTAKE,
    store,
    registry,
    workspacesRoot: discoveryWorkspacesRoot,
    autonomyMode: 'full_autonomous',
    say: () => {},
  });
  if (!result.ok) throw new Error('fixture setup: discoverProject refused the fixture intake');
  const profileDoc = await store.artifacts.findOne({ projectId, name: 'business-profile' }, { sort: { version: -1 } });
  return { name: 'business-profile', version: profileDoc!.version };
}

async function putPlan(projectId: string, plan: SitePlan): Promise<ArtifactRef> {
  const ref = await registry.put(projectId, 'site-plan', plan);
  await registry.accept(projectId, ref);
  return ref;
}

function jobSpec(
  projectId: string,
  jobId: string,
  profileRef: ArtifactRef,
  planRef: ArtifactRef,
  overrides: Partial<JobSpec> = {},
): JobSpec {
  return {
    projectId,
    jobId,
    role: 'frontend_backend',
    objective: 'Build the site from the approved plan.',
    inputs: { [FRONTEND_BACKEND_INPUT.businessProfile]: profileRef, [FRONTEND_BACKEND_INPUT.sitePlan]: planRef },
    acceptanceCriteria: ['site files written from the approved plan'],
    allowedTools: [],
    output: ['app/page.tsx'],
    ...overrides,
  };
}

function dummyRef(name: string): ArtifactRef {
  return { name, version: 1 };
}

/** A syntactically valid JobSpec that never needs a real artifact — for fixtures that never let Terra execute. */
function dummySpec(projectId: string, jobId: string, output: string[] = [`${jobId}.tsx`]): JobSpec {
  return jobSpec(projectId, jobId, dummyRef('business-profile'), dummyRef('site-plan'), { output });
}

/** Full real project + accepted pinned plan, ready for a genuine Terra execution. */
async function realJobSpec(projectId: string, jobId: string, marker = jobId, overrides: Partial<JobSpec> = {}): Promise<JobSpec> {
  const profileRef = await setupProject(projectId);
  const planRef = await putPlan(projectId, onePagePlan(marker));
  return jobSpec(projectId, jobId, profileRef, planRef, overrides);
}

// ---------------------------------------------------------------------------
// The model boundary — the only thing besides the compiler this file fakes.
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

function routingModel(terraBuild: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>): ModelClient {
  return new ModelClient(
    new FakeProvider((request) => {
      if (request.schemaName.startsWith('sol_route')) return solRouteOneShot();
      if (request.schemaName.startsWith('terra_build')) return terraBuild(request);
      throw new Error(`unexpected model call in test: ${request.schemaName}`);
    }),
  );
}

function neverCalledModel(): ModelClient {
  return new ModelClient(
    new FakeProvider(() => {
      throw new Error('model must not be called in this test');
    }),
  );
}

function successModel(contents = 'export default function Home(){return null}'): ModelClient {
  return routingModel(() => buildOutput([{ path: 'app/page.tsx', contents }]));
}

function coordinatorDeps(
  model: ModelClient,
  overrides: Partial<FrontendBackendLifecycleDeps> = {},
): FrontendBackendLifecycleDeps {
  return {
    store,
    registry,
    engine,
    model,
    workerIdentity: { workerId: 'terra-lifecycle-1', tier: 'terra' },
    workspacesRoot,
    validationWorkspacesRoot,
    now: () => T0,
    leaseMs: LEASE_MS,
    heartbeatEveryMs: HEARTBEAT_MS,
    ...overrides,
  };
}

async function readCandidate(projectId: string, jobId: string, attempt: number): Promise<BuildCandidate> {
  return registry.get<BuildCandidate>(projectId, frontendBackendCandidateName(jobId, attempt));
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

async function countCommitsWithMarker(root: string, marker: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['-C', root, 'log', '--all', '--format=%B\x02'], { maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return 0;
  }
  const entries = stdout.split('\x02').map((e) => e.trim()).filter(Boolean);
  return entries.filter((message) => message.split('\n').some((line) => line.trim() === marker)).length;
}

async function canonicalWorkspace(projectId: string): Promise<ProjectWorkspace> {
  return ProjectWorkspace.open(projectId, workspacesRoot);
}

// ---------------------------------------------------------------------------

describe('the full happy path', () => {
  it('runs enqueue -> one Terra execution -> validating -> 5g-1 pass -> 5g-2 accept -> accepted -> 5h promotion -> promoted, in one invocation', async () => {
    const projectId = 'proj_lifecycle_happy';
    const jobId = 'job_lifecycle_happy';
    const spec = await realJobSpec(projectId, jobId, 'happy');
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('happy page content')));

    const result = await coordinator.run(spec);

    expect(result.outcome).toBe('promoted');
    if (result.outcome !== 'promoted') throw new Error('unreachable');
    expect(result.jobId).toBe(jobId);
    expect(result.attempt).toBe(1);
    expect(result.enqueued).toBe(true);
    expect(result.workerExecuted).toBe(true);

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.state).toBe('accepted');
    expect(job?.role).toBe('frontend_backend');
    expect(job?.executionOutputs).toMatchObject([{ name: frontendBackendCandidateName(jobId, 1) }]);

    const candidate = await readCandidate(projectId, jobId, 1);
    expect(candidate.files).toEqual([{ path: 'app/page.tsx', contents: 'happy page content' }]);
    expect(compileSeen).toEqual(['happy page content']);

    const candidateDoc = await store.artifacts.findOne({ projectId, name: frontendBackendCandidateName(jobId, 1) });
    expect(candidateDoc?.acceptedAt).toBeInstanceOf(Date);

    const record = await store.promotions.findOne({ _id: result.promotionId });
    expect(record?.status).toBe('committed');
    expect(record?.commitSha).toBe(result.commitSha);

    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBe(result.commitSha);
    await expect(ws.readSiteFile('app/page.tsx')).resolves.toBe('happy page content');
    expect(await countCommitsWithMarker(ws.root, `Statx-Promotion-Id: ${result.promotionId}`)).toBe(1);
  });
});

describe('role mismatch and missing pinned inputs fail before anything is enqueued', () => {
  it('rejects a JobSpec whose role is not frontend_backend', async () => {
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const spec = jobSpec('proj_lifecycle_wrong_role', 'job_wrong_role', dummyRef('p'), dummyRef('s'), { role: 'qa_review' });

    await expect(coordinator.run(spec)).rejects.toBeInstanceOf(FrontendBackendLifecycleRoleMismatch);
    expect(await store.jobs.findOne({ _id: 'job_wrong_role' })).toBeNull();
  });

  it('rejects a JobSpec missing a required pinned input, before enqueueing', async () => {
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const spec = jobSpec('proj_lifecycle_missing_input', 'job_missing_input', dummyRef('p'), dummyRef('s'));
    delete (spec.inputs as Record<string, ArtifactRef>)[FRONTEND_BACKEND_INPUT.sitePlan];

    await expect(coordinator.run(spec)).rejects.toBeInstanceOf(FrontendBackendLifecycleInputInvalid);
    expect(await store.jobs.findOne({ _id: 'job_missing_input' })).toBeNull();
  });
});

describe('exact job claim, not the oldest ready job', () => {
  it('claims exactly the target job; an older ready job of the same role is left untouched', async () => {
    const projectId = 'proj_lifecycle_exact_claim';
    await engine.enqueue({ spec: dummySpec(projectId, 'job_older', ['older.tsx']), origin: { kind: 'plan' } });

    const spec = await realJobSpec(projectId, 'job_target', 'exact-claim');
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('target content')));

    const result = await coordinator.run(spec);
    expect(result.outcome).toBe('promoted');

    const older = await store.jobs.findOne({ _id: 'job_older' });
    expect(older?.state).toBe('ready');
    expect(older?.attempt).toBe(0);
    expect(older?.lease).toBeNull();
    expect(older?.executionOutputs ?? null).toBeNull();
  });
});

describe('no other role is executed', () => {
  it('a ready job of a different Terra role in the same project is never claimed by this lifecycle', async () => {
    const projectId = 'proj_lifecycle_other_role';
    await engine.enqueue({
      spec: { ...dummySpec(projectId, 'job_other_role', ['other.tsx']), role: 'qa_review' },
      origin: { kind: 'plan' },
    });

    const spec = await realJobSpec(projectId, 'job_target_role', 'other-role');
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('role content')));

    await coordinator.run(spec);

    const otherRole = await store.jobs.findOne({ _id: 'job_other_role' });
    expect(otherRole?.state).toBe('ready');
    expect(otherRole?.lease).toBeNull();
  });
});

describe('same jobId, different JobSpec', () => {
  it('fails closed with a lifecycle conflict, executing nothing and mutating nothing', async () => {
    const projectId = 'proj_lifecycle_conflict';
    const jobId = 'job_lifecycle_conflict';
    const specA = await realJobSpec(projectId, jobId, 'conflict-a');

    // Establish job A's spec durably, without ever letting Terra run.
    await engine.enqueue({ spec: specA, origin: { kind: 'plan' } });

    // A model that would throw if ever called proves the conflict is caught
    // before any execution, not merely before promotion.
    const specB = { ...specA, objective: 'A completely different objective.' };
    const coordinatorB = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));

    await expect(coordinatorB.run(specB)).rejects.toBeInstanceOf(FrontendBackendLifecycleJobConflict);

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.spec.objective).toBe(specA.objective);
    expect(job?.state).toBe('ready');
  });
});

describe('pinned inputs survive a newer version', () => {
  it('builds and validates against the pinned v1 businessProfile/sitePlan, never a newer accepted version', async () => {
    const projectId = 'proj_lifecycle_pinned';
    const jobId = 'job_lifecycle_pinned';
    const spec = await realJobSpec(projectId, jobId, 'pinned-v1');

    // A newer, different plan is accepted after the JobSpec already pinned v1.
    await putPlan(projectId, onePagePlan('pinned-v2'));

    const seenPrompts: string[] = [];
    const model = routingModel((request) => {
      seenPrompts.push(request.prompt);
      return buildOutput([{ path: 'app/page.tsx', contents: 'from-pinned-v1' }]);
    });
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(model));

    const result = await coordinator.run(spec);
    expect(result.outcome).toBe('promoted');
    expect(spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan]!.version).toBe(1);

    const buildPrompt = seenPrompts.find((p) => p.includes('v-pinned-v1') || p.includes('v-pinned-v2'));
    expect(buildPrompt).toContain('v-pinned-v1');
    expect(buildPrompt).not.toContain('v-pinned-v2');
  });
});

describe('exact replay after a successful promotion', () => {
  it('a second full lifecycle call for the same JobSpec is a pure read-and-verify: no second job, model call, candidate, acceptance, or commit', async () => {
    const projectId = 'proj_lifecycle_replay';
    const jobId = 'job_lifecycle_replay';
    const spec = await realJobSpec(projectId, jobId, 'replay');

    let modelCalls = 0;
    const model = routingModel(() => {
      modelCalls += 1;
      return buildOutput([{ path: 'app/page.tsx', contents: 'replay content' }]);
    });
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(model));

    const first = await coordinator.run(spec);
    expect(first.outcome).toBe('promoted');
    const callsAfterFirst = modelCalls;

    const jobsAfterFirst = await store.jobs.countDocuments({ _id: jobId });
    const artifactsAfterFirst = await store.artifacts.countDocuments({ projectId });

    const second = await coordinator.run(spec);
    // Same identity — same job, attempt, candidate, promotion, commit — but
    // this invocation itself enqueued nothing and executed no worker; those
    // two flags report what *this* call did, not the job's history.
    expect(second).toEqual({ ...first, enqueued: false, workerExecuted: false });
    expect(modelCalls).toBe(callsAfterFirst);

    expect(await store.jobs.countDocuments({ _id: jobId })).toBe(jobsAfterFirst);
    expect(await store.artifacts.countDocuments({ projectId })).toBe(artifactsAfterFirst);

    if (first.outcome !== 'promoted') throw new Error('unreachable');
    const ws = await canonicalWorkspace(projectId);
    expect(await countCommitsWithMarker(ws.root, `Statx-Promotion-Id: ${first.promotionId}`)).toBe(1);
  });
});

describe('resume from validating after a process boundary', () => {
  it('reruns 5g-1 fresh on a brand-new coordinator instance, never re-invoking Terra, then accepts and promotes', async () => {
    const projectId = 'proj_lifecycle_resume_validating';
    const jobId = 'job_lifecycle_resume_validating';
    const spec = await realJobSpec(projectId, jobId, 'resume-validating');

    const staging = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('resume content')));
    // Stop the first coordinator's own progress exactly at `validating` by
    // forcing acceptance to fail — a controlled failure at the 5g-2
    // boundary, not a fabrication of the job's own durable state.
    vi.mocked(acceptanceModule.acceptValidatedFrontendBackendCandidate).mockRejectedValueOnce(
      new Error('simulated process death before acceptance'),
    );
    await expect(staging.run(spec)).rejects.toThrow('simulated process death before acceptance');

    const midway = await store.jobs.findOne({ _id: jobId });
    expect(midway?.state).toBe('validating');

    // A genuinely new coordinator instance — no shared in-process state, and
    // in particular no 5g-1 WeakMap evidence survives this boundary.
    const resumed = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await resumed.run(spec);

    expect(result.outcome).toBe('promoted');
    expect(result.enqueued).toBe(false);
    expect(result.workerExecuted).toBe(false);
    const candidate = await readCandidate(projectId, jobId, 1);
    expect(candidate.files).toEqual([{ path: 'app/page.tsx', contents: 'resume content' }]);
  });
});

describe('resume from accepted', () => {
  it('runs 5h alone: no Terra, no validation, no re-acceptance', async () => {
    const projectId = 'proj_lifecycle_resume_accepted';
    const jobId = 'job_lifecycle_resume_accepted';
    const spec = await realJobSpec(projectId, jobId, 'resume-accepted');

    const staging = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('accepted content')));
    vi.mocked(promotionModule.promoteAcceptedFrontendBackendCandidate).mockRejectedValueOnce(
      new Error('simulated process death before promotion'),
    );
    await expect(staging.run(spec)).rejects.toThrow('simulated process death before promotion');

    const midway = await store.jobs.findOne({ _id: jobId });
    expect(midway?.state).toBe('accepted');

    const acceptCallsBefore = vi.mocked(acceptanceModule.acceptValidatedFrontendBackendCandidate).mock.calls.length;

    const resumed = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await resumed.run(spec);

    expect(result.outcome).toBe('promoted');
    expect(result.workerExecuted).toBe(false);
    expect(vi.mocked(acceptanceModule.acceptValidatedFrontendBackendCandidate).mock.calls.length).toBe(acceptCallsBefore);
  });
});

describe('resume after a full promotion', () => {
  it('no model, no validation, no acceptance, no extra Git commit', async () => {
    const projectId = 'proj_lifecycle_resume_promoted';
    const jobId = 'job_lifecycle_resume_promoted';
    const spec = await realJobSpec(projectId, jobId, 'resume-promoted');
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('promoted content')));

    const first = await coordinator.run(spec);
    expect(first.outcome).toBe('promoted');

    const again = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const second = await again.run(spec);
    expect(second).toEqual({ ...first, enqueued: false, workerExecuted: false });

    if (first.outcome !== 'promoted') throw new Error('unreachable');
    const ws = await canonicalWorkspace(projectId);
    expect(await countCommitsWithMarker(ws.root, `Statx-Promotion-Id: ${first.promotionId}`)).toBe(1);
  });
});

describe('validation failure stops the lifecycle', () => {
  it('reports validation_failed, leaves the job validating, and never accepts/promotes/repairs', async () => {
    buildOk = false;
    const projectId = 'proj_lifecycle_validation_failed';
    const jobId = 'job_lifecycle_validation_failed';
    const spec = await realJobSpec(projectId, jobId, 'validation-failed');
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('bad content')));

    const result = await coordinator.run(spec);

    expect(result.outcome).toBe('validation_failed');
    if (result.outcome !== 'validation_failed') throw new Error('unreachable');
    expect(result.report.compiled.ok).toBe(false);
    expect(result.attempt).toBe(1);

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.state).toBe('validating');

    const candidateDoc = await store.artifacts.findOne({ projectId, name: frontendBackendCandidateName(jobId, 1) });
    expect(candidateDoc?.acceptedAt).toBeNull();
    expect(await store.promotions.countDocuments({ jobId })).toBe(0);
    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();

    expect(vi.mocked(acceptanceModule.acceptValidatedFrontendBackendCandidate)).not.toHaveBeenCalled();
  });
});

describe('at most one Terra worker attempt per invocation', () => {
  it('a handler failure that returns the job to ready stops the invocation with retry_ready, without a second execution', async () => {
    const projectId = 'proj_lifecycle_one_attempt';
    const jobId = 'job_lifecycle_one_attempt';
    const spec = await realJobSpec(projectId, jobId, 'one-attempt');

    let calls = 0;
    const model = routingModel(() => {
      calls += 1;
      throw new Error('attempt 1: terra build rejected');
    });
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(model));

    const result = await coordinator.run(spec);
    expect(result).toMatchObject({ outcome: 'retry_ready', jobId, state: 'ready', workerExecuted: true });
    expect(calls).toBe(1);

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.state).toBe('ready');
    expect(job?.attempt).toBe(1);
  });

  it('a second invocation may legitimately execute the retry, incrementing attempt through JobEngine alone', async () => {
    const projectId = 'proj_lifecycle_retry_next';
    const jobId = 'job_lifecycle_retry_next';
    const spec = await realJobSpec(projectId, jobId, 'retry-next');

    let calls = 0;
    const model = routingModel(() => {
      calls += 1;
      if (calls === 1) throw new Error('attempt 1: terra build rejected');
      return buildOutput([{ path: 'app/page.tsx', contents: 'attempt-2 content' }]);
    });
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(model));

    const first = await coordinator.run(spec);
    expect(first.outcome).toBe('retry_ready');

    const second = await coordinator.run(spec);
    expect(second.outcome).toBe('promoted');
    expect(calls).toBe(2);

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.attempt).toBe(2);
    expect(job?.executionOutputs).toMatchObject([{ name: frontendBackendCandidateName(jobId, 2) }]);
  });
});

describe('a running job is never hijacked', () => {
  it('does not steal the lease, run the handler, validate, accept, or promote', async () => {
    const projectId = 'proj_lifecycle_running';
    const jobId = 'job_lifecycle_running';
    await engine.enqueue({ spec: dummySpec(projectId, jobId), origin: { kind: 'plan' } });
    const claimed = await engine.claim('another-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    expect(claimed?._id).toBe(jobId);

    const spec = dummySpec(projectId, jobId);
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));

    const result = await coordinator.run(spec);
    expect(result).toMatchObject({ outcome: 'in_progress', jobId, state: 'running', enqueued: false, workerExecuted: false });

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.lease?.holder).toBe('another-worker');
    expect(job?.attempt).toBe(1);
  });
});

describe('ready but dependency not satisfied', () => {
  it('exact-job targeting does not bypass dependency checks', async () => {
    const projectId = 'proj_lifecycle_dependency';
    const baseSpec = dummySpec(projectId, 'job_base', ['base.tsx']);
    await engine.enqueue({ spec: baseSpec, origin: { kind: 'plan' } });
    const dependentSpec = dummySpec(projectId, 'job_dependent', ['dependent.tsx']);
    await engine.enqueue({ spec: dependentSpec, origin: { kind: 'plan' }, dependsOn: ['job_base'] });

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await coordinator.run(dependentSpec);

    expect(result).toMatchObject({ outcome: 'not_claimable', jobId: 'job_dependent', state: 'ready' });
    const job = await store.jobs.findOne({ _id: 'job_dependent' });
    expect(job?.state).toBe('ready');
    expect(job?.attempt).toBe(0);
  });
});

describe('ready but output-conflicted', () => {
  it('does not claim the exact job while it conflicts with something already running', async () => {
    const projectId = 'proj_lifecycle_output_conflict';
    const runningSpec = dummySpec(projectId, 'job_running_conflict', ['shared.tsx']);
    await engine.enqueue({ spec: runningSpec, origin: { kind: 'plan' } });
    await engine.claim('another-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });

    const targetSpec = dummySpec(projectId, 'job_target_conflict', ['shared.tsx']);
    await engine.enqueue({ spec: targetSpec, origin: { kind: 'plan' } });

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await coordinator.run(targetSpec);

    expect(result).toMatchObject({ outcome: 'not_claimable', jobId: 'job_target_conflict', state: 'ready' });
    const target = await store.jobs.findOne({ _id: 'job_target_conflict' });
    expect(target?.state).toBe('ready');
  });
});

describe('a blocked job is not released', () => {
  it('remains blocked; no release, handler, validation, or promotion', async () => {
    const projectId = 'proj_lifecycle_blocked';
    const jobId = 'job_lifecycle_blocked';
    const spec = dummySpec(projectId, jobId);
    await engine.enqueue({ spec, origin: { kind: 'plan' } });
    await engine.block(jobId, 'harness:policy', 'blocked for fixture purposes');

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await coordinator.run(spec);

    expect(result).toMatchObject({ outcome: 'blocked', jobId, state: 'blocked', enqueued: false, workerExecuted: false });
    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.state).toBe('blocked');
  });
});

describe('repair_requested does not wire Luna', () => {
  it('does not claim, create a repair job, or mutate the job', async () => {
    const projectId = 'proj_lifecycle_repair_requested';
    const jobId = 'job_lifecycle_repair_requested';
    const spec = dummySpec(projectId, jobId);
    await engine.enqueue({ spec, origin: { kind: 'plan' } });
    const claimed = await engine.claim('fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    await engine.submitForValidation(jobId, 'fixture-worker', claimed!.attempt);
    await engine.requestRepair(jobId, 'harness:validator');

    const before = await store.jobs.findOne({ _id: jobId });
    expect(before?.state).toBe('repair_requested');

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await coordinator.run(spec);

    expect(result).toMatchObject({ outcome: 'repair_requested', jobId, state: 'repair_requested' });
    const after = await store.jobs.findOne({ _id: jobId });
    expect(after).toEqual(before);
  });
});

describe('an exhausted failed job stays failed', () => {
  it('no reset, no replacement job, no handler, no promotion', async () => {
    const projectId = 'proj_lifecycle_exhausted';
    const jobId = 'job_lifecycle_exhausted';
    const spec = dummySpec(projectId, jobId);
    await engine.enqueue({ spec, origin: { kind: 'plan' }, maxAttempts: 1 });
    const claimed = await engine.claim('fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    await engine.fail(jobId, 'fixture failure', 'fixture-worker', claimed!.attempt);

    const before = await store.jobs.findOne({ _id: jobId });
    expect(before?.state).toBe('failed');

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await coordinator.run(spec);

    expect(result).toMatchObject({ outcome: 'failed', jobId, state: 'failed' });
    expect(await store.jobs.countDocuments({ projectId })).toBe(1);
    const after = await store.jobs.findOne({ _id: jobId });
    expect(after).toEqual(before);
  });
});

describe('fresh enqueue only — a pre-existing draft job is never auto-released', () => {
  it('a freshly-created job never starts as draft; a pre-existing draft job stops without release', async () => {
    const projectId = 'proj_lifecycle_draft';
    const jobId = 'job_lifecycle_draft';
    const spec = dummySpec(projectId, jobId);
    await engine.enqueue({ spec, origin: { kind: 'plan' }, draft: true });

    const before = await store.jobs.findOne({ _id: jobId });
    expect(before?.state).toBe('draft');

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await coordinator.run(spec);

    expect(result).toMatchObject({ outcome: 'draft', jobId, state: 'draft', enqueued: false, workerExecuted: false });
    const after = await store.jobs.findOne({ _id: jobId });
    expect(after?.state).toBe('draft');
  });
});

describe('authority loss does not publish stale output', () => {
  it('a same-worker stale attempt that finishes after being superseded cannot publish; the lifecycle follows durable state', async () => {
    const projectId = 'proj_lifecycle_authority_loss';
    const jobId = 'job_lifecycle_authority_loss';
    const spec = await realJobSpec(projectId, jobId, 'authority-loss');

    const clock = new ManualClock(T0);
    const scheduler = new ManualScheduler();
    const buildGate = deferred<ProviderResponse>();
    let terraBuildCallStarted = false;

    const model = routingModel(() => {
      terraBuildCallStarted = true;
      return buildGate.promise;
    });

    const coordinator = createFrontendBackendLifecycleCoordinator(
      coordinatorDeps(model, { now: clock.now, sleep: scheduler.sleep }),
    );

    const resultPromise = coordinator.run(spec);

    await waitUntil(() => terraBuildCallStarted && scheduler.pendingCount() > 0);

    // The same fixed worker identity reclaims its own job after its lease
    // expires — exactly the shape workerId alone cannot distinguish.
    clock.advance(LEASE_MS + 1);
    expect(await engine.reclaimExpiredLeases(clock.now())).toBe(1);
    const replacement = await engine.claim('terra-lifecycle-1', 'terra', {
      roles: ['frontend_backend'],
      now: clock.now(),
      leaseMs: LEASE_MS,
    });
    expect(replacement?._id).toBe(jobId);
    expect(replacement?.attempt).toBe(2);

    await scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    buildGate.resolve(buildOutput([{ path: 'app/page.tsx', contents: 'STALE — must never publish' }]));

    const result = await resultPromise;
    expect(result).toMatchObject({ outcome: 'in_progress', jobId, state: 'running', workerExecuted: true });

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.state).toBe('running');
    expect(job?.attempt).toBe(2);
    expect(job?.lease?.holder).toBe('terra-lifecycle-1');
    expect(job?.executionOutputs ?? null).toBeNull();

    await expect(registry.get(projectId, frontendBackendCandidateName(jobId, 1))).rejects.toThrow();
  });
});

describe('acceptance failure does not promote', () => {
  it('surfaces the acceptance error; 5h is never called; no canonical commit', async () => {
    const projectId = 'proj_lifecycle_acceptance_fails';
    const jobId = 'job_lifecycle_acceptance_fails';
    const spec = await realJobSpec(projectId, jobId, 'acceptance-fails');

    vi.mocked(acceptanceModule.acceptValidatedFrontendBackendCandidate).mockImplementationOnce(async () => {
      throw new AcceptanceBindingStale(jobId, 'attempt');
    });

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('acceptance-fails content')));
    await expect(coordinator.run(spec)).rejects.toBeInstanceOf(AcceptanceBindingStale);

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.state).toBe('validating');
    expect(await store.promotions.countDocuments({ jobId })).toBe(0);
    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();
    expect(vi.mocked(promotionModule.promoteAcceptedFrontendBackendCandidate)).not.toHaveBeenCalled();
  });
});

describe('promotion failure surfaces', () => {
  it('does not deploy; the job remains accepted; a retry can use 5h replay semantics', async () => {
    const projectId = 'proj_lifecycle_promotion_fails';
    const jobId = 'job_lifecycle_promotion_fails';
    const spec = await realJobSpec(projectId, jobId, 'promotion-fails');

    vi.mocked(promotionModule.promoteAcceptedFrontendBackendCandidate).mockImplementationOnce(async () => {
      throw new PromotionCandidateShapeInvalid(jobId, 'simulated platform failure');
    });

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('promotion-fails content')));
    await expect(coordinator.run(spec)).rejects.toBeInstanceOf(PromotionCandidateShapeInvalid);

    const job = await store.jobs.findOne({ _id: jobId });
    expect(job?.state).toBe('accepted');

    const retry = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await retry.run(spec);
    expect(result.outcome).toBe('promoted');
  });
});

describe('post-Git / pre-Mongo promotion recovery through the lifecycle', () => {
  it('a retry after Git commit succeeds but Mongo finalization fails discovers the existing marker and finalizes without a duplicate commit', async () => {
    const projectId = 'proj_lifecycle_git_mongo_race';
    const jobId = 'job_lifecycle_git_mongo_race';
    const spec = await realJobSpec(projectId, jobId, 'git-mongo-race');

    // The full lifecycle also drives JobEngine's own `findOneAndUpdate` calls
    // (claim, submitForValidation, guarded accept) before promotion is ever
    // reached — a blanket `mockImplementationOnce` would intercept one of
    // those instead. Scoped to the exact collection Phase 5h's own finalize
    // step writes to, restoring itself the instant it fires once.
    const original = Collection.prototype.findOneAndUpdate;
    const findOneAndUpdateSpy = vi
      .spyOn(Collection.prototype, 'findOneAndUpdate')
      .mockImplementation(function (this: Collection, ...args: Parameters<typeof original>) {
        if (this.collectionName === 'job_promotions') {
          findOneAndUpdateSpy.mockRestore();
          throw new Error('simulated Mongo failure right after the Git commit succeeded');
        }
        return original.apply(this, args);
      });

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps(successModel('git-mongo-race content')));
    await expect(coordinator.run(spec)).rejects.toThrow('simulated Mongo failure');

    const prepared = await store.promotions.findOne({ jobId });
    expect(prepared?.status).toBe('prepared');
    const ws = await canonicalWorkspace(projectId);
    const marker = `Statx-Promotion-Id: ${prepared!._id}`;
    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);

    const retry = createFrontendBackendLifecycleCoordinator(coordinatorDeps(neverCalledModel()));
    const result = await retry.run(spec);
    expect(result.outcome).toBe('promoted');
    if (result.outcome !== 'promoted') throw new Error('unreachable');
    expect(result.promotionId).toBe(prepared!._id);
    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);
  });
});

describe('structural boundaries', () => {
  it('does not call runProject', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      join(process.cwd(), 'packages/orchestrator/src/job-lifecycle/frontend-backend.ts'),
      'utf8',
    );
    expect(src).not.toContain('runProject');
  });
});
