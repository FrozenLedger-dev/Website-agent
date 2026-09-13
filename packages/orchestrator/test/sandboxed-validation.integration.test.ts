/**
 * The official `frontend_backend` validator, with its real sandboxed build.
 *
 * Every other validator suite fakes `buildSite`; this one does not. The
 * candidate is compiled by a real `next build` inside the sandbox, so what is
 * proved here is the whole production chain: the validator writes the
 * candidate through the write boundary into its disposable workspace, the
 * sandboxed executor builds it, and validation authority — authentic success,
 * acceptance, the job and the project — is exactly what it was before. Only
 * `runGates` is faked, so a passing build is not held hostage to the
 * content gates' opinion of a fixture page.
 *
 * Integration: needs the Mongo replica set, a Docker daemon, and network
 * access for Google Fonts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, WriteOutsideModelScope, defaultSandboxRoot } from '@statxai/workspace';
import type * as Gates from '@statxai/gates';
import { JobEngine } from '@statxai/job-engine';
import type { ArtifactRef, GeneratedFile, JobSpec, SitePlan } from '@statxai/contracts';
import type { BuildCandidate } from '../src/phases/build.js';
import { discoverProject } from '../src/phases/discover.js';
import { buildFailureDefect } from '../src/defects.js';
import { frontendBackendCandidateName, FRONTEND_BACKEND_INPUT } from '../src/job-handlers/frontend-backend.js';
import { authenticSuccessfulValidationBinding, validateFrontendBackendCandidate } from '../src/job-validation/frontend-backend.js';
import { AcceptanceEvidenceNotAuthentic, acceptValidatedFrontendBackendCandidate } from '../src/job-acceptance/frontend-backend.js';

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return { ...actual, runGates: vi.fn(() => ({ passed: true, findings: [], gatesRun: ['claims'] })) };
});

const FAKE_SECRETS = {
  OPENAI_API_KEY: 'sk-sandboxed-validation-openai-44d1',
  VERCEL_TOKEN: 'vercel-sandboxed-validation-token-9e0c',
};
const saved: Record<string, string | undefined> = {};

let store: StateStore;
let registry: ArtifactRegistry;
let engine: JobEngine;
let workspacesRoot: string;
let validationWorkspacesRoot: string;

beforeAll(async () => {
  for (const [key, value] of Object.entries(FAKE_SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  engine = new JobEngine(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-sandboxed-validate-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-sandboxed-validate-'));
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
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

const plan = {
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

const VALID_PAGE = `export default function Page() {\n  return <main><h1>Harrowgate Joinery</h1></main>;\n}\n`;
const BROKEN_PAGE = `export default function Page() {\n  const count: number = 'not a number';\n  return <main>{count}</main>;\n}\n`;

async function stageValidatingJob(projectId: string, jobId: string, files: GeneratedFile[]) {
  const result = await discoverProject({ projectId, intake: INTAKE, store, registry, workspacesRoot, autonomyMode: 'full_autonomous', say: () => {} });
  if (!result.ok) throw new Error('fixture setup: discoverProject refused the fixture intake');
  const profileDoc = await store.artifacts.findOne({ projectId, name: 'business-profile' }, { sort: { version: -1 } });
  const profileRef: ArtifactRef = { name: 'business-profile', version: profileDoc!.version };
  const planRef = await registry.put(projectId, 'site-plan', plan);
  await registry.accept(projectId, planRef);

  const spec: JobSpec = {
    projectId,
    jobId,
    role: 'frontend_backend',
    objective: 'Build the site from the approved plan.',
    inputs: { [FRONTEND_BACKEND_INPUT.businessProfile]: profileRef, [FRONTEND_BACKEND_INPUT.sitePlan]: planRef },
    acceptanceCriteria: ['site files written from the approved plan'],
    allowedTools: [],
    output: ['app/page.tsx'],
  };
  await engine.enqueue({ spec, origin: { kind: 'plan' } });
  const claimed = await engine.claim('sandboxed-validate-worker', 'terra', { roles: ['frontend_backend'], leaseMs: 600_000 });
  if (!claimed || claimed._id !== jobId) throw new Error('fixture setup: could not claim the fixture job');

  const candidate: BuildCandidate = {
    routeDecisions: [{ strategy: 'one_shot', source: 'sol', refusal: null, proposed: null, modelFailure: null, decidedAt: new Date() }],
    files,
  };
  const ref = await registry.put(projectId, frontendBackendCandidateName(jobId, claimed.attempt), candidate);
  return engine.submitForValidation(jobId, 'sandboxed-validate-worker', claimed.attempt, { outputs: [ref] });
}

const deps = () => ({ registry, validationWorkspacesRoot });
const acceptanceDeps = () => ({ store, registry, engine });
const sandboxRunsLeft = () => readdir(join(defaultSandboxRoot(), 'runs')).catch(() => []);

describe('the official validator runs the candidate build in the sandbox', () => {
  it('a valid candidate builds for real and is recorded as authentic success, changing no job or project state', async () => {
    const job = await stageValidatingJob('proj_sandboxed_valid', 'job_sandboxed_valid', [{ path: 'app/page.tsx', contents: VALID_PAGE }]);
    const jobBefore = await store.jobs.findOne({ _id: job._id });
    const projectBefore = await store.projects.findOne({ _id: job.projectId });
    const artifactsBefore = await store.artifacts.countDocuments({ projectId: job.projectId });

    const result = await validateFrontendBackendCandidate(job, deps());

    expect(result.compiled.output).not.toContain('Build terminated');
    expect(result.compiled.ok).toBe(true);
    expect(result.compiled.output).toContain('Compiled successfully');
    expect(result.ok).toBe(true);
    expect(authenticSuccessfulValidationBinding(result)).toEqual(result.binding);

    // The sandboxed executor touched no durable state.
    expect(await store.jobs.findOne({ _id: job._id })).toEqual(jobBefore);
    expect(await store.projects.findOne({ _id: job.projectId })).toEqual(projectBefore);
    expect(await store.artifacts.countDocuments({ projectId: job.projectId })).toBe(artifactsBefore);

    expect(await readdir(validationWorkspacesRoot)).toEqual([]);
    expect(await sandboxRunsLeft()).toEqual([]);

    // Authentic success still goes through normal acceptance — which the validator itself never did.
    expect((await store.jobs.findOne({ _id: job._id }))!.state).toBe('validating');
    await expect(acceptValidatedFrontendBackendCandidate(result, acceptanceDeps())).resolves.toMatchObject({ state: 'accepted' });
  }, 600_000);

  it('a candidate that does not compile stays a validation failure, with bounded, sanitized BUILD-001 diagnostics', async () => {
    const job = await stageValidatingJob('proj_sandboxed_broken', 'job_sandboxed_broken', [{ path: 'app/page.tsx', contents: BROKEN_PAGE }]);
    const jobBefore = await store.jobs.findOne({ _id: job._id });

    const result = await validateFrontendBackendCandidate(job, deps());

    expect(result.ok).toBe(false);
    expect(result.compiled.ok).toBe(false);
    expect(result.gateRun).toEqual({ passed: false, findings: [], gatesRun: ['build'] });
    expect(authenticSuccessfulValidationBinding(result)).toBeNull();
    await expect(acceptValidatedFrontendBackendCandidate(result, acceptanceDeps())).rejects.toBeInstanceOf(AcceptanceEvidenceNotAuthentic);

    const defect = buildFailureDefect(result.compiled.output);
    expect(defect).toMatchObject({ id: 'BUILD-001', severity: 'P0', category: 'build', location: 'app/' });
    expect(defect.reason).toMatch(/app\/page\.tsx\(2,\d+\): error TS2322/);
    expect(result.compiled.output.length).toBeLessThanOrEqual(4_002);
    for (const leaked of [...Object.values(FAKE_SECRETS), validationWorkspacesRoot, workspacesRoot, homedir(), process.cwd()]) {
      expect(defect.reason).not.toContain(leaked);
    }

    expect(await store.jobs.findOne({ _id: job._id })).toEqual(jobBefore);
    expect(await readdir(validationWorkspacesRoot)).toEqual([]);
    expect(await sandboxRunsLeft()).toEqual([]);
  }, 600_000);

  it('a sandbox success alone accepts nothing: a fabricated passing result is refused', async () => {
    const job = await stageValidatingJob('proj_sandboxed_fabricated', 'job_sandboxed_fabricated', [{ path: 'app/page.tsx', contents: BROKEN_PAGE }]);
    const failed = await validateFrontendBackendCandidate(job, deps());

    const fabricated = { ...failed, ok: true, compiled: { ...failed.compiled, ok: true }, gateRun: { passed: true, findings: [], gatesRun: ['claims'] } };
    await expect(acceptValidatedFrontendBackendCandidate(fabricated, acceptanceDeps())).rejects.toBeInstanceOf(AcceptanceEvidenceNotAuthentic);
    expect((await store.jobs.findOne({ _id: job._id }))!.state).toBe('validating');
  }, 600_000);

  it('a candidate replacing the dependency manifest is refused before any sandbox run exists', async () => {
    const job = await stageValidatingJob('proj_sandboxed_manifest', 'job_sandboxed_manifest', [
      { path: 'app/page.tsx', contents: VALID_PAGE },
      { path: 'package.json', contents: '{"scripts":{"build":"curl http://169.254.169.254"}}' },
    ]);

    await expect(validateFrontendBackendCandidate(job, deps())).rejects.toBeInstanceOf(WriteOutsideModelScope);
    expect(await readdir(validationWorkspacesRoot)).toEqual([]);
    expect(await sandboxRunsLeft()).toEqual([]);
  }, 120_000);
});
