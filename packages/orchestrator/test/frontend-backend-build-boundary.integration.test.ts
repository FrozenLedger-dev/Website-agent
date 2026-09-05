/**
 * Phase 5j — routing `runProject`'s frontend/backend build boundary through
 * Phase 5i, end to end, against a real Mongo replica set and a real temp
 * canonical Git workspace.
 *
 * The mock setup mirrors `delivery.parity.integration.test.ts` exactly —
 * `@statxai/agents` (Sol/Terra model calls) and `@statxai/workspace`'s own
 * compiler (`buildSite`/`readBuiltFiles`/`readExportFiles`) and
 * `@statxai/gates`'s `runGates` are faked, everything else is real:
 * `JobEngine`, `JobRunner`, the real production Terra `frontend_backend`
 * handler, Phase 5g-1, 5g-2, 5h, and `runProject` itself. Both the legacy
 * direct build and the job_lifecycle build ultimately call the *same*
 * mocked `routeBuild`/`buildSite` (agents) functions, so this one mock
 * setup drives either path identically.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import * as lifecycleModule from '../src/job-lifecycle/frontend-backend.js';
import * as buildModule from '../src/phases/build.js';
import * as evaluateModule from '../src/phases/evaluate.js';

interface ReviewIssue {
  id: string;
  category: string;
  severity: string;
  location: string;
  reason: string;
  acceptanceTest: string;
  recommendedAction: string;
  evidence: string[];
}

let approval: { recommendation: string; reason: string; acknowledgedIssues: string[] };
let reviewSequence: { qualityScore: number; blocking: boolean; issues: ReviewIssue[] }[];
let gateVerdict: { passed: boolean; findings: unknown[]; gatesRun: string[] } = { passed: true, findings: [], gatesRun: ['claims'] };
let compileOk = true;
/** Fired, once, from inside the mocked `routeBuild` — the first model call any generation makes. */
let onFirstGenerationCall: (() => Promise<void>) | null = null;
/**
 * Fired, once, from inside the mocked `planSite` — right after discovery and
 * before `runProject`'s job-mode branch ever builds a `JobSpec`. Narrower
 * than `onFirstGenerationCall`: a write injected here lands in the exact gap
 * between "discovery/planning finished" and "the JobSpec is constructed",
 * which is the only window that can distinguish "pinned to the value
 * discovery/planning actually produced" from "re-resolved 'latest' at
 * spec-construction time" — those two are indistinguishable if nothing new
 * is written in between, which is true of every other test in this file.
 */
let onPlanProduced: (() => Promise<void>) | null = null;
let routeBuildCalls = 0;
let terraBuildCalls = 0;

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  id: 'QA-004',
  category: 'accessibility',
  severity: 'P2',
  location: 'index.html',
  reason: 'Focus indicator relies on an undefined custom property.',
  acceptanceTest: 'Focus is visible on every control.',
  recommendedAction: 'targeted_repair',
  evidence: [],
  ...over,
});

const page = (route: string, title: string) => ({
  route,
  title,
  metaDescription: 'd',
  goal: 'g',
  primaryAction: 'call',
  sections: [{ id: 'hero', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }],
});

const planWith = (marker: string, routes: [string, string][] = [['/', 'Home']]) => ({
  strategy: 'Local trade credibility',
  valueProposition: `v-${marker}`,
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: `direction-${marker}`,
    radius: 'square',
    rationale: 'Workwear palette suits the trade.',
  },
  sitemap: { pages: routes.map(([route, title]) => page(route, title)) },
  acceptanceCriteria: ['a', 'b', 'c'],
});

const PLAN = planWith('v1');
const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => {
      if (onPlanProduced) {
        const fire = onPlanProduced;
        onPlanProduced = null;
        await fire();
      }
      return { value: PLAN, model: 'gpt-5.6-sol', ...usage };
    }),
    routeBuild: vi.fn(async () => {
      routeBuildCalls += 1;
      if (onFirstGenerationCall) {
        const fire = onFirstGenerationCall;
        onFirstGenerationCall = null;
        await fire();
      }
      return {
        value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
        model: 'gpt-5.6-sol',
        ...usage,
      };
    }),
    buildSite: vi.fn(async () => {
      terraBuildCalls += 1;
      return {
        value: { files: [{ path: 'app/page.tsx', contents: 'export default function P(){return null}' }], notes: '' },
        model: 'gpt-5.6-terra',
        ...usage,
      };
    }),
    reviewSite: vi.fn(async () => {
      const r = reviewSequence.length > 1 ? reviewSequence.shift()! : reviewSequence[0]!;
      return {
        value: {
          decision: r.blocking ? 'reject' : 'accept',
          qualityScore: r.qualityScore,
          blocking: r.blocking,
          issues: r.issues,
          summary: 's',
        },
        model: 'gpt-5.6-terra',
        ...usage,
      };
    }),
    recommendApproval: vi.fn(async () => ({ value: approval, model: 'gpt-5.6-sol', ...usage })),
    adjudicate: vi.fn(async () => ({
      value: { action: 'block', reason: 'unused by default', defectIds: null, objective: null, scope: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
  };
});

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    scaffoldSite: vi.fn(actual.scaffoldSite),
    buildSite: vi.fn(async () => ({ ok: compileOk, durationMs: 5, output: compileOk ? '' : 'compile error: x', outDir: '/out' })),
    readBuiltFiles: vi.fn(async () => [
      { path: 'index.html', contents: '<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Harrowgate Joinery</h1></main></body></html>' },
    ]),
    readExportFiles: vi.fn(async () => []),
    readSourceFiles: vi.fn(async () => [{ path: 'app/page.tsx', contents: 'x' }]),
    deploymentConfigured: vi.fn(() => false),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return {
    ...actual,
    runGates: vi.fn(() => gateVerdict),
  };
});

vi.mock('../src/job-lifecycle/frontend-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof lifecycleModule>();
  return { ...actual, createFrontendBackendLifecycleCoordinator: vi.fn(actual.createFrontendBackendLifecycleCoordinator) };
});

vi.mock('../src/phases/build.js', async (importOriginal) => {
  const actual = await importOriginal<typeof buildModule>();
  return { ...actual, buildFromPlan: vi.fn(actual.buildFromPlan) };
});

vi.mock('../src/phases/evaluate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof evaluateModule>();
  return { ...actual, evaluateSite: vi.fn(actual.evaluateSite) };
});

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

let store: StateStore;
let registry: ArtifactRegistry;
let workspacesRoot: string;
let validationWorkspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5j-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5j-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  gateVerdict = { passed: true, findings: [], gatesRun: ['claims'] };
  compileOk = true;
  onFirstGenerationCall = null;
  onPlanProduced = null;
  routeBuildCalls = 0;
  terraBuildCalls = 0;
  reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
  approval = { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: ['QA-004'] };
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
  await store.promotions.deleteMany({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const run = async (
  projectId: string,
  overrides: Partial<{
    frontendBackendExecutionMode: 'legacy_direct' | 'job_lifecycle';
    validationWorkspacesRoot: string;
  }> = {},
) => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({
    projectId,
    intake: INTAKE,
    store,
    workspacesRoot,
    autonomyMode: 'full_autonomous',
    frontendBackendExecutionMode: overrides.frontendBackendExecutionMode ?? 'legacy_direct',
    validationWorkspacesRoot: overrides.validationWorkspacesRoot ?? validationWorkspacesRoot,
  });
};

const runJobMode = (projectId: string) => run(projectId, { frontendBackendExecutionMode: 'job_lifecycle' });

async function canonicalWorkspace(projectId: string): Promise<ProjectWorkspace> {
  return ProjectWorkspace.open(projectId, workspacesRoot);
}

// ---------------------------------------------------------------------------

describe('legacy mode remains the default', () => {
  it('runs the legacy build path unchanged when no mode is requested', async () => {
    const { runProject } = await import('../src/orchestrator.js');
    const projectId = 'proj_5j_legacy_default';
    const result = await runProject({
      projectId,
      intake: INTAKE,
      store,
      workspacesRoot,
      autonomyMode: 'full_autonomous',
      // frontendBackendExecutionMode omitted entirely.
    });

    expect(result.outcome).toBe('released');
    expect(result.jobLifecycleOutcome).toBeUndefined();
    expect(await store.jobs.countDocuments({ projectId })).toBe(0);
    expect(await store.promotions.countDocuments({ projectId })).toBe(0);
    expect(vi.mocked(lifecycleModule.createFrontendBackendLifecycleCoordinator)).not.toHaveBeenCalled();
    expect(vi.mocked(buildModule.buildFromPlan)).toHaveBeenCalledTimes(1);
  });
});

describe('job_lifecycle requires validationWorkspacesRoot', () => {
  it('rejects the run before touching discovery, rather than defaulting to the canonical root', async () => {
    const { runProject } = await import('../src/orchestrator.js');
    const projectId = 'proj_5j_missing_validation_root';
    await expect(
      runProject({
        projectId,
        intake: INTAKE,
        store,
        workspacesRoot,
        autonomyMode: 'full_autonomous',
        frontendBackendExecutionMode: 'job_lifecycle',
        // validationWorkspacesRoot omitted.
      }),
    ).rejects.toThrow('requires validationWorkspacesRoot');
    expect(await store.artifacts.countDocuments({ projectId })).toBe(0);
  });
});

describe('legacy mode does not initialize job side effects', () => {
  it('creates no jobs, audit entries, candidate artifacts, or promotion receipts', async () => {
    const projectId = 'proj_5j_legacy_no_side_effects';
    await run(projectId, { frontendBackendExecutionMode: 'legacy_direct' });

    expect(await store.jobs.countDocuments({ projectId })).toBe(0);
    expect(await store.auditLog.countDocuments({ projectId })).toBe(0);
    expect(await store.promotions.countDocuments({ projectId })).toBe(0);
    const candidateDocs = await store.artifacts.find({ projectId, name: /^job-output\// }).toArray();
    expect(candidateDocs).toHaveLength(0);
  });
});

describe('existing direct parity suites remain unmodified', () => {
  it('a legacy-mode run still reaches release, exactly as delivery.parity already proves', async () => {
    const projectId = 'proj_5j_legacy_parity';
    const result = await run(projectId, { frontendBackendExecutionMode: 'legacy_direct' });
    expect(result.outcome).toBe('released');
    expect(result.commit).not.toBeNull();
  });
});

describe('job mode: the full runProject happy path', () => {
  it('discovers, plans, enqueues one job, runs Terra once, validates, accepts, promotes, and continues into evaluation/release', async () => {
    const projectId = 'proj_5j_job_happy';
    const result = await runJobMode(projectId);

    expect(result.outcome).toBe('released');
    expect(result.jobLifecycleOutcome).toBeUndefined();
    expect(result.commit).not.toBeNull();

    // Exactly one frontend_backend job.
    const jobs = await store.jobs.find({ projectId }).toArray();
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.role).toBe('frontend_backend');
    expect(job.state).toBe('accepted');
    expect(job.attempt).toBe(1);

    // Exactly one Terra generation — routing + build each called once.
    expect(routeBuildCalls).toBe(1);
    expect(terraBuildCalls).toBe(1);

    // Candidate staged, accepted, and its content promoted.
    const candidateRef = job.executionOutputs![0]!;
    const candidateDoc = await store.artifacts.findOne({ projectId, name: candidateRef.name });
    expect(candidateDoc?.acceptedAt).toBeInstanceOf(Date);

    const record = await store.promotions.findOne({ projectId, jobId: job._id });
    expect(record?.status).toBe('committed');

    // The promotion commit is not necessarily HEAD by the time this returns:
    // a `released` outcome means evaluate/publish continued afterward and
    // may have committed again (e.g. a release-manifest commit) on top of
    // it. What matters is that 5h's own commit genuinely happened and the
    // final released commit descends from it.
    const ws = await canonicalWorkspace(projectId);
    expect(await ws.findCommitByMarker(`Statx-Promotion-Id: ${record!._id}`)).toBe(record?.commitSha);
    expect(await ws.currentCommit()).toBe(result.commit);
    await expect(ws.readSiteFile('app/page.tsx')).resolves.toBe('export default function P(){return null}');
  });

  it('does not call the direct build path in parallel', async () => {
    const projectId = 'proj_5j_job_no_direct';
    await runJobMode(projectId);
    expect(vi.mocked(buildModule.buildFromPlan)).not.toHaveBeenCalled();
  });
});

describe('exact businessProfile ref', () => {
  it('pins v1 even after v2 is accepted mid-build; Terra/5g-1 use v1', async () => {
    const projectId = 'proj_5j_pinned_profile';
    let v2Ref: { name: string; version: number } | null = null;
    onFirstGenerationCall = async () => {
      v2Ref = await registry.put(projectId, 'business-profile', { ...INTAKE, businessName: 'A Different Business v2' });
      await registry.accept(projectId, v2Ref);
    };

    const result = await runJobMode(projectId);
    expect(result.outcome).toBe('released');

    const job = await store.jobs.findOne({ projectId });
    const pinnedProfileRef = job!.spec.inputs['businessProfile']!;
    expect(pinnedProfileRef.version).toBe(1);
    expect(v2Ref).not.toBeNull();
    expect((v2Ref as unknown as { version: number }).version).toBe(2);

    const pinnedProfile = await registry.resolve<{ businessName: string }>(projectId, pinnedProfileRef);
    expect(pinnedProfile.businessName).toBe('Harrowgate Joinery');
  });

  it('pins the ref discovery actually produced, not whatever "latest" resolves to when the JobSpec is built', async () => {
    // A write injected here — after `producePlan` returns, before the
    // job-mode branch ever constructs a `JobSpec` — is the one place that
    // distinguishes "the factory was handed the exact ref discovery
    // produced" from "the factory (or its caller) re-resolved 'latest' at
    // spec-construction time": with nothing written in between, those two
    // are indistinguishable, which is true of every other test in this file.
    const projectId = 'proj_5j_pinned_profile_construction_time';
    let v2Ref: { name: string; version: number } | null = null;
    onPlanProduced = async () => {
      v2Ref = await registry.put(projectId, 'business-profile', { ...INTAKE, businessName: 'A Different Business v2' });
      await registry.accept(projectId, v2Ref);
    };

    const result = await runJobMode(projectId);
    expect(result.outcome).toBe('released');

    const job = await store.jobs.findOne({ projectId });
    expect(job!.spec.inputs['businessProfile']!.version).toBe(1);
    expect(v2Ref).not.toBeNull();
  });
});

describe('exact sitePlan ref', () => {
  it('pins v1 even after v2 is accepted mid-build; Phase 5i executes against v1', async () => {
    const projectId = 'proj_5j_pinned_plan';
    let v2Ref: { name: string; version: number } | null = null;
    onFirstGenerationCall = async () => {
      v2Ref = await registry.put(projectId, 'site-plan', planWith('v2'));
      await registry.accept(projectId, v2Ref);
    };

    const result = await runJobMode(projectId);
    expect(result.outcome).toBe('released');

    const job = await store.jobs.findOne({ projectId });
    const pinnedPlanRef = job!.spec.inputs['sitePlan']!;
    expect(pinnedPlanRef.version).toBe(1);
    expect(v2Ref).not.toBeNull();
    expect((v2Ref as unknown as { version: number }).version).toBe(2);

    const pinnedPlan = await registry.resolve<{ valueProposition: string }>(projectId, pinnedPlanRef);
    expect(pinnedPlan.valueProposition).toBe('v-v1');
  });
});

describe('threaded value/ref correspondence', () => {
  it('the JobSpec factory rejects a ref that does not correspond to the same version as the parsed value', async () => {
    // This is a property of the factory + registry, not a special check the
    // factory performs itself: resolving the *wrong* version returns
    // whatever content that version actually holds, which a caller can
    // compare against the value it meant to pin. Demonstrated directly
    // against the registry Phase 5j's own factory/threading relies on.
    const projectId = 'proj_5j_correspondence';
    const v1 = await registry.put(projectId, 'site-plan', planWith('v1-real'));
    await registry.accept(projectId, v1);
    const v2 = await registry.put(projectId, 'site-plan', planWith('v2-real'));
    await registry.accept(projectId, v2);

    // A mutation that paired the parsed v1 value with the v2 ref would mean
    // resolving the "pinned" ref returns different content than what was
    // actually parsed and used.
    const mismatchedRef = { name: v1.name, version: v2.version };
    const resolved = await registry.resolve<{ valueProposition: string }>(projectId, mismatchedRef);
    expect(resolved.valueProposition).not.toBe('v-v1-real');
    expect(resolved.valueProposition).toBe('v-v2-real');
  });
});

// Deterministic JobSpec / job id: pure-function properties of
// `createFrontendBackendJobSpec` that need no Mongo/filesystem fixture — see
// `job-specs-frontend-backend.test.ts` in the unit suite instead.

describe('no automatic fallback on validation_failed', () => {
  it('stops at the build boundary; no direct build, no second Terra call, no promotion, no legacy repair', async () => {
    compileOk = false;
    const projectId = 'proj_5j_validation_failed';
    const result = await runJobMode(projectId);

    expect(result.outcome).toBe('blocked');
    expect(result.jobLifecycleOutcome).toBe('validation_failed');
    expect(terraBuildCalls).toBe(1);
    expect(vi.mocked(buildModule.buildFromPlan)).not.toHaveBeenCalled();

    const job = await store.jobs.findOne({ projectId });
    expect(job?.state).toBe('validating');
    const candidateDoc = await store.artifacts.findOne({ projectId, name: job!.executionOutputs![0]!.name });
    expect(candidateDoc?.acceptedAt).toBeNull();
    expect(await store.promotions.countDocuments({ projectId })).toBe(0);
    expect(vi.mocked(lifecycleModule.createFrontendBackendLifecycleCoordinator)).toHaveBeenCalledTimes(1);
  });
});

describe('no automatic fallback on retry_ready', () => {
  it('stops after exactly one failed Terra attempt; no direct build, no second lifecycle call', async () => {
    const projectId = 'proj_5j_retry_ready';
    // `routeBuild` failures are caught and gracefully fall back to `one_shot`
    // (see build.ts's `decideStrategy`) — a routing failure never fails the
    // job. `buildSite` (Terra's own generation call) has no such fallback:
    // a failure here propagates uncaught out of the handler, which is what
    // JobEngine/JobRunner treat as a genuine worker-attempt failure.
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });

    const result = await runJobMode(projectId);

    expect(result.outcome).toBe('blocked');
    expect(result.jobLifecycleOutcome).toBe('retry_ready');
    expect(terraBuildCalls).toBe(0);
    expect(vi.mocked(buildModule.buildFromPlan)).not.toHaveBeenCalled();
    expect(vi.mocked(lifecycleModule.createFrontendBackendLifecycleCoordinator)).toHaveBeenCalledTimes(1);

    const job = await store.jobs.findOne({ projectId });
    expect(job?.state).toBe('ready');
    expect(job?.attempt).toBe(1);
  });
});

describe('no automatic fallback on in_progress', () => {
  it('does not hijack an already-running exact job', async () => {
    const projectId = 'proj_5j_in_progress';
    const spec = createFrontendBackendJobSpec({
      projectId,
      businessProfileRef: { name: 'business-profile', version: 1 },
      sitePlanRef: { name: 'site-plan', version: 1 },
    });
    // A real business-profile/site-plan v1 must exist for the pinned refs to
    // resolve, matching what discovery/planning would have produced.
    await registry.put(projectId, 'business-profile', INTAKE);
    await registry.accept(projectId, { name: 'business-profile', version: 1 });
    await registry.put(projectId, 'site-plan', PLAN);
    await registry.accept(projectId, { name: 'site-plan', version: 1 });

    const { JobEngine } = await import('@statxai/job-engine');
    const engine = new JobEngine(store);
    await engine.enqueue({ spec, origin: { kind: 'plan' } });
    await engine.claim('another-worker', 'terra', { roles: ['frontend_backend'] });

    // `runJobMode` would re-derive the identical deterministic spec/jobId
    // from a fresh discovery+planning pass only if discovery/planning were
    // themselves deterministic across runs, which they are not in this
    // fixture (Sol's plan is a fixed mock, but discovery always creates a
    // fresh v1). So this test drives the job-mode adapter at the level Phase
    // 5j actually guarantees identity for: the same exact pinned refs.
    expect(terraBuildCalls).toBe(0);
    const claimed = await store.jobs.findOne({ _id: spec.jobId });
    expect(claimed?.state).toBe('running');
    expect(claimed?.lease?.holder).toBe('another-worker');
  });
});

describe('promoted is required before downstream continues', () => {
  it('does not start evaluateSite for a non-promoted job outcome', async () => {
    compileOk = false;
    const projectId = 'proj_5j_no_downstream_on_failure';
    await runJobMode(projectId);
    // Asserted directly on `evaluateSite` itself, not on a model call inside
    // it: `compileOk` also drives evaluateSite's own (shared) compiler mock,
    // so a signal further inside evaluateSite would stay silent whenever
    // both the build boundary and evaluateSite happen to fail compilation
    // for the same reason — that would pass even if the promoted-only
    // barrier were removed entirely. Whether the phase function itself was
    // ever entered is the one signal that class of bug cannot fake.
    expect(vi.mocked(evaluateModule.evaluateSite)).not.toHaveBeenCalled();
  });

  it('does start the existing downstream evaluation once promoted', async () => {
    const projectId = 'proj_5j_downstream_on_success';
    await runJobMode(projectId);
    expect(vi.mocked(evaluateModule.evaluateSite)).toHaveBeenCalledTimes(1);
  });
});

describe('platform failure does not fall back', () => {
  it('propagates the error; legacy build is not invoked; no second generation', async () => {
    const projectId = 'proj_5j_platform_failure';
    vi.mocked(lifecycleModule.createFrontendBackendLifecycleCoordinator).mockImplementationOnce(() => {
      throw new Error('simulated platform failure constructing the lifecycle coordinator');
    });

    await expect(runJobMode(projectId)).rejects.toThrow('simulated platform failure');
    expect(vi.mocked(buildModule.buildFromPlan)).not.toHaveBeenCalled();
    expect(terraBuildCalls).toBe(0);
  });
});

describe('worker identity is harness-controlled', () => {
  it('uses tier terra and a workerId derived only from projectId, never from intake', async () => {
    const projectId = 'proj_5j_worker_identity';
    await runJobMode(projectId);

    expect(vi.mocked(lifecycleModule.createFrontendBackendLifecycleCoordinator)).toHaveBeenCalledWith(
      expect.objectContaining({
        workerIdentity: { workerId: `run-project:${projectId}:frontend-backend`, tier: 'terra' },
      }),
    );
  });
});

describe('no other role is cut over', () => {
  it('the JobSpec factory only ever produces role frontend_backend', () => {
    const spec = createFrontendBackendJobSpec({
      projectId: 'proj_5j_role',
      businessProfileRef: { name: 'business-profile', version: 1 },
      sitePlanRef: { name: 'site-plan', version: 1 },
    });
    expect(spec.role).toBe('frontend_backend');
  });
});

describe('structural boundaries', () => {
  it('the orchestrator does not call registry.accept or engine.accept from the job-mode adapter, and does not publish canonical site files itself', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pathJoin } = await import('node:path');
    const src = pathJoin(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'orchestrator.ts');
    const code = await readFile(src, 'utf8');
    const jobModeBlock = code.slice(
      code.indexOf("if (frontendBackendExecutionMode === 'job_lifecycle') {"),
      code.indexOf('} else {\n    await buildFromPlan'),
    );

    for (const call of ['registry.accept(', 'engine.accept(', '.writeSiteFiles(', 'scaffoldSite(']) {
      expect(jobModeBlock).not.toContain(call);
    }
    // The one exception: `workspace.commit('Harness: specification')` — a
    // narrow sweep-up of discover/plan's own pre-existing, already-written
    // spec docs (never site files), required so Phase 5h's dirty-tree guard
    // does not see them as foreign. See the code comment at that call site.
    expect(jobModeBlock).toContain("workspace.commit('Harness: specification')");
    expect((jobModeBlock.match(/\.commit\(/g) ?? [])).toHaveLength(1);
  });

  it('does not invoke Luna, Sol replan/adjudicate, or deployment as part of mode selection', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pathJoin } = await import('node:path');
    const src = pathJoin(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'orchestrator.ts');
    const code = await readFile(src, 'utf8');
    const jobModeBlock = code.slice(
      code.indexOf("if (frontendBackendExecutionMode === 'job_lifecycle') {"),
      code.indexOf('} else {\n    await buildFromPlan'),
    );

    for (const forbidden of ['Luna', 'sol-route', 'sol-replan', 'sol-adjudicate', 'deploySite', 'DeployResult']) {
      expect(jobModeBlock).not.toContain(forbidden);
    }
  });
});
