/**
 * Atomic acceptance of one fenced `frontend_backend` candidate (Phase 5g-2)
 * — end to end, against a real Mongo replica set, consuming real Phase 5g-1
 * validation evidence.
 *
 * Only the build pipeline is faked, exactly as in
 * `frontend-backend-job-validation.integration.test.ts`, so `validate()`
 * below produces genuine `FrontendBackendCandidateValidation` evidence
 * without paying for a real `pnpm build`. Everything downstream of that —
 * the job engine, the artifact registry, the one shared Mongo transaction —
 * is real.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
  validateFrontendBackendCandidate,
  type FrontendBackendCandidateValidation,
  type FrontendBackendValidationBinding,
} from '../src/job-validation/frontend-backend.js';
import {
  ACCEPTANCE_ACTOR,
  AcceptanceBindingStale,
  AcceptanceCandidateMissing,
  AcceptanceEvidenceNotAuthentic,
  AcceptanceInconsistentState,
  acceptValidatedFrontendBackendCandidate,
} from '../src/job-acceptance/frontend-backend.js';

/**
 * Mutates `validation.binding` in place rather than spreading a new
 * top-level object — preserving the exact object identity the in-process
 * authenticity check (§ "evidence must be authentic" below) keys on, so
 * these tests isolate "binding no longer matches the current job" from
 * "not the real validator's own object," which a spread-constructed
 * tampered validation would otherwise conflate.
 */
function tamperBinding(
  validation: FrontendBackendCandidateValidation,
  patch: Partial<FrontendBackendValidationBinding>,
): FrontendBackendCandidateValidation {
  (validation as { binding: FrontendBackendValidationBinding }).binding = { ...validation.binding, ...patch };
  return validation;
}

let buildOk = true;

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async (siteRoot: string): Promise<BuildResult> => ({
      ok: buildOk,
      durationMs: 5,
      output: buildOk ? '' : 'compile error: x',
      outDir: join(siteRoot, 'out'),
    })),
    readBuiltFiles: vi.fn(async () => [{ path: 'index.html', contents: '<html></html>' }]),
    readExportFiles: vi.fn(async () => []),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return {
    ...actual,
    runGates: vi.fn(() => ({ passed: true, findings: [], gatesRun: ['claims'] })),
  };
});

const LEASE_MS = 60_000;

let store: StateStore;
let registry: ArtifactRegistry;
let engine: JobEngine;
let workspacesRoot: string;
let validationWorkspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  engine = new JobEngine(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-accept-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-accept-validate-'));
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
  buildOk = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures — the same shape frontend-backend-job-validation.integration.test.ts uses
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

/** Stands up a real project, a real validating job, and returns it. */
async function stageValidatingJob(projectId: string, jobId: string, contents = 'fixture content', maxAttempts = 3) {
  const profileRef = await setupProject(projectId);
  const planRef = await putPlan(projectId, onePagePlan(jobId));
  await engine.enqueue({ spec: jobSpec(projectId, jobId, profileRef, planRef), origin: { kind: 'plan' }, maxAttempts });
  const claimed = await engine.claim('accept-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
  if (!claimed || claimed._id !== jobId) throw new Error('fixture setup: could not claim the fixture job');

  const candidateRef = await registry.put(projectId, frontendBackendCandidateName(jobId, claimed.attempt), candidate(contents));
  const job = await engine.submitForValidation(jobId, 'accept-fixture-worker', claimed.attempt, { outputs: [candidateRef] });
  return { job, profileRef, planRef, candidateRef };
}

const validationDeps = () => ({ registry, validationWorkspacesRoot });
const acceptanceDeps = () => ({ store, registry, engine });

/** Runs the real 5g-1 validator (faked build pipeline) to produce genuine evidence. */
async function validate(job: Parameters<typeof validateFrontendBackendCandidate>[0]): Promise<FrontendBackendCandidateValidation> {
  return validateFrontendBackendCandidate(job, validationDeps());
}

async function auditEvents(jobId: string) {
  return store.auditLog.find({ jobId }).sort({ at: 1 }).toArray();
}

// ---------------------------------------------------------------------------

describe('the happy path', () => {
  it('accepts the exact candidate and the job atomically, audited as harness:validator, canonical workspace untouched', async () => {
    const projectId = 'proj_accept_happy';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_happy', 'happy content');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const canonical = await ProjectWorkspace.open(projectId, workspacesRoot);
    const commitBefore = await canonical.currentCommit();

    const result = await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());

    expect(result).toEqual({ jobId: job._id, attempt: job.attempt, candidate: candidateRef, state: 'accepted' });

    const acceptedJob = await store.jobs.findOne({ _id: job._id });
    expect(acceptedJob?.state).toBe('accepted');
    expect(acceptedJob?.attempt).toBe(job.attempt);
    expect(acceptedJob?.executionOutputs).toEqual([candidateRef]);

    const candidateDoc = await store.artifacts.findOne({ projectId, name: candidateRef.name, version: candidateRef.version });
    expect(candidateDoc?.acceptedAt).toBeInstanceOf(Date);

    const events = await auditEvents(job._id);
    const acceptedEvents = events.filter((e) => e.detail['to'] === 'accepted');
    expect(acceptedEvents).toHaveLength(1);
    expect(acceptedEvents[0]!.actor).toBe(ACCEPTANCE_ACTOR);
    expect(ACCEPTANCE_ACTOR).toBe('harness:validator');

    const after = await ProjectWorkspace.open(projectId, workspacesRoot);
    expect(await after.currentCommit()).toBe(commitBefore);
    expect(commitBefore).toBeNull();
    await expect(after.readSiteFile('app/page.tsx')).rejects.toThrow();
  });
});

describe('failed validation cannot accept', () => {
  it('a real ok:false validation refuses acceptance and leaves everything untouched', async () => {
    // Real evidence — genuinely produced by the validator, genuinely a
    // fail. Never registered as acceptance-capable in the first place, so
    // it is rejected the same way forged evidence is: no evidence of this
    // shape is capable of acceptance, however current its binding is.
    buildOk = false;
    const projectId = 'proj_accept_failed_validation';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_failed_validation');
    const validation = await validate(job);
    expect(validation.ok).toBe(false);

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceEvidenceNotAuthentic,
    );

    const stillValidating = await store.jobs.findOne({ _id: job._id });
    expect(stillValidating?.state).toBe('validating');
    const candidateDoc = await store.artifacts.findOne({ projectId, name: candidateRef.name });
    expect(candidateDoc?.acceptedAt).toBeNull();
    expect((await auditEvents(job._id)).some((e) => e.detail['to'] === 'accepted')).toBe(false);
  });
});

describe('evidence must be authentic — the exact object the real validator produced', () => {
  it('a hand-constructed object with a correct, currently-matching binding and ok:true is still rejected — the "forged pass"', async () => {
    // Every field is what a genuine pass for this exact job would say —
    // nothing here is stale, mismatched, or malformed. The only thing wrong
    // with it is that it never came from `validateFrontendBackendCandidate`
    // at all. If this were accepted, the authenticity check would be doing
    // nothing; this is the test the "remove the authenticity check" mutation
    // must fail.
    const projectId = 'proj_accept_forged_pass';
    const { job, candidateRef, profileRef, planRef } = await stageValidatingJob(projectId, 'job_accept_forged_pass');

    const forged: FrontendBackendCandidateValidation = {
      binding: {
        projectId,
        jobId: job._id,
        attempt: job.attempt,
        candidate: candidateRef,
        businessProfile: profileRef,
        sitePlan: planRef,
      },
      ok: true,
      compiled: { ok: true, durationMs: 1, output: '', outDir: '/forged' },
      gateRun: { passed: true, findings: [], gatesRun: ['claims'] },
    };

    await expect(acceptValidatedFrontendBackendCandidate(forged, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceEvidenceNotAuthentic,
    );

    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await auditEvents(job._id)).some((e) => e.detail['to'] === 'accepted')).toBe(false);
  });

  it('a serialized-and-parsed clone of a genuine pass is not authoritative, even though its content is byte-identical', async () => {
    // The sharpest form of "forged": not hand-typed at all, but a faithful
    // reconstruction of real evidence — `JSON.parse(JSON.stringify(...))`
    // produces a new object graph this module never saw, which is exactly
    // what the authenticity check exists to catch when a mutation removes
    // it: real-looking content sourced from outside this process boundary.
    const projectId = 'proj_accept_cloned_evidence';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_cloned_evidence');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const cloned = JSON.parse(JSON.stringify(validation)) as FrontendBackendCandidateValidation;
    expect(cloned).toEqual(validation);

    await expect(acceptValidatedFrontendBackendCandidate(cloned, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceEvidenceNotAuthentic,
    );

    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await auditEvents(job._id)).some((e) => e.detail['to'] === 'accepted')).toBe(false);

    // The genuine original, meanwhile, still works — proving the rejection
    // above was about the clone specifically, not some other regression.
    const result = await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());
    expect(result.state).toBe('accepted');
  });

  it('a real FAIL result cannot be turned into acceptable evidence by mutating its own ok field, even if the runtime permits it', async () => {
    // The exact gap this test exists to close: `readonly` is a compile-time
    // fiction, so the first version of the authenticity check — one WeakSet
    // registering every real result, pass or fail alike — would have let a
    // failed result mutated from `ok: false` to `ok: true` straight through,
    // since it was still the exact object the validator returned. A failed
    // result is now never a member of the acceptance-capable set at all, so
    // this must still be rejected regardless of what `ok` says by the time
    // this test reads it back.
    buildOk = false;
    const projectId = 'proj_accept_mutated_fail';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_mutated_fail');
    const validation = await validate(job);
    expect(validation.ok).toBe(false);

    try {
      (validation as { ok: boolean }).ok = true;
    } catch {
      // Some future version of this module may freeze its results, in
      // which case the mutation itself throwing is an equally valid form
      // of the same protection — either way, the assertions below must
      // still hold.
    }

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceEvidenceNotAuthentic,
    );

    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await auditEvents(job._id)).some((e) => e.detail['to'] === 'accepted')).toBe(false);
  });

  it('mutating the public binding to agree with a legitimately-advanced job does not launder a candidate that was never validated', async () => {
    // The provenance attack this module exists to close. Candidate A passes
    // 5g-1, and its authentic result R is issued. The job then legitimately
    // moves on — attempt 1 fails for real, is reclaimed, and attempt 2
    // stages and submits an entirely different candidate B — so the job's
    // *current* state (attempt 2, executionOutputs = [B]) is exactly what a
    // real retry produces, not a fabrication. R's *public* `.binding` is
    // then mutated in place to describe that same attempt/candidate B —
    // making the public field agree with the live job perfectly. If
    // acceptance read `validation.binding` for its authority decisions, this
    // would pass every check and accept B — a candidate 5g-1 never actually
    // ran deterministic validation against. It must not: the private,
    // authenticated snapshot behind R still says attempt 1 / candidate A,
    // and that is what acceptance must check the live job against instead.
    const projectId = 'proj_accept_provenance_attack';
    const jobId = 'job_accept_provenance_attack';
    const { job: attempt1Job, candidateRef: refA } = await stageValidatingJob(projectId, jobId, 'candidate A');
    const validationA = await validate(attempt1Job);
    expect(validationA.ok).toBe(true);

    await engine.fail(jobId, 'forced failure to advance the attempt', 'accept-fixture-worker', attempt1Job.attempt);
    const claim2 = await engine.claim('accept-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    expect(claim2?.attempt).toBe(2);
    const refB = await registry.put(projectId, frontendBackendCandidateName(jobId, 2), candidate('candidate B'));
    const jobAtB = await engine.submitForValidation(jobId, 'accept-fixture-worker', 2, { outputs: [refB] });
    expect(jobAtB.state).toBe('validating');
    expect(jobAtB.attempt).toBe(2);

    // Public field now agrees with the live job exactly — attempt, project,
    // job id already matched; only the candidate needed to change.
    tamperBinding(validationA, { attempt: 2, candidate: refB });

    const error = await acceptValidatedFrontendBackendCandidate(validationA, acceptanceDeps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcceptanceBindingStale);

    expect((await store.jobs.findOne({ _id: jobId }))?.state).toBe('validating');
    expect((await store.jobs.findOne({ _id: jobId }))?.attempt).toBe(2);
    expect((await store.artifacts.findOne({ projectId, name: refA.name }))?.acceptedAt).toBeNull();
    expect((await store.artifacts.findOne({ projectId, name: refB.name }))?.acceptedAt).toBeNull();
    expect((await auditEvents(jobId)).some((e) => e.detail['to'] === 'accepted')).toBe(false);
  });
});

describe('stale attempt', () => {
  it('evidence for attempt 1 cannot accept once the job has moved on to attempt 2', async () => {
    const projectId = 'proj_accept_stale_attempt';
    const jobId = 'job_accept_stale_attempt';
    const { job: attempt1Job, candidateRef: attempt1Ref } = await stageValidatingJob(projectId, jobId, 'attempt 1');
    const staleValidation = await validate(attempt1Job);
    expect(staleValidation.ok).toBe(true);

    // The job moves on for real: validation fails, retries, and a second
    // attempt reaches validating with its own candidate.
    await engine.fail(jobId, 'forced failure to advance the attempt', 'accept-fixture-worker', attempt1Job.attempt);
    const claim2 = await engine.claim('accept-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    expect(claim2?.attempt).toBe(2);
    const attempt2Ref = await registry.put(projectId, frontendBackendCandidateName(jobId, 2), candidate('attempt 2'));
    await engine.submitForValidation(jobId, 'accept-fixture-worker', 2, { outputs: [attempt2Ref] });

    await expect(acceptValidatedFrontendBackendCandidate(staleValidation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceBindingStale,
    );

    const current = await store.jobs.findOne({ _id: jobId });
    expect(current?.state).toBe('validating');
    expect(current?.attempt).toBe(2);
    expect((await store.artifacts.findOne({ projectId, name: attempt1Ref.name }))?.acceptedAt).toBeNull();
    expect((await store.artifacts.findOne({ projectId, name: attempt2Ref.name }))?.acceptedAt).toBeNull();
  });

  it('rejects on attempt alone when the current job’s attempt has moved on, checked before namespace', async () => {
    // The private snapshot cannot be tampered from outside this module —
    // that is the whole point of the fix above — so isolating the attempt
    // check now means moving the *real* job's attempt instead, via a raw
    // update no legitimate engine call would ever produce in isolation
    // (attempt only ever advances together with a fresh claim, which would
    // also change executionOutputs — this leaves that untouched, so the
    // namespace check would fire too if the attempt check did not fire
    // first).
    const projectId = 'proj_accept_attempt_only_mismatch';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_attempt_only_mismatch');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    await store.jobs.updateOne({ _id: job._id }, { $set: { attempt: job.attempt + 1 } });

    const error = await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcceptanceBindingStale);
    expect((error as AcceptanceBindingStale).reason).toBe('attempt');
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
  });
});

describe('executionOutputs changed after validation', () => {
  it('the job pointing at a different candidate than the one validated refuses acceptance; neither candidate is accepted', async () => {
    const projectId = 'proj_accept_outputs_changed';
    const { job, candidateRef: refA } = await stageValidatingJob(projectId, 'job_accept_outputs_changed', 'candidate A');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    // Not reachable through any real engine call while state stays
    // validating and attempt stays the same (Phase 5f's own guarantee) —
    // simulated directly to prove acceptance fails closed even against an
    // out-of-band anomaly, not merely a scenario the engine would produce.
    const refB = await registry.put(projectId, frontendBackendCandidateName(job._id, job.attempt), candidate('candidate B'));
    await store.jobs.updateOne({ _id: job._id }, { $set: { executionOutputs: [refB] } });

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceBindingStale,
    );

    expect((await store.artifacts.findOne({ projectId, name: refA.name, version: refA.version }))?.acceptedAt).toBeNull();
    expect((await store.artifacts.findOne({ projectId, name: refB.name, version: refB.version }))?.acceptedAt).toBeNull();
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
  });
});

describe('pinned input changed after validation', () => {
  it('a job whose recorded businessProfile input no longer matches what was validated refuses acceptance', async () => {
    const projectId = 'proj_accept_input_changed';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_input_changed');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    // job.spec is never mutated by any real engine call — simulated
    // directly, the same way as the executionOutputs anomaly above, to
    // prove the pinned-input check is real and not merely inferred from the
    // output ref being unchanged.
    const otherProfileRef = { name: 'business-profile', version: 999 };
    await store.jobs.updateOne(
      { _id: job._id },
      { $set: { [`spec.inputs.${FRONTEND_BACKEND_INPUT.businessProfile}`]: otherProfileRef } },
    );

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceBindingStale,
    );
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
  });

  it('a job whose recorded sitePlan input no longer matches what was validated refuses acceptance', async () => {
    const projectId = 'proj_accept_siteplan_changed';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_siteplan_changed');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const otherPlanRef = { name: 'site-plan', version: 999 };
    await store.jobs.updateOne(
      { _id: job._id },
      { $set: { [`spec.inputs.${FRONTEND_BACKEND_INPUT.sitePlan}`]: otherPlanRef } },
    );

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceBindingStale,
    );
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
  });
});

describe('exact version, not latest', () => {
  it('accepts only the exact validated candidate version, even after a newer version of the same name exists', async () => {
    const projectId = 'proj_accept_exact_version';
    const { job, candidateRef: v1 } = await stageValidatingJob(projectId, 'job_accept_exact_version', 'v1 content');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);
    expect(v1.version).toBe(1);

    const v2 = await registry.put(projectId, v1.name, candidate('v2 content, created after validating'));

    const result = await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());
    expect(result.candidate).toEqual(v1);

    expect((await store.artifacts.findOne({ projectId, name: v1.name, version: 1 }))?.acceptedAt).toBeInstanceOf(Date);
    expect((await store.artifacts.findOne({ projectId, name: v2.name, version: 2 }))?.acceptedAt).toBeNull();
  });
});

describe('another job’s candidate cannot be substituted', () => {
  it('mutating the public binding to name another job does not redirect acceptance — it still resolves and accepts only the original job', async () => {
    // The old technique here — tamper `validation.binding` in place, then
    // expect rejection — no longer proves anything against the fixed
    // module: the public field it mutated is not what acceptance reads any
    // more. The sharper, and now correct, property to prove is that the
    // mutation has *no effect at all* — acceptance is anchored to the
    // private snapshot's own `jobId`, so it still resolves and accepts job
    // A's own real candidate, and job B — an entirely separate, independently
    // validating job — is left completely untouched throughout.
    const projectId = 'proj_accept_cross_job';
    const { job: jobA, candidateRef: refA } = await stageValidatingJob(projectId, 'job_accept_cross_a', 'A content');
    const { job: jobB, candidateRef: refB } = await stageValidatingJob(projectId, 'job_accept_cross_b', 'B content');
    const validationA = await validate(jobA);
    expect(validationA.ok).toBe(true);

    tamperBinding(validationA, { jobId: jobB._id, projectId: jobB.projectId, candidate: refB });

    const result = await acceptValidatedFrontendBackendCandidate(validationA, acceptanceDeps());
    expect(result).toEqual({ jobId: jobA._id, attempt: jobA.attempt, candidate: refA, state: 'accepted' });

    expect((await store.jobs.findOne({ _id: jobA._id }))?.state).toBe('accepted');
    expect((await store.jobs.findOne({ _id: jobB._id }))?.state).toBe('validating');
    expect((await store.artifacts.findOne({ projectId, name: refA.name }))?.acceptedAt).toBeInstanceOf(Date);
    expect((await store.artifacts.findOne({ projectId, name: refB.name }))?.acceptedAt).toBeNull();
  });
});

describe('another project', () => {
  it('mutating the public binding to name a job in another project does not redirect acceptance', async () => {
    const { job: jobX, candidateRef: refX } = await stageValidatingJob('proj_accept_x', 'job_accept_cross_project_x', 'X content');
    const { job: jobY } = await stageValidatingJob('proj_accept_y', 'job_accept_cross_project_y', 'Y content');
    const validationX = await validate(jobX);
    expect(validationX.ok).toBe(true);

    tamperBinding(validationX, { jobId: jobY._id, projectId: jobY.projectId });

    const result = await acceptValidatedFrontendBackendCandidate(validationX, acceptanceDeps());
    expect(result).toEqual({ jobId: jobX._id, attempt: jobX.attempt, candidate: refX, state: 'accepted' });

    expect((await store.jobs.findOne({ _id: jobY._id }))?.state).toBe('validating');
    expect((await store.artifacts.findOne({ projectId: 'proj_accept_x', name: refX.name }))?.acceptedAt).toBeInstanceOf(Date);
  });

  it('rejects when the current job’s projectId no longer matches what was validated, isolated from every other check', async () => {
    // A job's `projectId` is fixed at `enqueue` and never legitimately
    // changes — this is not reachable through any real engine call, and
    // (now that the private snapshot cannot be tampered from outside this
    // module) not reachable by tampering the evidence either. Simulated
    // directly on the job itself, the same way other otherwise-unreachable
    // anomalies are elsewhere in this suite, to prove the check itself.
    const projectId = 'proj_accept_projectid_only_mismatch';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_projectid_only_mismatch');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    await store.jobs.updateOne({ _id: job._id }, { $set: { projectId: 'proj_accept_does_not_exist' } });

    const error = await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcceptanceBindingStale);
    expect((error as AcceptanceBindingStale).reason).toBe('projectId');
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
  });
});

describe('job no longer validating', () => {
  it('rejects acceptance once the job has moved to "repair_requested"', async () => {
    const projectId = 'proj_accept_no_longer_repair_requested';
    const { job } = await stageValidatingJob(projectId, 'job_accept_repair_requested');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    await engine.requestRepair(job._id, 'harness:test');
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('repair_requested');

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceBindingStale,
    );
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('repair_requested');
  });

  it('rejects acceptance once the job has moved to "failed"', async () => {
    // `blocked` is not reachable from `validating` in one step (the legal
    // transitions out of it are exactly `accepted | failed |
    // repair_requested`), so `failed` is used here instead. `maxAttempts: 1`
    // keeps `fail` from immediately advancing it back to `ready` — this
    // test wants it to land, and stay, on `failed` itself.
    const projectId = 'proj_accept_no_longer_failed';
    const { job } = await stageValidatingJob(projectId, 'job_accept_failed', 'fixture content', 1);
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    await engine.fail(job._id, 'forced failure for this test', 'harness:test', job.attempt);
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('failed');

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceBindingStale,
    );
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('failed');
  });

  it('rejects acceptance once the job is already accepted through an inconsistent path (not a matching replay)', async () => {
    const projectId = 'proj_accept_already_accepted_inconsistent';
    const { job } = await stageValidatingJob(projectId, 'job_accept_inconsistent');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    // Accepted state-only, bypassing this module entirely — the exact
    // candidate this validation describes is never accepted as part of it.
    await engine.accept(job._id, 'someone-else');

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceInconsistentState,
    );
  });

  it('an exact replay of an already-successful acceptance is a safe no-op, not a second transition', async () => {
    const projectId = 'proj_accept_replay';
    const { job } = await stageValidatingJob(projectId, 'job_accept_replay');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const first = await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());
    const second = await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());
    expect(second).toEqual(first);

    const acceptedEvents = (await auditEvents(job._id)).filter((e) => e.detail['to'] === 'accepted');
    expect(acceptedEvents).toHaveLength(1);
  });
});

describe('candidate missing', () => {
  it('surfaces an error and leaves the job validating when the registry reports no artifact matched the exact identity', async () => {
    // A candidate genuinely missing at acceptance time despite genuine
    // validation evidence is not reachable through the private snapshot any
    // more: the snapshot can only ever name an artifact `validateFrontendBackendCandidate`
    // itself already resolved successfully, and artifacts in this repo are
    // immutable and never deleted, so a real snapshot's candidate cannot
    // later stop existing. This exercises the exact code path — `registry.accept`
    // reporting no match — directly, the same platform/data-integrity fault
    // this error exists for, without fabricating a data shape genuine
    // evidence could never actually have.
    const projectId = 'proj_accept_candidate_missing';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_candidate_missing');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const registrySpy = vi.spyOn(registry, 'accept').mockResolvedValueOnce(false);

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceCandidateMissing,
    );
    registrySpy.mockRestore();

    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await auditEvents(job._id)).some((e) => e.detail['to'] === 'accepted')).toBe(false);
  });
});

describe('transaction rollback', () => {
  it('job acceptance failing rolls back the artifact acceptance that already happened in the same transaction', async () => {
    const projectId = 'proj_accept_rollback_job';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_rollback_job');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const spy = vi.spyOn(engine, 'accept').mockImplementationOnce(async () => {
      throw new Error('forced job-acceptance failure, after the real artifact accept already ran');
    });

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toThrow(
      'forced job-acceptance failure',
    );
    spy.mockRestore();

    // The registry.accept call really did run, inside the transaction,
    // before the forced failure — this proves Mongo actually rolled it back
    // rather than there being nothing to roll back in the first place.
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
    expect((await auditEvents(job._id)).some((e) => e.detail['to'] === 'accepted')).toBe(false);
  });

  it('artifact acceptance failing leaves the job validating, with no accepted transition ever attempted', async () => {
    const projectId = 'proj_accept_rollback_artifact';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_rollback_artifact');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const registrySpy = vi.spyOn(registry, 'accept').mockImplementationOnce(async () => {
      throw new Error('forced artifact-acceptance failure');
    });
    const engineSpy = vi.spyOn(engine, 'accept');

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toThrow(
      'forced artifact-acceptance failure',
    );
    registrySpy.mockRestore();

    expect(engineSpy).not.toHaveBeenCalled();
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
    expect((await auditEvents(job._id)).some((e) => e.detail['to'] === 'accepted')).toBe(false);
  });

  it('a genuinely successful JobEngine.accept still rolls back if something later in the same transaction fails', async () => {
    // Distinct from the two rollback tests above, which fully replace
    // `engine.accept`/`registry.accept` with a mock that never runs the real
    // implementation. This one lets the real `engine.accept` genuinely
    // execute and commit-or-not as part of the transaction, then forces a
    // failure right after it returns — proving the job write is truly tied
    // to the same transaction, not merely called with a session object that
    // happens to go unused internally (which the "shared session" identity
    // test below cannot itself distinguish, since it only inspects what was
    // passed in, not what the callee did with it).
    const projectId = 'proj_accept_rollback_real_engine_accept';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_rollback_real_engine_accept');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const realAccept = engine.accept.bind(engine);
    const spy = vi.spyOn(engine, 'accept').mockImplementationOnce(async (...args: Parameters<typeof engine.accept>) => {
      await realAccept(...args);
      throw new Error('forced failure after the real engine.accept call actually ran');
    });

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toThrow(
      'forced failure after the real engine.accept call actually ran',
    );
    spy.mockRestore();

    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeNull();
    expect((await auditEvents(job._id)).some((e) => e.detail['to'] === 'accepted')).toBe(false);
  });
});

describe('the shared session is real, not merely assumed', () => {
  it('ArtifactRegistry.accept and JobEngine.accept are called with the exact same ClientSession', async () => {
    const projectId = 'proj_accept_shared_session';
    const { job } = await stageValidatingJob(projectId, 'job_accept_shared_session');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    const registrySpy = vi.spyOn(registry, 'accept');
    const engineSpy = vi.spyOn(engine, 'accept');

    await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());

    const registrySession = registrySpy.mock.calls[0]![2];
    const engineSession = engineSpy.mock.calls[0]![2]?.session;
    expect(registrySession).toBeDefined();
    expect(registrySession).toBe(engineSession);
  });
});

describe('canonical workspace untouched', () => {
  it('leaves the canonical workspace exactly as it was before a successful acceptance', async () => {
    const projectId = 'proj_accept_canonical_untouched';
    const { job } = await stageValidatingJob(projectId, 'job_accept_canonical_untouched');
    const validation = await validate(job);

    const before = await ProjectWorkspace.open(projectId, workspacesRoot);
    const filesBefore = await before.listSiteFiles();
    const commitBefore = await before.currentCommit();

    await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());

    const after = await ProjectWorkspace.open(projectId, workspacesRoot);
    expect(await after.listSiteFiles()).toEqual(filesBefore);
    expect(await after.currentCommit()).toBe(commitBefore);
  });
});

describe('only the exact candidate is accepted', () => {
  it('an orphaned second artifact in the same job-output namespace is never accepted', async () => {
    const projectId = 'proj_accept_only_exact';
    const { job, candidateRef } = await stageValidatingJob(projectId, 'job_accept_only_exact');
    const validation = await validate(job);

    const orphanName = `${jobOutputNamespace(job._id, job.attempt)}unrelated-artifact`;
    const orphanRef = await registry.put(projectId, orphanName, { unrelated: true });

    await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());

    expect((await store.artifacts.findOne({ projectId, name: candidateRef.name }))?.acceptedAt).toBeInstanceOf(Date);
    expect((await store.artifacts.findOne({ projectId, name: orphanRef.name }))?.acceptedAt).toBeNull();
  });
});

describe('no repair or promotion side effect', () => {
  it('a successful acceptance writes exactly one audit event and touches no repair state', async () => {
    const projectId = 'proj_accept_no_side_effects';
    const { job } = await stageValidatingJob(projectId, 'job_accept_no_side_effects');
    const validation = await validate(job);

    await acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps());

    const events = await auditEvents(job._id);
    expect(events.map((e) => e.detail['to'])).toEqual(['running', 'validating', 'accepted']);
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('accepted');
  });
});

describe('legacy job behavior', () => {
  it('a binding derived from a job with no executionOutputs is rejected as stale, not searched for a substitute', async () => {
    const projectId = 'proj_accept_legacy';
    const { job } = await stageValidatingJob(projectId, 'job_accept_legacy');
    const validation = await validate(job);
    expect(validation.ok).toBe(true);

    // Simulates a legacy job that reached validating before executionOutputs
    // existed (Phase 5f's own compatibility gap) reappearing with otherwise
    // real evidence pointed at it.
    await store.jobs.updateOne({ _id: job._id }, { $unset: { executionOutputs: '' } });

    await expect(acceptValidatedFrontendBackendCandidate(validation, acceptanceDeps())).rejects.toBeInstanceOf(
      AcceptanceBindingStale,
    );
    expect((await store.jobs.findOne({ _id: job._id }))?.state).toBe('validating');
  });
});
