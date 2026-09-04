/**
 * Isolated deterministic validation of a real, staged `frontend_backend`
 * candidate (Phase 5g-1) — end to end, against a real Mongo replica set and a
 * real isolated filesystem workspace.
 *
 * Only the build pipeline itself is faked (`compileSite`/`readBuiltFiles`/
 * `readExportFiles` from `@statxai/workspace`, `runGates` from
 * `@statxai/gates`), exactly the way `delivery.parity.integration.test.ts`
 * fakes the same boundary — a real `pnpm build` is what `site-build.test.ts`
 * exists to prove, not this file. Everything else is real: the job engine,
 * the artifact registry, `ProjectWorkspace`'s own path-safety and file
 * writer, and the disposable validation workspace this module creates and
 * tears down. The mocked `compileSite` reads the real file the real
 * `writeSiteFiles` wrote into the real isolated site root, so a test can
 * prove *which* candidate's content actually reached the build step without
 * inspecting anything after cleanup has already run.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace, type BuildResult } from '@statxai/workspace';
import type * as Workspace from '@statxai/workspace';
import type * as Gates from '@statxai/gates';
import { JobEngine, jobOutputNamespace } from '@statxai/job-engine';
import type { ArtifactRef, JobSpec, SitePlan } from '@statxai/contracts';
import type { BuildCandidate } from '../src/phases/build.js';
import { discoverProject } from '../src/phases/discover.js';
import { frontendBackendCandidateName, FRONTEND_BACKEND_INPUT } from '../src/job-handlers/frontend-backend.js';
import {
  CandidateValidationInputInvalid,
  CandidateValidationNamespaceMismatch,
  CandidateValidationShapeInvalid,
  validateFrontendBackendCandidate,
} from '../src/job-validation/frontend-backend.js';

let compileSeen: string[] = [];
let gateVerdict: { passed: boolean; findings: unknown[]; gatesRun: string[] } = { passed: true, findings: [], gatesRun: ['claims'] };
let buildOk = true;
let buildThrows: Error | null = null;
/** What `runGates` was actually called with — proves which profile/plan version reached deterministic validation. */
let gateContextsSeen: Array<{ profile: unknown; plan: unknown }> = [];

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async (siteRoot: string): Promise<BuildResult> => {
      if (buildThrows) throw buildThrows;
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
    runGates: vi.fn((ctx: { profile: unknown; plan: unknown }) => {
      gateContextsSeen.push({ profile: ctx.profile, plan: ctx.plan });
      return gateVerdict;
    }),
  };
});

const LEASE_MS = 60_000;

let store: StateStore;
let registry: ArtifactRegistry;
let engine: JobEngine;
let workspacesRoot: string; // canonical — never written to by the validator
let validationWorkspacesRoot: string; // the validator's own disposable root

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  engine = new JobEngine(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-validate-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-validate-'));
});

afterAll(async () => {
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
  compileSeen = [];
  gateVerdict = { passed: true, findings: [], gatesRun: ['claims'] };
  buildOk = true;
  buildThrows = null;
  gateContextsSeen = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures — same shape as frontend-backend-job-handler.integration.test.ts
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
    workspacesRoot,
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

const candidate = (contents: string): BuildCandidate => ({
  routeDecisions: [
    { strategy: 'one_shot', source: 'sol', refusal: null, proposed: null, modelFailure: null, decidedAt: new Date() },
  ],
  files: [{ path: 'app/page.tsx', contents }],
});

/** Stage a candidate under this exact job/attempt's namespace, and enqueue+claim+stage it as `executionOutputs`. */
async function stageValidatingJob(
  projectId: string,
  jobId: string,
  opts: { contents?: string; attempt?: number } = {},
) {
  const profileRef = await setupProject(projectId);
  const planRef = await putPlan(projectId, onePagePlan(jobId));
  await engine.enqueue({ spec: jobSpec(projectId, jobId, profileRef, planRef), origin: { kind: 'plan' } });
  const claimed = await engine.claim('validate-fixture-worker', 'terra', {
    roles: ['frontend_backend'],
    leaseMs: LEASE_MS,
  });
  if (!claimed || claimed._id !== jobId) throw new Error('fixture setup: could not claim the fixture job');

  const ref = await registry.put(projectId, frontendBackendCandidateName(jobId, claimed.attempt), candidate(opts.contents ?? 'fixture content'));
  const validating = await engine.submitForValidation(jobId, 'validate-fixture-worker', claimed.attempt, { outputs: [ref] });
  return { job: validating, profileRef, planRef, candidateRef: ref };
}

const deps = () => ({ registry, validationWorkspacesRoot });

async function tempRootIsEmpty(): Promise<boolean> {
  return (await readdir(validationWorkspacesRoot)).length === 0;
}

// ---------------------------------------------------------------------------

describe('the happy path', () => {
  it('resolves the exact staged candidate, materialises it into an isolated workspace, and reports a pass', async () => {
    const projectId = 'proj_validate_happy';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_validate_happy', { contents: 'happy content' });

    const result = await validateFrontendBackendCandidate(job, deps());

    expect(result).toEqual({
      binding: {
        projectId: 'proj_validate_happy',
        jobId: 'job_validate_happy',
        attempt: 1,
        candidate: candidateRef,
        businessProfile: job.spec.inputs[FRONTEND_BACKEND_INPUT.businessProfile],
        sitePlan: job.spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan],
      },
      ok: true,
      compiled: { ok: true, durationMs: 5, output: '', outDir: expect.any(String) },
      gateRun: gateVerdict,
    });
    expect(compileSeen).toEqual(['happy content']);
    expect(await tempRootIsEmpty()).toBe(true);
  });
});

describe('deterministic candidate failure is a result, not a throw', () => {
  it('a build failure reports ok:false with the compiler output, and does not run gates', async () => {
    buildOk = false;
    const projectId = 'proj_validate_build_fail';
    const { job } = await stageValidatingJob(projectId, 'job_validate_build_fail');

    const result = await validateFrontendBackendCandidate(job, deps());

    expect(result.ok).toBe(false);
    expect(result.compiled.ok).toBe(false);
    expect(result.compiled.output).toContain('compile error');
    expect(result.gateRun).toEqual({ passed: false, findings: [], gatesRun: ['build'] });
    expect(await tempRootIsEmpty()).toBe(true);
  });

  it('a blocking gate finding reports ok:false, build having otherwise succeeded', async () => {
    gateVerdict = { passed: false, findings: [{ gate: 'claims', severity: 'P0', location: 'index.html', message: 'x' }], gatesRun: ['claims'] };
    const projectId = 'proj_validate_gate_fail';
    const { job } = await stageValidatingJob(projectId, 'job_validate_gate_fail');

    const result = await validateFrontendBackendCandidate(job, deps());

    expect(result.ok).toBe(false);
    expect(result.compiled.ok).toBe(true);
    expect(result.gateRun.passed).toBe(false);
    expect(await tempRootIsEmpty()).toBe(true);
  });
});

describe('exact-ref resolution — never latest', () => {
  it('validates the exact attached version, even after a newer version of the same name exists', async () => {
    const projectId = 'proj_validate_pinned';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_validate_pinned', { contents: 'v1 content' });
    expect(candidateRef.version).toBe(1);

    // A newer version of the same artifact name, created after this job
    // reached validating. Must not be what gets validated.
    await registry.put(projectId, candidateRef.name, candidate('v2 content, created after validating'));

    await validateFrontendBackendCandidate(job, deps());

    expect(compileSeen).toEqual(['v1 content']);
  });

  it('another job’s candidate — even under the same project — cannot be substituted', async () => {
    const projectId = 'proj_validate_substitution';
    const { job: jobA } = await stageValidatingJob(projectId, 'job_validate_sub_a', { contents: 'A content' });
    await stageValidatingJob(projectId, 'job_validate_sub_b', { contents: 'B content' });

    // jobA's own executionOutputs is what gets validated — B's candidate,
    // despite existing in the same project, is never reachable from it.
    await validateFrontendBackendCandidate(jobA, deps());
    expect(compileSeen).toEqual(['A content']);
  });

  it('project-relative resolution: the same artifact name in a different project resolves to that project’s own content', async () => {
    const { job: jobX } = await stageValidatingJob('proj_validate_x', 'job_validate_cross_x', { contents: 'project X content' });
    const { job: jobY } = await stageValidatingJob('proj_validate_y', 'job_validate_cross_y', { contents: 'project Y content' });

    await validateFrontendBackendCandidate(jobX, deps());
    await validateFrontendBackendCandidate(jobY, deps());

    expect(compileSeen).toEqual(['project X content', 'project Y content']);
  });

  it('a superseded (old-attempt) executionOutputs ref cannot be revalidated as if it were current', async () => {
    // Attempt 1 fails, attempt 2 succeeds and reaches validating — attempt
    // 1's own namespace never became this job's executionOutputs, so a
    // hand-built JobDocument claiming attempt 1's ref while state says
    // validating and attempt says 2 is a namespace mismatch, not a valid
    // "old attempt" to fall back to.
    const projectId = 'proj_validate_old_attempt';
    const jobId = 'job_validate_old_attempt';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan(jobId));
    await engine.enqueue({ spec: jobSpec(projectId, jobId, profileRef, planRef), origin: { kind: 'plan' }, maxAttempts: 2 });

    const attempt1 = await engine.claim('validate-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    await engine.fail(jobId, 'attempt 1 fails', 'validate-fixture-worker', attempt1!.attempt);

    const attempt2 = await engine.claim('validate-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    const attempt1Ref = await registry.put(projectId, frontendBackendCandidateName(jobId, 1), candidate('stale attempt 1'));
    const attempt2Ref = await registry.put(projectId, frontendBackendCandidateName(jobId, attempt2!.attempt), candidate('current attempt 2'));
    const validating = await engine.submitForValidation(jobId, 'validate-fixture-worker', attempt2!.attempt, { outputs: [attempt2Ref] });

    // The genuinely current job validates fine, against attempt 2's content.
    await validateFrontendBackendCandidate(validating, deps());
    expect(compileSeen).toEqual(['current attempt 2']);

    // A hand-built document pointing at attempt 1's own ref, but claiming
    // the job's real (attempt 2) state, is rejected as a namespace mismatch
    // — attempt 1's ref is not namespaced under attempt 2.
    const stalePointer = { ...validating, executionOutputs: [attempt1Ref] };
    await expect(validateFrontendBackendCandidate(stalePointer, deps())).rejects.toBeInstanceOf(
      CandidateValidationNamespaceMismatch,
    );
  });
});

describe('pinned means pinned: businessProfile and sitePlan, not the handler’s own inputs', () => {
  it('validates against the exact pinned profile and plan versions, even after newer accepted versions exist', async () => {
    const projectId = 'proj_validate_pinned_inputs';
    const jobId = 'job_validate_pinned_inputs';
    const { job } = await stageValidatingJob(projectId, jobId, { contents: 'x' });

    const profileRefV1 = job.spec.inputs[FRONTEND_BACKEND_INPUT.businessProfile]!;
    const planRefV1 = job.spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan]!;
    expect(profileRefV1.version).toBe(1);
    expect(planRefV1.version).toBe(1);

    // Newer, accepted versions of the same two artifact names, created after
    // this job reached validating — the same "a later version must not
    // change what gets validated" property already pinned for the candidate
    // itself, but for the pinned inputs the deterministic gates are run
    // against.
    const v1Profile = await registry.resolve<{ businessName: string }>(projectId, profileRefV1);
    const v2ProfileRef = await registry.put(projectId, profileRefV1.name, { ...v1Profile, businessName: 'V2 IMPOSTER — must never be seen' });
    await registry.accept(projectId, v2ProfileRef);
    const v2PlanRef = await registry.put(projectId, planRefV1.name, onePagePlan('v2-imposter-plan'));
    await registry.accept(projectId, v2PlanRef);

    await validateFrontendBackendCandidate(job, deps());

    expect(gateContextsSeen).toHaveLength(1);
    const seen = gateContextsSeen[0]!;
    expect((seen.profile as { businessName: string }).businessName).toBe(INTAKE.businessName);
    expect((seen.plan as SitePlan).valueProposition).toBe(`v-${jobId}`);
  });
});

describe('legacy and malformed jobs fail closed', () => {
  it('a job missing a pinned input (legacy or tampered) fails closed before resolving the candidate', async () => {
    const projectId = 'proj_validate_missing_input';
    const { job } = await stageValidatingJob(projectId, 'job_validate_missing_input');
    const tampered = { ...job, spec: { ...job.spec, inputs: { [FRONTEND_BACKEND_INPUT.businessProfile]: job.spec.inputs[FRONTEND_BACKEND_INPUT.businessProfile]! } } };

    await expect(validateFrontendBackendCandidate(tampered, deps())).rejects.toBeInstanceOf(CandidateValidationInputInvalid);
    expect(compileSeen).toEqual([]);
  });

  it('a candidate that resolves fine but has the wrong payload shape fails closed before writing anything', async () => {
    const projectId = 'proj_validate_malformed';
    const jobId = 'job_validate_malformed';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan(jobId));
    await engine.enqueue({ spec: jobSpec(projectId, jobId, profileRef, planRef), origin: { kind: 'plan' } });
    const claimed = await engine.claim('validate-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });

    const malformedRef = await registry.put(
      projectId,
      frontendBackendCandidateName(jobId, claimed!.attempt),
      { notAGeneratedFileList: true },
    );
    const validating = await engine.submitForValidation(jobId, 'validate-fixture-worker', claimed!.attempt, { outputs: [malformedRef] });

    await expect(validateFrontendBackendCandidate(validating, deps())).rejects.toBeInstanceOf(CandidateValidationShapeInvalid);
    expect(compileSeen).toEqual([]);
    expect(await tempRootIsEmpty()).toBe(true);
  });
});

describe('the canonical project workspace is never touched', () => {
  it('a passing validation leaves the canonical workspace exactly as empty as it started', async () => {
    const projectId = 'proj_validate_canonical_pass';
    const { job } = await stageValidatingJob(projectId, 'job_validate_canonical_pass');

    const before = await ProjectWorkspace.open(projectId, workspacesRoot);
    const commitBefore = await before.currentCommit();

    const result = await validateFrontendBackendCandidate(job, deps());
    expect(result.ok).toBe(true);

    const after = await ProjectWorkspace.open(projectId, workspacesRoot);
    expect(await after.currentCommit()).toBe(commitBefore);
    expect(commitBefore).toBeNull();
    await expect(after.readSiteFile('app/page.tsx')).rejects.toThrow();
  });

  it('a failing validation leaves the canonical workspace exactly as empty as it started', async () => {
    buildOk = false;
    const projectId = 'proj_validate_canonical_fail';
    const { job } = await stageValidatingJob(projectId, 'job_validate_canonical_fail');

    const result = await validateFrontendBackendCandidate(job, deps());
    expect(result.ok).toBe(false);

    const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
    expect(await ws.currentCommit()).toBeNull();
    await expect(ws.readSiteFile('app/page.tsx')).rejects.toThrow();
  });
});

describe('the job and the staged candidate are left exactly as they were', () => {
  it('the job document is untouched: still validating, same attempt, same executionOutputs, no lease', async () => {
    const projectId = 'proj_validate_job_untouched';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_validate_job_untouched');
    const jobSnapshotBefore = JSON.parse(JSON.stringify(job));

    await validateFrontendBackendCandidate(job, deps());

    // The database record, not merely the in-memory object handed in.
    const after = await store.jobs.findOne({ _id: job._id });
    expect(after?.state).toBe('validating');
    expect(after?.attempt).toBe(job.attempt);
    expect(after?.executionOutputs).toEqual([candidateRef]);
    expect(after?.lease).toBeNull();

    // The exact same object reference passed in, too — this module must not
    // mutate its own input parameter in place, even without ever reaching
    // the store.
    expect(JSON.parse(JSON.stringify(job))).toEqual(jobSnapshotBefore);
  });

  it('the staged candidate artifact is never accepted, on pass or on fail', async () => {
    const projectId = 'proj_validate_candidate_unaccepted';

    const pass = await stageValidatingJob(projectId, 'job_validate_unaccepted_pass');
    await validateFrontendBackendCandidate(pass.job, deps());
    const passDoc = await store.artifacts.findOne({ projectId, name: pass.candidateRef.name });
    expect(passDoc?.acceptedAt).toBeNull();

    buildOk = false;
    const fail = await stageValidatingJob(projectId, 'job_validate_unaccepted_fail');
    await validateFrontendBackendCandidate(fail.job, deps());
    const failDoc = await store.artifacts.findOne({ projectId, name: fail.candidateRef.name });
    expect(failDoc?.acceptedAt).toBeNull();
  });

  it('no repair is requested on a deterministic failure — the job stays validating, no repair_requested transition occurs', async () => {
    buildOk = false;
    const projectId = 'proj_validate_no_repair';
    const { job } = await stageValidatingJob(projectId, 'job_validate_no_repair');

    await validateFrontendBackendCandidate(job, deps());

    const after = await store.jobs.findOne({ _id: job._id });
    expect(after?.state).toBe('validating');
    const events = await store.auditLog.find({ jobId: job._id }).sort({ at: 1 }).toArray();
    expect(events.map((e) => e.detail['to'])).not.toContain('repair_requested');
  });
});

describe('isolation cleanup, on every outcome', () => {
  it('cleans up on a passing run', async () => {
    const projectId = 'proj_validate_cleanup_pass';
    const { job } = await stageValidatingJob(projectId, 'job_validate_cleanup_pass');
    await validateFrontendBackendCandidate(job, deps());
    expect(await tempRootIsEmpty()).toBe(true);
  });

  it('cleans up on a deterministic failure', async () => {
    buildOk = false;
    const projectId = 'proj_validate_cleanup_fail';
    const { job } = await stageValidatingJob(projectId, 'job_validate_cleanup_fail');
    await validateFrontendBackendCandidate(job, deps());
    expect(await tempRootIsEmpty()).toBe(true);
  });

  it('cleans up even when the build step itself throws a platform error', async () => {
    buildThrows = new Error('pnpm install: ENOSPC no space left on device');
    const projectId = 'proj_validate_cleanup_throw';
    const { job } = await stageValidatingJob(projectId, 'job_validate_cleanup_throw');

    await expect(validateFrontendBackendCandidate(job, deps())).rejects.toThrow('ENOSPC');
    expect(await tempRootIsEmpty()).toBe(true);
  });
});

describe('platform failure propagates unconverted, and never becomes ok:false', () => {
  it('a build-step throw is not swallowed into a result, and leaves the job validating', async () => {
    buildThrows = new Error('pnpm install: ENOSPC no space left on device');
    const projectId = 'proj_validate_platform_fail';
    const { job } = await stageValidatingJob(projectId, 'job_validate_platform_fail');

    await expect(validateFrontendBackendCandidate(job, deps())).rejects.toThrow(/ENOSPC/);

    const after = await store.jobs.findOne({ _id: job._id });
    expect(after?.state).toBe('validating');
  });

  it('an artifact the registry cannot resolve throws ArtifactNotFound, not ok:false', async () => {
    const projectId = 'proj_validate_resolve_fail';
    const { job } = await stageValidatingJob(projectId, 'job_validate_resolve_fail');
    // Correctly namespaced, but never actually written at this version.
    const missingRef = { name: `${jobOutputNamespace(job._id, job.attempt)}build-candidate`, version: 99 };
    const withMissingRef = { ...job, executionOutputs: [missingRef] };

    await expect(validateFrontendBackendCandidate(withMissingRef, deps())).rejects.toThrow();
    expect(compileSeen).toEqual([]);
  });
});

describe('validation is repeatable', () => {
  it('running the same unchanged validating job twice tests the same candidate and yields equivalent results', async () => {
    const projectId = 'proj_validate_repeatable';
    const { job } = await stageValidatingJob(projectId, 'job_validate_repeatable', { contents: 'repeatable content' });

    const first = await validateFrontendBackendCandidate(job, deps());
    const second = await validateFrontendBackendCandidate(job, deps());

    // Equivalent in everything but `compiled.outDir`, which names this
    // call's own disposable workspace and is expected to differ — the
    // workspace itself is torn down after each call, not reused.
    expect({ ...first, compiled: { ...first.compiled, outDir: undefined } }).toEqual({
      ...second,
      compiled: { ...second.compiled, outDir: undefined },
    });
    expect(compileSeen).toEqual(['repeatable content', 'repeatable content']);

    // No new artifact version was created by validating twice.
    const versions = await store.artifacts.find({ projectId, name: first.binding.candidate.name }).toArray();
    expect(versions).toHaveLength(1);
  });
});

describe('file-path safety is reused, not reimplemented', () => {
  it('a candidate file path that attempts to escape the isolated site root is refused', async () => {
    const projectId = 'proj_validate_path_escape';
    const jobId = 'job_validate_path_escape';
    const profileRef = await setupProject(projectId);
    const planRef = await putPlan(projectId, onePagePlan(jobId));
    await engine.enqueue({ spec: jobSpec(projectId, jobId, profileRef, planRef), origin: { kind: 'plan' } });
    const claimed = await engine.claim('validate-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });

    const escapee: BuildCandidate = {
      routeDecisions: [],
      files: [{ path: '../../etc/passwd', contents: 'x' }],
    };
    const ref = await registry.put(projectId, frontendBackendCandidateName(jobId, claimed!.attempt), escapee);
    const validating = await engine.submitForValidation(jobId, 'validate-fixture-worker', claimed!.attempt, { outputs: [ref] });

    await expect(validateFrontendBackendCandidate(validating, deps())).rejects.toThrow(/workspace/i);
    expect(compileSeen).toEqual([]);
    expect(await tempRootIsEmpty()).toBe(true);
  });
});
