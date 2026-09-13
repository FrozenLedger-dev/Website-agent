/**
 * Advisory test feedback against the real job lifecycle: official validation,
 * acceptance and promotion are exactly what they were.
 *
 * Real: Mongo, `JobEngine`, the artifact registry, the lifecycle coordinator,
 * the Terra handler with its production gateway, the 5g-1 validator, 5g-2
 * acceptance and 5h promotion. Faked: the provider, and the compiler and gates
 * at the `@statxai/workspace` / `@statxai/gates` boundary — which record whose
 * workspace each build ran in, so an advisory measurement and an official one
 * can be told apart.
 *
 * Integration: needs the Mongo replica set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace, type BuildResult } from '@statxai/workspace';
import type * as Workspace from '@statxai/workspace';
import type * as Gates from '@statxai/gates';
import { JobEngine } from '@statxai/job-engine';
import { ModelRuntime, type Provider, type ProviderRequest, type ProviderResponse } from '@statxai/agents';
import type { ArtifactRef, SitePlan, TestRunnerResult } from '@statxai/contracts';
import { discoverProject } from '../src/phases/discover.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import { createFrontendBackendLifecycleCoordinator, type FrontendBackendLifecycleDeps } from '../src/job-lifecycle/frontend-backend.js';
import { AcceptanceEvidenceNotAuthentic, acceptValidatedFrontendBackendCandidate } from '../src/job-acceptance/frontend-backend.js';
import { PromotionStateMismatch, promoteAcceptedFrontendBackendCandidate } from '../src/job-promotion/frontend-backend.js';
import { authenticSuccessfulValidationBinding, type FrontendBackendCandidateValidation } from '../src/job-validation/frontend-backend.js';
import { ToolGateway } from '../src/tool-gateway/gateway.js';
import { createTestRunnerAdapter } from '../src/tool-gateway/test-runner.js';

/** Every build: which root it ran under, and whether it passed. */
const builds: { root: 'advisory' | 'validation' | 'other'; page: string }[] = [];
let officialBuildOk = true;

let advisoryRoot: string;
let validationWorkspacesRoot: string;

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async (siteRoot: string): Promise<BuildResult> => {
      const root = siteRoot.startsWith(advisoryRoot) ? 'advisory' : siteRoot.startsWith(validationWorkspacesRoot) ? 'validation' : 'other';
      builds.push({ root, page: await readFile(join(siteRoot, 'app', 'page.tsx'), 'utf8') });
      // An advisory measurement always passes here; whether the official one does is up to the test.
      const ok = root === 'advisory' ? true : officialBuildOk;
      return { ok, durationMs: 1, output: ok ? '' : 'compile error: official', outDir: join(siteRoot, 'out') };
    }),
    readBuiltFiles: vi.fn(async () => [{ path: 'index.html', contents: '<html></html>' }]),
    readExportFiles: vi.fn(async () => []),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return { ...actual, runGates: vi.fn(() => ({ passed: true, findings: [], gatesRun: ['claims'] })) };
});

let store: StateStore;
let registry: ArtifactRegistry;
let engine: JobEngine;
let workspacesRoot: string;
let discoveryRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  engine = new JobEngine(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-feedback-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-feedback-validate-'));
  advisoryRoot = await mkdtemp(join(tmpdir(), 'statxai-feedback-advisory-'));
  discoveryRoot = await mkdtemp(join(tmpdir(), 'statxai-feedback-discovery-'));
});

afterAll(async () => {
  await store?.close();
  for (const dir of [workspacesRoot, validationWorkspacesRoot, advisoryRoot, discoveryRoot]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
  await store.promotions.deleteMany({});
  builds.length = 0;
  officialBuildOk = true;
});

afterEach(() => {
  vi.clearAllMocks();
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

const PLAN = {
  strategy: 's',
  valueProposition: 'v',
  brandSystem: {
    palette: { background: '#fff', surface: '#fff', text: '#111', muted: '#ccc', accent: '#0a0', accentText: '#fff', border: '#ddd' },
    typography: { headingFamily: 'Inter', bodyFamily: 'Inter', baseSize: '16px', scale: '1.2' },
    artDirection: 'direction',
    radius: 'square',
    rationale: 'r',
  },
  sitemap: { pages: [{ route: '/', title: 'Home', metaDescription: 'd', goal: 'g', primaryAction: 'call', sections: [{ id: 'hero', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }] }] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

async function productionSpec(projectId: string) {
  const result = await discoverProject({ projectId, intake: INTAKE, store, registry, workspacesRoot: discoveryRoot, autonomyMode: 'full_autonomous', say: () => {} });
  if (!result.ok) throw new Error('fixture setup: discoverProject refused the intake');
  const profileDoc = await store.artifacts.findOne({ projectId, name: 'business-profile' }, { sort: { version: -1 } });
  const businessProfileRef: ArtifactRef = { name: 'business-profile', version: profileDoc!.version };
  const sitePlanRef = await registry.put(projectId, 'site-plan', PLAN);
  await registry.accept(projectId, sitePlanRef);
  // The production factory — so the grant under test is the real one.
  return createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef });
}

const CANDIDATE = { files: [{ path: 'app/page.tsx', contents: 'export default function Home(){return <main>tested</main>}' }], notes: 'n' };

const respond = (value: unknown): ProviderResponse => ({ text: JSON.stringify(value), model: 'fake', inputTokens: 1, outputTokens: 1, stopReason: 'complete' });

/** Sol routes one-shot; Terra tests CANDIDATE, sees it pass, then returns the byte-identical candidate. */
function testThenFinal() {
  const requests: ProviderRequest[] = [];
  let turn = 0;
  const turns = [
    { action: 'tool', tool: 'test_runner', input: { candidate: CANDIDATE }, output: null },
    { action: 'final', tool: null, input: null, output: CANDIDATE },
  ];
  const provider: Provider = {
    name: 'fake',
    schemaDialect: 'strict',
    async complete(request) {
      requests.push(request);
      if (request.schemaName.startsWith('sol_route')) return respond({ action: 'one_shot', reason: 'single page', confidence: 0.9, workstreams: null });
      return respond(turns[Math.min(turn++, turns.length - 1)]);
    },
  };
  return { runtime: new ModelRuntime({ provider }), requests };
}

function deps(model: ModelRuntime): FrontendBackendLifecycleDeps {
  return {
    store,
    registry,
    engine,
    model,
    workerIdentity: { workerId: 'terra-feedback-1', tier: 'terra' },
    workspacesRoot,
    validationWorkspacesRoot,
    advisoryWorkspacesRoot: advisoryRoot,
  };
}

describe('advisory feedback never replaces official validation', () => {
  it('a byte-identical candidate that already passed test_runner is still validated officially, then accepted and promoted', async () => {
    const projectId = 'proj_feedback_promoted';
    const spec = await productionSpec(projectId);
    expect(spec.allowedTools).toEqual(['filesystem', 'test_runner']);
    const { runtime, requests } = testThenFinal();

    const result = await createFrontendBackendLifecycleCoordinator(deps(runtime)).run(spec);

    expect(result.outcome).toBe('promoted');
    expect(requests.filter((r) => r.schemaName.startsWith('terra_build'))[1]!.prompt).toContain('"status":"passed"');
    // One advisory measurement and, independently, one official validation of the same bytes.
    expect(builds).toEqual([
      { root: 'advisory', page: CANDIDATE.files[0]!.contents },
      { root: 'validation', page: CANDIDATE.files[0]!.contents },
    ]);
    expect(await readdir(advisoryRoot)).toEqual([]);
  });

  it('when official validation fails, an earlier advisory pass does not accept, promote or change project state', async () => {
    const projectId = 'proj_feedback_official_fails';
    const spec = await productionSpec(projectId);
    officialBuildOk = false;
    const projectBefore = await store.projects.findOne({ _id: projectId });
    const canonical = await ProjectWorkspace.open(projectId, workspacesRoot);
    const headBefore = await canonical.currentCommit();

    const result = await createFrontendBackendLifecycleCoordinator(deps(testThenFinal().runtime)).run(spec);

    expect(result.outcome).toBe('validation_failed');
    expect(builds.map((b) => b.root)).toEqual(['advisory', 'validation']);
    const job = await store.jobs.findOne({ _id: spec.jobId });
    expect(job?.state).toBe('validating');
    expect(await store.promotions.countDocuments({})).toBe(0);
    expect(await store.projects.findOne({ _id: projectId })).toEqual(projectBefore);
    expect(await canonical.currentCommit()).toBe(headBefore);

    const candidateRef = job!.executionOutputs![0]!;
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
  });

  it('a passing advisory result is not validation evidence: it cannot be accepted, and its job cannot be promoted', async () => {
    const projectId = 'proj_feedback_forged';
    const spec = await productionSpec(projectId);
    officialBuildOk = false;
    await createFrontendBackendLifecycleCoordinator(deps(testThenFinal().runtime)).run(spec);
    const job = (await store.jobs.findOne({ _id: spec.jobId }))!;
    const jobBefore = structuredClone(job);

    // The advisory result, measured directly, passes.
    const advisory = await new ToolGateway({ adapters: [createTestRunnerAdapter({ profile: {} as never, plan: PLAN, workspacesRoot: advisoryRoot })] }).execute<TestRunnerResult>({
      tool: 'test_runner',
      input: { candidate: CANDIDATE },
      context: { projectId, jobId: job._id, skill: 'terra-build', role: 'frontend_backend', allowedTools: spec.allowedTools, supportedTools: ['filesystem', 'test_runner'] },
    });
    expect(advisory.passed).toBe(true);
    expect(authenticSuccessfulValidationBinding(advisory)).toBeNull();

    // Dressed as a validation result for this exact job, it is still not authentic.
    const forged = {
      binding: { projectId, jobId: job._id, attempt: job.attempt, candidate: job.executionOutputs![0]!, businessProfile: spec.inputs.businessProfile!, sitePlan: spec.inputs.sitePlan! },
      ok: advisory.passed,
      compiled: { ok: true, durationMs: 1, output: '', outDir: '/out' },
      gateRun: { passed: true, findings: [], gatesRun: ['claims'] },
      advisory,
    } as unknown as FrontendBackendCandidateValidation;
    await expect(acceptValidatedFrontendBackendCandidate(forged, { store, registry, engine })).rejects.toBeInstanceOf(AcceptanceEvidenceNotAuthentic);
    await expect(promoteAcceptedFrontendBackendCandidate(job._id, { store, registry, workspacesRoot } as never)).rejects.toBeInstanceOf(PromotionStateMismatch);

    expect(await store.jobs.findOne({ _id: job._id })).toEqual(jobBefore);
    expect(await store.promotions.countDocuments({})).toBe(0);
  });
});
