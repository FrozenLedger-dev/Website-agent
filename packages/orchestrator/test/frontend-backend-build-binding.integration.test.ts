/**
 * Durable active frontend/backend build binding — restart resume (Phase 5k).
 *
 * Every scenario here calls `runProject` (or, for the lower-level Git/Mongo
 * recovery mechanics, the binding module's own functions directly) *twice*
 * against the same project, each call constructing its own fresh
 * `JobEngine`/coordinator/`ProjectWorkspace` objects exactly as two separate
 * process invocations would — nothing here shares in-memory state between
 * "invocation 1" and "invocation 2" beyond what is genuinely durable
 * (Mongo, Git).
 *
 * Mock setup mirrors `frontend-backend-build-boundary.integration.test.ts`
 * exactly (see that file's own doc comment) — `@statxai/agents`/
 * `@statxai/workspace`'s compiler/`@statxai/gates` are faked, everything
 * else is real: `JobEngine`, `JobRunner`, the production Terra handler,
 * Phase 5g-1, 5g-2, 5h, and `runProject` itself.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import type { SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import { spend } from '@statxai/state';
import * as jobSpecsModule from '../src/job-specs/frontend-backend.js';
import * as promotionModule from '../src/job-promotion/frontend-backend.js';
import * as runBindingModule from '../src/run-binding/frontend-backend.js';
import {
  computeRunIntentHash,
  ensureSpecificationCommitted,
  prepareFrontendBackendBuildBinding,
  FrontendBackendBuildBindingBaseConflict,
  FrontendBackendBuildBindingConflict,
} from '../src/run-binding/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';

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
let planSiteCalls = 0;
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

const planWith = (marker: string) => ({
  strategy: 'Local trade credibility',
  valueProposition: `v-${marker}`,
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: `direction-${marker}`,
    radius: 'square',
    rationale: 'Workwear palette suits the trade.',
  },
  sitemap: { pages: [page('/', 'Home')] },
  acceptanceCriteria: ['a', 'b', 'c'],
});

const PLAN = planWith('v1') as SitePlan;
const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => {
      planSiteCalls += 1;
      return { value: PLAN, model: 'gpt-5.6-sol', ...usage };
    }),
    routeBuild: vi.fn(async () => {
      return {
        value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
        model: 'gpt-5.6-sol',
        ...usage,
      };
    }),
    buildSite: vi.fn(async () => {
      terraBuildCalls += 1;
      // Content varies by call count: a second, genuinely new build
      // generation (a fresh binding after an earlier one already promoted)
      // must produce a real diff for its own promotion to commit, not the
      // exact bytes an earlier generation already committed.
      return {
        value: {
          files: [{ path: 'app/page.tsx', contents: `export default function P(){return ${terraBuildCalls}}` }],
          notes: '',
        },
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

vi.mock('../src/job-promotion/frontend-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof promotionModule>();
  return { ...actual, promoteAcceptedFrontendBackendCandidate: vi.fn(actual.promoteAcceptedFrontendBackendCandidate) };
});

vi.mock('../src/job-specs/frontend-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof jobSpecsModule>();
  return { ...actual, createFrontendBackendJobSpec: vi.fn(actual.createFrontendBackendJobSpec) };
});

vi.mock('../src/run-binding/frontend-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof runBindingModule>();
  return { ...actual, finalizeBindingPromoted: vi.fn(actual.finalizeBindingPromoted) };
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
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5k-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5k-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  gateVerdict = { passed: true, findings: [], gatesRun: ['claims'] };
  compileOk = true;
  planSiteCalls = 0;
  terraBuildCalls = 0;
  reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
  approval = { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: ['QA-004'] };
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
  await store.promotions.deleteMany({});
  await store.frontendBackendBuildBindings.deleteMany({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const runJobMode = async (projectId: string, intake: unknown = INTAKE) => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({
    projectId,
    intake,
    store,
    workspacesRoot,
    autonomyMode: 'full_autonomous',
    frontendBackendExecutionMode: 'job_lifecycle',
    validationWorkspacesRoot,
  });
};

const runLegacy = async (projectId: string) => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({
    projectId,
    intake: INTAKE,
    store,
    workspacesRoot,
    autonomyMode: 'full_autonomous',
    frontendBackendExecutionMode: 'legacy_direct',
  });
};

async function canonicalWorkspace(projectId: string): Promise<ProjectWorkspace> {
  return ProjectWorkspace.open(projectId, workspacesRoot);
}

async function activeBinding(projectId: string) {
  return store.frontendBackendBuildBindings.findOne({ projectId, status: 'prepared' });
}

// ---------------------------------------------------------------------------

describe('restart from retry_ready', () => {
  it('resumes the same job and binding without rediscovering or replanning', async () => {
    const projectId = 'proj_5k_retry_ready';

    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });

    const first = await runJobMode(projectId);
    expect(first.outcome).toBe('blocked');
    expect(first.jobLifecycleOutcome).toBe('retry_ready');

    const bindingAfterFirst = await activeBinding(projectId);
    expect(bindingAfterFirst).not.toBeNull();
    const jobAfterFirst = await store.jobs.findOne({ projectId });
    expect(jobAfterFirst?.state).toBe('ready');
    expect(jobAfterFirst?.attempt).toBe(1);

    expect(await store.artifacts.countDocuments({ projectId, name: 'business-profile' })).toBe(1);
    expect(await store.artifacts.countDocuments({ projectId, name: 'site-plan' })).toBe(1);
    expect(planSiteCalls).toBe(1);

    // Second invocation: fresh process, same intent.
    const second = await runJobMode(projectId);
    expect(second.outcome).toBe('released');

    // No rediscovery, no replanning.
    expect(await store.artifacts.countDocuments({ projectId, name: 'business-profile' })).toBe(1);
    expect(await store.artifacts.countDocuments({ projectId, name: 'site-plan' })).toBe(1);
    expect(planSiteCalls).toBe(1);

    // Exactly one binding, now promoted.
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
    const finalBinding = await store.frontendBackendBuildBindings.findOne({ projectId });
    expect(finalBinding?.status).toBe('promoted');
    expect(finalBinding?.jobId).toBe(jobAfterFirst?._id);

    // JobEngine's own counter did the incrementing — attempt 2, same job.
    const jobAfterSecond = await store.jobs.findOne({ projectId });
    expect(jobAfterSecond?._id).toBe(jobAfterFirst?._id);
    expect(jobAfterSecond?.attempt).toBe(2);
  });
});

describe('restart from validating', () => {
  it('reruns 5g-1 fresh on the new invocation without re-invoking Terra', async () => {
    const projectId = 'proj_5k_validating';
    compileOk = false;

    const first = await runJobMode(projectId);
    expect(first.outcome).toBe('blocked');
    expect(first.jobLifecycleOutcome).toBe('validation_failed');

    const jobAfterFirst = await store.jobs.findOne({ projectId });
    expect(jobAfterFirst?.state).toBe('validating');
    expect(terraBuildCalls).toBe(1);

    compileOk = true;
    const second = await runJobMode(projectId);
    expect(second.outcome).toBe('released');

    // No second Terra generation — only 5g-1's own recompile of the staged candidate.
    expect(terraBuildCalls).toBe(1);
    expect(planSiteCalls).toBe(1);

    const finalBinding = await store.frontendBackendBuildBindings.findOne({ projectId });
    expect(finalBinding?.status).toBe('promoted');
  });
});

describe('restart from accepted', () => {
  it('runs 5h alone on resume: no Terra, no re-validation, no re-acceptance', async () => {
    const projectId = 'proj_5k_accepted';

    vi.mocked(promotionModule.promoteAcceptedFrontendBackendCandidate).mockImplementationOnce(async () => {
      throw new Error('simulated promotion platform failure');
    });

    await expect(runJobMode(projectId)).rejects.toThrow('simulated promotion platform failure');

    const jobAfterFirst = await store.jobs.findOne({ projectId });
    expect(jobAfterFirst?.state).toBe('accepted');
    expect(terraBuildCalls).toBe(1);

    const bindingAfterFirst = await store.frontendBackendBuildBindings.findOne({ projectId });
    expect(bindingAfterFirst?.status).toBe('prepared');

    const second = await runJobMode(projectId);
    expect(second.outcome).toBe('released');

    expect(terraBuildCalls).toBe(1);
    expect(planSiteCalls).toBe(1);
    const jobAfterSecond = await store.jobs.findOne({ projectId });
    expect(jobAfterSecond?.attempt).toBe(1);

    const finalBinding = await store.frontendBackendBuildBindings.findOne({ projectId });
    expect(finalBinding?.status).toBe('promoted');
  });
});

describe('restart after Git promotion, before binding finalization', () => {
  it('does not duplicate the Terra build, validation, acceptance, or promotion commit; finalizes the binding on replay', async () => {
    const projectId = 'proj_5k_finalize_crash';

    vi.mocked(runBindingModule.finalizeBindingPromoted).mockImplementationOnce(async () => {
      throw new Error('simulated binding-finalization write failure');
    });

    await expect(runJobMode(projectId)).rejects.toThrow('simulated binding-finalization write failure');

    // Phase 5i/5h genuinely completed: the job is accepted, a real
    // committed promotion record exists, and a real Git commit exists —
    // none of that is undone by the finalization failure.
    const jobAfterFirst = await store.jobs.findOne({ projectId });
    expect(jobAfterFirst?.state).toBe('accepted');
    const promotionAfterFirst = await store.promotions.findOne({ projectId });
    expect(promotionAfterFirst?.status).toBe('committed');
    expect(promotionAfterFirst?.commitSha).not.toBeNull();

    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBe(promotionAfterFirst?.commitSha);

    const bindingAfterFirst = await store.frontendBackendBuildBindings.findOne({ projectId });
    expect(bindingAfterFirst?.status).toBe('prepared');

    // Resume: Phase 5i/5h replay (pure read-and-verify — no second Terra
    // attempt, validation, acceptance, or promotion commit), then the
    // binding finalization retries and succeeds.
    const second = await runJobMode(projectId);
    expect(second.outcome).toBe('released');

    expect(terraBuildCalls).toBe(1);
    const promotionAfterSecond = await store.promotions.findOne({ projectId });
    expect(promotionAfterSecond?.commitSha).toBe(promotionAfterFirst?.commitSha);
    expect(await store.promotions.countDocuments({ projectId })).toBe(1);

    const finalBinding = await store.frontendBackendBuildBindings.findOne({ projectId });
    expect(finalBinding?.status).toBe('promoted');
    expect(finalBinding?.promotionId).toBe(promotionAfterFirst?._id);
    expect(finalBinding?.promotionCommitSha).toBe(promotionAfterFirst?.commitSha);
  });
});

describe('a different intent while a binding is active', () => {
  it('conflicts before any discovery side effect; the existing binding is untouched', async () => {
    const projectId = 'proj_5k_conflict';

    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    const first = await runJobMode(projectId);
    expect(first.jobLifecycleOutcome).toBe('retry_ready');

    const projectDocBefore = await store.projects.findOne({ _id: projectId });
    const bindingBefore = await activeBinding(projectId);

    const differentIntake = { ...INTAKE, businessName: 'A Totally Different Business' };
    await expect(runJobMode(projectId, differentIntake)).rejects.toThrow(FrontendBackendBuildBindingConflict);

    // Untouched: same project document, same binding, no new profile/plan,
    // no additional model call.
    const projectDocAfter = await store.projects.findOne({ _id: projectId });
    expect(projectDocAfter?.createdAt).toEqual(projectDocBefore?.createdAt);
    const bindingAfter = await activeBinding(projectId);
    expect(bindingAfter?._id).toBe(bindingBefore?._id);
    expect(await store.artifacts.countDocuments({ projectId, name: 'business-profile' })).toBe(1);
    expect(await store.artifacts.countDocuments({ projectId, name: 'site-plan' })).toBe(1);
    expect(planSiteCalls).toBe(1);
  });
});

describe('malformed or insufficient intake still fails before resume', () => {
  it('a prepared binding does not bypass malformed-intake validation', async () => {
    const projectId = 'proj_5k_malformed_with_binding';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);
    expect(await activeBinding(projectId)).not.toBeNull();

    const result = await runJobMode(projectId, { not: 'a valid intake' });
    expect(result.outcome).toBe('intake_insufficient');
    // The existing binding is still exactly as it was.
    expect(await activeBinding(projectId)).not.toBeNull();
  });

  it('a prepared binding does not bypass the schema-valid-but-insufficient check, and produces zero new side effects', async () => {
    const projectId = 'proj_5k_thin_with_binding';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);

    const thin = { ...INTAKE, services: [], differentiators: [] };
    const result = await runJobMode(projectId, thin);
    expect(result.outcome).toBe('intake_insufficient');
    expect(await store.artifacts.countDocuments({ projectId, name: 'business-profile' })).toBe(1);
    expect(await store.artifacts.countDocuments({ projectId, name: 'site-plan' })).toBe(1);
  });
});

describe('exact bound refs on resume, not latest', () => {
  it('pins the exact businessProfile/sitePlan versions the binding was prepared against', async () => {
    const projectId = 'proj_5k_exact_refs';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);

    const binding = await activeBinding(projectId);
    expect(binding?.businessProfile.version).toBe(1);
    expect(binding?.sitePlan.version).toBe(1);

    // A newer version accepted between invocations, by something else entirely.
    const v2ProfileRef = await registry.put(projectId, 'business-profile', { ...INTAKE, businessName: 'A Different Business v2' });
    await registry.accept(projectId, v2ProfileRef);
    const v2PlanRef = await registry.put(projectId, 'site-plan', planWith('v2'));
    await registry.accept(projectId, v2PlanRef);

    const second = await runJobMode(projectId);
    expect(second.outcome).toBe('released');

    const job = await store.jobs.findOne({ projectId });
    expect(job?.spec.inputs['businessProfile']!.version).toBe(1);
    expect(job?.spec.inputs['sitePlan']!.version).toBe(1);
  });
});

describe('the stored spec is authority on resume, never the factory', () => {
  it('does not call createFrontendBackendJobSpec again on resume', async () => {
    const projectId = 'proj_5k_stored_spec';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);
    expect(vi.mocked(jobSpecsModule.createFrontendBackendJobSpec)).toHaveBeenCalledTimes(1);

    await runJobMode(projectId);
    expect(vi.mocked(jobSpecsModule.createFrontendBackendJobSpec)).toHaveBeenCalledTimes(1);
  });
});

describe('corrupt or missing durable state fails closed on resume', () => {
  it('a missing project document is not repaired by rerunning discovery', async () => {
    const projectId = 'proj_5k_missing_project';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);

    await store.projects.deleteOne({ _id: projectId });

    await expect(runJobMode(projectId)).rejects.toThrow(runBindingModule.FrontendBackendBuildBindingResumeStateMissing);
  });

  it('a missing budget document is not repaired by recreating it', async () => {
    const projectId = 'proj_5k_missing_budget';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);

    await store.budgets.deleteOne({ _id: projectId });

    await expect(runJobMode(projectId)).rejects.toThrow(runBindingModule.FrontendBackendBuildBindingResumeStateMissing);
  });

  it('a tampered jobSpecHash is never silently trusted', async () => {
    const projectId = 'proj_5k_corrupt_hash';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);

    await store.frontendBackendBuildBindings.updateOne({ projectId }, { $set: { jobSpecHash: 'tampered' } });

    await expect(runJobMode(projectId)).rejects.toThrow(runBindingModule.FrontendBackendBuildBindingCorrupt);
    // Both invocations' own Terra attempts failed (the first by the forced
    // throw, the second because corruption is caught before Phase 5i ever
    // runs) — no successful generation happened either time.
    expect(terraBuildCalls).toBe(0);
  });

  it('a missing exact bound artifact is never resolved to latest', async () => {
    const projectId = 'proj_5k_missing_artifact';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);

    await store.artifacts.deleteMany({ projectId, name: 'business-profile' });

    await expect(runJobMode(projectId)).rejects.toThrow(/not found/i);
    expect(terraBuildCalls).toBe(0);
  });
});

describe('resume preserves existing budget and project state', () => {
  it('does not reset the budget or recreate the project document', async () => {
    const projectId = 'proj_5k_preserve_state';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });
    await runJobMode(projectId);

    await spend(store, projectId, 'reviewRejections');
    const budgetBefore = await store.budgets.findOne({ _id: projectId });
    expect(budgetBefore?.used.reviewRejections).toBe(1);
    const projectBefore = await store.projects.findOne({ _id: projectId });

    await runJobMode(projectId);

    const budgetAfter = await store.budgets.findOne({ _id: projectId });
    expect(budgetAfter?.used.reviewRejections).toBe(1);
    const projectAfter = await store.projects.findOne({ _id: projectId });
    expect(projectAfter?.createdAt).toEqual(projectBefore?.createdAt);
  });
});

describe('one active binding per project; promoted history does not block the next generation', () => {
  it('a promoted binding frees the project for a genuinely new build generation', async () => {
    const projectId = 'proj_5k_next_generation';
    const first = await runJobMode(projectId);
    expect(first.outcome).toBe('released');
    const bindingA = await store.frontendBackendBuildBindings.findOne({ projectId, status: 'promoted' });
    expect(bindingA).not.toBeNull();

    const differentIntake = { ...INTAKE, businessName: 'A New Generation Business' };
    const second = await runJobMode(projectId, differentIntake);
    expect(second.outcome).toBe('released');

    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(2);
    const bindingB = await store.frontendBackendBuildBindings.findOne({ projectId, _id: { $ne: bindingA!._id } });
    expect(bindingB?.status).toBe('promoted');
    // History preserved, not overwritten.
    expect(await store.frontendBackendBuildBindings.findOne({ _id: bindingA!._id })).not.toBeNull();
  });
});

describe('concurrent binding preparation', () => {
  it('two callers deriving the same exact binding converge on one durable record', async () => {
    const projectId = 'proj_5k_concurrent_same';
    const profileRef = await registry.put(projectId, 'business-profile', INTAKE);
    await registry.accept(projectId, profileRef);
    const planRef = await registry.put(projectId, 'site-plan', PLAN);
    await registry.accept(projectId, planRef);
    const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef: profileRef, sitePlanRef: planRef });
    const runIntentHash = computeRunIntentHash({ projectId, profile: INTAKE as never });

    const input = {
      projectId,
      runIntentHash,
      businessProfileRef: profileRef,
      sitePlanRef: planRef,
      jobSpec: spec,
      specificationBaseCommit: null,
    };
    const [a, b] = await Promise.all([
      prepareFrontendBackendBuildBinding(store, input),
      prepareFrontendBackendBuildBinding(store, input),
    ]);
    expect(a._id).toBe(b._id);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
  });

  it('two callers deriving different bindings for the same project conflict; the loser never overwrites the winner', async () => {
    const projectId = 'proj_5k_concurrent_different';
    const profileRef = await registry.put(projectId, 'business-profile', INTAKE);
    await registry.accept(projectId, profileRef);
    const planRefA = await registry.put(projectId, 'site-plan', planWith('a'));
    await registry.accept(projectId, planRefA);
    const planRefB = await registry.put(projectId, 'site-plan', planWith('b'));
    await registry.accept(projectId, planRefB);

    const specA = createFrontendBackendJobSpec({ projectId, businessProfileRef: profileRef, sitePlanRef: planRefA });
    const specB = createFrontendBackendJobSpec({ projectId, businessProfileRef: profileRef, sitePlanRef: planRefB });
    const runIntentHash = computeRunIntentHash({ projectId, profile: INTAKE as never });

    const results = await Promise.allSettled([
      prepareFrontendBackendBuildBinding(store, {
        projectId,
        runIntentHash,
        businessProfileRef: profileRef,
        sitePlanRef: planRefA,
        jobSpec: specA,
        specificationBaseCommit: null,
      }),
      prepareFrontendBackendBuildBinding(store, {
        projectId,
        runIntentHash,
        businessProfileRef: profileRef,
        sitePlanRef: planRefB,
        jobSpec: specB,
        specificationBaseCommit: null,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(FrontendBackendBuildBindingConflict);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, status: 'prepared' })).toBe(1);
  });
});

describe('the specification commit recovers safely across a crash', () => {
  it('finds the existing marker instead of creating a second commit when the Mongo SHA update never happened', async () => {
    const projectId = 'proj_5k_spec_commit_recovery';
    const workspace = await ProjectWorkspace.open(projectId, workspacesRoot);
    const profileRef = await registry.put(projectId, 'business-profile', INTAKE);
    await registry.accept(projectId, profileRef);
    const planRef = await registry.put(projectId, 'site-plan', PLAN);
    await registry.accept(projectId, planRef);
    await workspace.materialiseArtifact('client/business-profile.json', INTAKE);
    await workspace.materialiseArtifact('design/brand-system.json', PLAN.brandSystem);
    await workspace.materialiseArtifact('specs/sitemap.json', PLAN.sitemap);
    await workspace.materialiseArtifact('specs/pages/home.json', PLAN.sitemap.pages[0]);

    const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef: profileRef, sitePlanRef: planRef });
    const runIntentHash = computeRunIntentHash({ projectId, profile: INTAKE as never });
    const binding = await prepareFrontendBackendBuildBinding(store, {
      projectId,
      runIntentHash,
      businessProfileRef: profileRef,
      sitePlanRef: planRef,
      jobSpec: spec,
      specificationBaseCommit: await workspace.currentCommit(),
    });

    const firstSha = await ensureSpecificationCommitted(store, workspace, binding, PLAN);
    expect(firstSha).not.toBeNull();

    // Simulate "the Git commit succeeded but the Mongo update never landed".
    await store.frontendBackendBuildBindings.updateOne({ _id: binding._id }, { $set: { specificationCommitSha: null } });
    const staleBinding = await store.frontendBackendBuildBindings.findOne({ _id: binding._id });

    const secondSha = await ensureSpecificationCommitted(store, workspace, staleBinding!, PLAN);
    expect(secondSha).toBe(firstSha);

    const marker = `Statx-Build-Binding-Id: ${binding._id}`;
    expect(await workspace.findCommitsByMarker(marker)).toHaveLength(1);

    const finalBinding = await store.frontendBackendBuildBindings.findOne({ _id: binding._id });
    expect(finalBinding?.specificationCommitSha).toBe(firstSha);
  });
});

describe('multiple commits carrying the same exact marker is corruption', () => {
  it('fails closed rather than choosing the newest', async () => {
    const projectId = 'proj_5k_multiple_markers';
    const workspace = await ProjectWorkspace.open(projectId, workspacesRoot);
    const profileRef = await registry.put(projectId, 'business-profile', INTAKE);
    await registry.accept(projectId, profileRef);
    const planRef = await registry.put(projectId, 'site-plan', PLAN);
    await registry.accept(projectId, planRef);
    await workspace.materialiseArtifact('client/business-profile.json', INTAKE);
    await workspace.materialiseArtifact('design/brand-system.json', PLAN.brandSystem);
    await workspace.materialiseArtifact('specs/sitemap.json', PLAN.sitemap);
    await workspace.materialiseArtifact('specs/pages/home.json', PLAN.sitemap.pages[0]);

    const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef: profileRef, sitePlanRef: planRef });
    const runIntentHash = computeRunIntentHash({ projectId, profile: INTAKE as never });
    const binding = await prepareFrontendBackendBuildBinding(store, {
      projectId,
      runIntentHash,
      businessProfileRef: profileRef,
      sitePlanRef: planRef,
      jobSpec: spec,
      specificationBaseCommit: await workspace.currentCommit(),
    });

    await ensureSpecificationCommitted(store, workspace, binding, PLAN);

    // Simulate corruption directly: a second, genuinely different commit
    // that happens to carry the identical exact marker line — never
    // producible by this module itself (it always searches first), but a
    // state this check must still recognise and refuse rather than silently
    // pick between.
    const marker = `Statx-Build-Binding-Id: ${binding._id}`;
    await workspace.materialiseArtifact('unrelated/second-marker-source.json', { note: 'forces a real diff' });
    await workspace.commit(`Harness: specification\n\n${marker}`);
    expect(await workspace.findCommitsByMarker(marker)).toHaveLength(2);

    await expect(ensureSpecificationCommitted(store, workspace, binding, PLAN)).rejects.toThrow(
      runBindingModule.FrontendBackendBuildBindingMarkerCorrupt,
    );
  });
});

describe('base commit conflict before the specification commit', () => {
  it('refuses to commit the bound specification onto an unexpected lineage', async () => {
    const projectId = 'proj_5k_base_conflict';
    const workspace = await ProjectWorkspace.open(projectId, workspacesRoot);
    const profileRef = await registry.put(projectId, 'business-profile', INTAKE);
    await registry.accept(projectId, profileRef);
    const planRef = await registry.put(projectId, 'site-plan', PLAN);
    await registry.accept(projectId, planRef);

    const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef: profileRef, sitePlanRef: planRef });
    const runIntentHash = computeRunIntentHash({ projectId, profile: INTAKE as never });
    const binding = await prepareFrontendBackendBuildBinding(store, {
      projectId,
      runIntentHash,
      businessProfileRef: profileRef,
      sitePlanRef: planRef,
      jobSpec: spec,
      specificationBaseCommit: await workspace.currentCommit(),
    });

    // Someone else's canonical write lands on this project's lineage first.
    await workspace.materialiseArtifact('unrelated/marker.json', { note: 'unrelated write' });
    await workspace.commit('Unrelated: some other canonical change');

    await expect(ensureSpecificationCommitted(store, workspace, binding, PLAN)).rejects.toThrow(FrontendBackendBuildBindingBaseConflict);
  });
});

describe('a foreign dirty file still blocks specification recovery on resume', () => {
  it('rejects, uncommitted, before Phase 5i ever runs', async () => {
    const projectId = 'proj_5k_foreign_dirty_recovery';
    const workspace = await ProjectWorkspace.open(projectId, workspacesRoot);
    const profileRef = await registry.put(projectId, 'business-profile', INTAKE);
    await registry.accept(projectId, profileRef);
    const planRef = await registry.put(projectId, 'site-plan', PLAN);
    await registry.accept(projectId, planRef);
    await workspace.materialiseArtifact('client/business-profile.json', INTAKE);
    await workspace.materialiseArtifact('design/brand-system.json', PLAN.brandSystem);
    await workspace.materialiseArtifact('specs/sitemap.json', PLAN.sitemap);
    await workspace.materialiseArtifact('specs/pages/home.json', PLAN.sitemap.pages[0]);

    const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef: profileRef, sitePlanRef: planRef });
    const runIntentHash = computeRunIntentHash({ projectId, profile: INTAKE as never });
    const binding = await prepareFrontendBackendBuildBinding(store, {
      projectId,
      runIntentHash,
      businessProfileRef: profileRef,
      sitePlanRef: planRef,
      jobSpec: spec,
      specificationBaseCommit: await workspace.currentCommit(),
    });

    await writeFile(join(workspacesRoot, projectId, 'unexpected-foreign-file.txt'), 'not part of the specification\n', 'utf8');

    await expect(ensureSpecificationCommitted(store, workspace, binding, PLAN)).rejects.toThrow(
      runBindingModule.RunProjectSpecificationWorkingTreeDirty,
    );
    expect(await workspace.currentCommit()).toBeNull();
  });
});

describe('legacy_direct never touches bindings', () => {
  it('creates no binding-related durable state', async () => {
    const projectId = 'proj_5k_legacy_untouched';
    const result = await runLegacy(projectId);
    expect(result.outcome).toBe('released');
    expect(await store.frontendBackendBuildBindings.countDocuments({})).toBe(0);
  });

  it('the legacy branch of orchestrator.ts contains no binding-related call', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pathJoin } = await import('node:path');
    const src = pathJoin(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'orchestrator.ts');
    const code = await readFile(src, 'utf8');
    const legacyBranch = code.slice(code.indexOf('} else {\n    await buildFromPlan'));
    for (const call of ['findActivePreparedBinding', 'prepareFrontendBackendBuildBinding', 'ensureSpecificationCommitted', 'finalizeBindingPromoted']) {
      expect(legacyBranch.slice(0, legacyBranch.indexOf('\n  }\n'))).not.toContain(call);
    }
  });
});

describe('run-service.ts: no caller is activated as of Phase 5k', () => {
  /**
   * True when this suite was written (Phase 5k): no caller had opted into
   * `job_lifecycle` yet, so `run-service.ts` mentioned neither string at
   * all. Phase 5l deliberately changes that — it activates `job_lifecycle`
   * for the one real production entrypoint, wiring `frontendBackendExecutionMode`
   * straight through `launchRun` — so the literal "never mentions either
   * string" assertion this test made is now obsolete *by design*, not a
   * regression. What this test actually guarded — that `launchRun` picks
   * `legacy_direct` for any caller that does not explicitly ask for
   * `job_lifecycle` — is still true and is pinned here directly instead;
   * Phase 5l's own suite (`run-service.integration.test.ts`) covers the
   * rest of the activation surface, including a dedicated structural test
   * that exactly one production caller (`apps/console/app/api/runs
   * /route.ts`) references either string at all.
   */
  it("launchRun's own default, for a caller that omits frontendBackendExecutionMode, is still exactly legacy_direct", async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pathJoin } = await import('node:path');
    const src = pathJoin(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'run-service.ts');
    const code = await readFile(src, 'utf8');
    expect(code).toContain("options.frontendBackendExecutionMode ?? 'legacy_direct'");
  });
});
