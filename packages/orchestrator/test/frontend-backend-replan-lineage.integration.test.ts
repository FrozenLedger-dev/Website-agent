/**
 * Durable authority for post-replan frontend/backend rebuilds (Phase 5q0) —
 * end to end, against a real Mongo replica set and a real canonical Git
 * workspace.
 *
 * A replanned rebuild used to canonicalise through `clearSite()` +
 * `buildFromPlan()` even when the run was in `job_lifecycle` mode, which left
 * the resulting tree with no durable evidence tying it to the plan it
 * implements. The primary test below drives the real orchestrator through two
 * successive replans and proves the whole composition instead of each helper
 * separately: real adjudication asking for a replan, the exact revised plan
 * and decision, a successor binding naming its exact predecessor, the ordinary
 * lifecycle (Terra, isolated validation, guarded acceptance, the Phase 5n
 * fence), and the exact-replacement promotion actually removing the route the
 * revision dropped.
 *
 * The mock setup mirrors the run-binding suite's (agents, the compiler and the
 * gates are faked; `JobEngine`, `JobRunner`, the production Terra handler,
 * 5g-1, 5g-2, 5h and `runProject` itself are real) plus the parity suite's
 * `replanSite`/`adjudicate` sequencing, because no existing rig could drive a
 * `job_lifecycle` replan: the two job-mode suites cannot replan, and the one
 * that can runs in `legacy_direct`.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { ReplanSuccessorProvenance, type ArtifactRef, type BuildSuccessorProvenance, type SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import type { FrontendBackendBuildBindingDocument } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import {
  FrontendBackendBuildBindingCorrupt,
  FrontendBackendBuildLineageConflict,
  computeRunIntentHash,
  prepareFrontendBackendBuildBinding,
} from '../src/run-binding/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';

/** A replan reason, proven against the contract exactly as production proves it. */
const replan = (replanDecision: ArtifactRef): BuildSuccessorProvenance => ReplanSuccessorProvenance.parse({ kind: 'replan', replanDecision });

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
let adjudications: { action: string; reason: string; defectIds: string[] | null; objective: null; scope: 'page' | 'design' | 'site' | null }[];
let revisedPlans: SitePlan[];
let gateVerdict: { passed: boolean; findings: unknown[]; gatesRun: string[] } = { passed: true, findings: [], gatesRun: ['claims'] };
let compileOk = true;
let terraBuildCalls = 0;
let planSiteCalls = 0;
let replanSiteCalls = 0;
/** Every candidate file set Terra produced, in order — one per build generation. */
let terraFileSets: string[][] = [];

const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  id: 'QA-004',
  category: 'accessibility',
  severity: 'P2',
  location: 'index.html',
  reason: 'No way to make an enquiry anywhere on the site.',
  acceptanceTest: 'A visitor can contact the business.',
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
  sections: [{ id: 's1', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }],
});

const planWith = (routes: [string, string][]): SitePlan =>
  ({
    strategy: 'Local trade credibility',
    valueProposition: 'Fitted joinery, made and installed by the same two people.',
    brandSystem: {
      palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
      typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
      artDirection: 'Trade-signage directness.',
      radius: 'square',
      rationale: 'Workwear palette suits the trade.',
    },
    sitemap: { pages: routes.map(([route, title]) => page(route, title)) },
    acceptanceCriteria: ['a', 'b', 'c'],
  }) as unknown as SitePlan;

/** P0: three routes. Each later revision drops one. */
const P0 = planWith([['/', 'Home'], ['/services', 'Services'], ['/about', 'About']]);
const P1 = planWith([['/', 'Home'], ['/about', 'About']]);
const P2 = planWith([['/', 'Home']]);

const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

/** Terra builds one file per planned route, so a dropped route means a dropped file. */
function filesForPlan(plan: SitePlan, generation: number): { path: string; contents: string }[] {
  return plan.sitemap.pages.map((p) => ({
    path: p.route === '/' ? 'app/page.tsx' : `app${p.route}/page.tsx`,
    contents: `export default function P(){return ${generation}}`,
  }));
}

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => {
      planSiteCalls += 1;
      return { value: P0, model: 'gpt-5.6-sol', ...usage };
    }),
    routeBuild: vi.fn(async () => ({
      value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    buildSite: vi.fn(async (_client: unknown, _profile: unknown, plan: SitePlan) => {
      terraBuildCalls += 1;
      const files = filesForPlan(plan, terraBuildCalls);
      terraFileSets.push(files.map((f) => f.path));
      return { value: { files, notes: '' }, model: 'gpt-5.6-terra', ...usage };
    }),
    reviewSite: vi.fn(async () => {
      const r = next(reviewSequence);
      return {
        value: { decision: r.blocking ? 'reject' : 'accept', qualityScore: r.qualityScore, blocking: r.blocking, issues: r.issues, summary: 's' },
        model: 'gpt-5.6-terra',
        ...usage,
      };
    }),
    recommendApproval: vi.fn(async () => ({ value: approval, model: 'gpt-5.6-sol', ...usage })),
    adjudicate: vi.fn(async () => ({ value: next(adjudications), model: 'gpt-5.6-sol', ...usage })),
    replanSite: vi.fn(async () => {
      replanSiteCalls += 1;
      return {
        value: {
          failureDiagnosis: 'The plan carried a route the business does not offer.',
          changes: [{ area: '/services', change: 'removed', reason: 'not offered' }],
          preservedAreas: ['brand'],
          revisedPlan: next(revisedPlans),
        },
        model: 'gpt-5.6-sol',
        ...usage,
      };
    }),
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
  return { ...actual, runGates: vi.fn(() => gateVerdict) };
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
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5q0-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5q0-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  gateVerdict = { passed: true, findings: [], gatesRun: ['claims'] };
  compileOk = true;
  terraBuildCalls = 0;
  planSiteCalls = 0;
  replanSiteCalls = 0;
  terraFileSets = [];
  revisedPlans = [P1];
  reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
  approval = { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: ['QA-004'] };
  adjudications = [{ action: 'block', reason: 'unused by default', defectIds: null, objective: null, scope: null }];
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
  await store.defectBudgets.deleteMany({});
  await store.promotions.deleteMany({});
  await store.frontendBackendBuildBindings.deleteMany({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const runJobMode = async (projectId: string) => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({
    projectId,
    intake: INTAKE,
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
    validationWorkspacesRoot,
  });
};

const bindings = async (projectId: string): Promise<FrontendBackendBuildBindingDocument[]> =>
  store.frontendBackendBuildBindings.find({ projectId }).sort({ createdAt: 1 }).toArray();

const canonicalWorkspace = (projectId: string) => ProjectWorkspace.open(projectId, workspacesRoot);

/**
 * One review cycle that rejects and asks for a replan, then accepts. Drives
 * the real adjudication branch rather than reaching into the orchestrator.
 */
function expectReplanCycles(count: number): void {
  const blockingIssue = () =>
    issue({ id: 'QA-010', category: 'structure', severity: 'P1', reason: 'No way to make an enquiry anywhere on the site.' });
  reviewSequence = [
    ...Array.from({ length: count }, () => ({ qualityScore: 60, blocking: true, issues: [blockingIssue()] })),
    { qualityScore: 92, blocking: false, issues: [issue()] },
  ];
  adjudications = [
    ...Array.from({ length: count }, () => ({
      action: 'replan' as const,
      reason: 'The plan carries a route the business does not offer.',
      defectIds: null,
      objective: null,
      scope: 'site' as const,
    })),
    { action: 'block' as const, reason: 'unused', defectIds: null, objective: null, scope: null },
  ];
}

// ---------------------------------------------------------------------------

describe('a job_lifecycle run that replans', () => {
  it('rebuilds through the durable lifecycle and records exact B0 -> B1 -> B2 lineage', async () => {
    const projectId = 'proj_5q0_lineage';
    expectReplanCycles(2);
    revisedPlans = [P1, P2];

    const result = await runJobMode(projectId);
    expect(result.outcome).toBe('released');

    // --- three generations, in order, each its own durable authority -------
    const [b0, b1, b2] = await bindings(projectId);
    expect([b0, b1, b2].every(Boolean)).toBe(true);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(3);

    // B0 is an initial build: no lineage fields at all, not null placeholders.
    expect(b0!.predecessorBindingId).toBeUndefined();
    expect(b0!.replanDecision).toBeUndefined();
    expect(b0!.status).toBe('promoted');

    // B1 replaces exactly B0; B2 replaces exactly B1 — never B0 again.
    expect(b1!.predecessorBindingId).toBe(b0!._id);
    expect(b2!.predecessorBindingId).toBe(b1!._id);
    expect(b1!.status).toBe('promoted');
    expect(b2!.status).toBe('promoted');

    // --- exact refs, never "latest" ---------------------------------------
    const planDocs = await store.artifacts.find({ projectId, name: 'site-plan' }).sort({ version: 1 }).toArray();
    const replanDocs = await store.artifacts.find({ projectId, name: 'replan-decision' }).sort({ version: 1 }).toArray();
    expect(planDocs).toHaveLength(3); // P0, P1, P2
    expect(replanDocs).toHaveLength(2); // R1, R2

    expect(b0!.sitePlan.version).toBe(1);
    expect(b1!.sitePlan.version).toBe(2);
    expect(b2!.sitePlan.version).toBe(3);
    expect(b1!.replanDecision!.version).toBe(1);
    expect(b2!.replanDecision!.version).toBe(2);

    // The profile is inherited exactly — discovery never reran.
    expect(b1!.businessProfile).toEqual(b0!.businessProfile);
    expect(b2!.businessProfile).toEqual(b0!.businessProfile);
    expect(planSiteCalls).toBe(1);
    expect(replanSiteCalls).toBe(2);

    // --- the lifecycle actually ran for each rebuild ------------------------
    const jobs = await store.jobs.find({ projectId }).toArray();
    expect(jobs).toHaveLength(3);
    for (const b of [b0!, b1!, b2!]) {
      const job = jobs.find((j) => j._id === b.jobId)!;
      expect(job.state).toBe('accepted');
      expect(job.executionOutputs).toHaveLength(1);
      // Phase 5n fenced every one of them, replans included.
      expect(job.promotionFence?.promotionId).toBe(b.promotionId);
    }
    expect(jobs.find((j) => j._id === b0!.jobId)!.origin).toEqual({ kind: 'plan' });
    for (const b of [b1!, b2!]) {
      expect(jobs.find((j) => j._id === b.jobId)!.origin).toMatchObject({ kind: 'replan' });
    }

    // Terra built once per generation, each from its own plan.
    expect(terraBuildCalls).toBe(3);
    expect(terraFileSets[0]).toEqual(['app/page.tsx', 'app/services/page.tsx', 'app/about/page.tsx']);
    expect(terraFileSets[1]).toEqual(['app/page.tsx', 'app/about/page.tsx']);
    expect(terraFileSets[2]).toEqual(['app/page.tsx']);

    // --- ordinary Phase 5h promotion identity for every generation ---------
    const promotions = await store.promotions.find({ projectId }).toArray();
    expect(promotions).toHaveLength(3);
    for (const b of [b0!, b1!, b2!]) {
      const receipt = promotions.find((p) => p._id === b.promotionId)!;
      expect(receipt.status).toBe('committed');
      expect(receipt.commitSha).toBe(b.promotionCommitSha);
    }

    // --- the exact-replacement prerequisite actually removed the routes ----
    const ws = await canonicalWorkspace(projectId);
    expect(existsSync(join(ws.siteRoot, 'app/services/page.tsx'))).toBe(false);
    expect(existsSync(join(ws.siteRoot, 'app/about/page.tsx'))).toBe(false);
    expect(existsSync(join(ws.siteRoot, 'app/page.tsx'))).toBe(true);
    const tracked = await ws.trackedSiteFiles();
    expect(tracked).not.toContain('app/app/services/page.tsx');
    expect(tracked).not.toContain('app/app/about/page.tsx');
    expect(tracked).toContain('app/app/page.tsx');
    // Scaffold-owned files are never collateral.
    expect(tracked).toContain('app/.gitignore');
  });

  it('never canonicalises a job_lifecycle replan through the direct build path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: joinPath } = await import('node:path');
    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(joinPath(src, 'orchestrator.ts'), 'utf8');

    // Comments stripped first: the job-mode arm's own doc comment states the
    // guarantee in prose ("No `clearSite()` here"), and a raw scan would match
    // that instead of a call.
    const executable = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const branch = executable.slice(
      executable.indexOf("adjudication.action === 'replan'"),
      executable.indexOf('const targets = mustFix.filter'),
    );

    // The job-mode arm reaches the durable lifecycle…
    const guard = branch.indexOf("frontendBackendExecutionMode === 'job_lifecycle'");
    const lifecycle = branch.indexOf('lifecycleCoordinator.run');
    expect(guard).toBeGreaterThan(-1);
    expect(lifecycle).toBeGreaterThan(guard);
    expect(branch).toContain('prepareFrontendBackendBuildBinding');
    expect(branch).toContain("kind: 'replan'");

    // …and every destructive/direct call sits strictly after it, on the
    // legacy arm the job-mode path `continue`s past.
    for (const direct of ['clearSite', 'buildFromPlan']) {
      const at = branch.indexOf(direct);
      expect(at, direct).toBeGreaterThan(lifecycle);
    }
    expect(branch).not.toContain('publishBuildDirectly');
  });
});

describe('lineage authority', () => {
  /** A promoted B0 to hang successors from, without running the orchestrator. */
  async function promotedPredecessor(projectId: string): Promise<FrontendBackendBuildBindingDocument> {
    const profileRef = await registry.put(projectId, 'business-profile', INTAKE);
    const planRef = await registry.put(projectId, 'site-plan', P0);
    const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef: profileRef, sitePlanRef: planRef });
    const b0 = await prepareFrontendBackendBuildBinding(store, {
      projectId,
      runIntentHash: computeRunIntentHash({ projectId, profile: INTAKE as never }),
      businessProfileRef: profileRef,
      sitePlanRef: planRef,
      jobSpec: spec,
      specificationBaseCommit: null,
    });
    await store.frontendBackendBuildBindings.updateOne(
      { _id: b0._id },
      { $set: { status: 'promoted', promotionId: 'prom_b0', promotionCommitSha: 'a'.repeat(40) } },
    );
    return (await store.frontendBackendBuildBindings.findOne({ _id: b0._id }))!;
  }

  async function successorInput(projectId: string, b0: FrontendBackendBuildBindingDocument, plan: SitePlan) {
    const planRef = await registry.put(projectId, 'site-plan', plan);
    const decisionRef = await registry.put(projectId, 'replan-decision', { reviewCycle: 0, plan: plan.valueProposition });
    const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef: b0.businessProfile, sitePlanRef: planRef });
    return {
      projectId,
      runIntentHash: b0.runIntentHash,
      businessProfileRef: b0.businessProfile,
      sitePlanRef: planRef,
      jobSpec: spec,
      specificationBaseCommit: b0.promotionCommitSha,
      lineage: { predecessorBindingId: b0._id, provenance: replan(decisionRef) },
    };
  }

  it('permits exactly one successor per predecessor, even under a real race', async () => {
    const projectId = 'proj_5q0_one_successor';
    const b0 = await promotedPredecessor(projectId);

    // Two genuinely different successors of the same predecessor.
    const a = await successorInput(projectId, b0, P1);
    const b = await successorInput(projectId, b0, P2);
    expect(a.jobSpec.jobId).not.toBe(b.jobSpec.jobId);

    const outcomes = await Promise.allSettled([
      prepareFrontendBackendBuildBinding(store, a),
      prepareFrontendBackendBuildBinding(store, b),
    ]);

    // Database authority, not a process-local lock: exactly one lineage
    // successor exists afterwards, whichever won.
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(FrontendBackendBuildLineageConflict);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, predecessorBindingId: b0._id })).toBe(1);
  });

  it('converges when the exact same successor is prepared twice', async () => {
    const projectId = 'proj_5q0_converge';
    const b0 = await promotedPredecessor(projectId);
    const input = await successorInput(projectId, b0, P1);

    const first = await prepareFrontendBackendBuildBinding(store, input);
    const second = await prepareFrontendBackendBuildBinding(store, input);

    expect(second._id).toBe(first._id);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, predecessorBindingId: b0._id })).toBe(1);
  });

  it('fails closed rather than rewriting authority when lineage conflicts', async () => {
    const projectId = 'proj_5q0_immutable';
    const b0 = await promotedPredecessor(projectId);
    const input = await successorInput(projectId, b0, P1);
    const stored = await prepareFrontendBackendBuildBinding(store, input);

    // Same deterministic identity, different replan decision.
    const otherDecision = await registry.put(projectId, 'replan-decision', { reviewCycle: 9, plan: 'different' });
    await expect(
      prepareFrontendBackendBuildBinding(store, {
        ...input,
        lineage: { predecessorBindingId: b0._id, provenance: replan(otherDecision) },
      }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildBindingCorrupt);

    // …and presenting a successor as though it were an initial build.
    // The same deterministic identity, presented as though it were an initial
    // build. Spelled out rather than spread-minus-lineage, so the absence is
    // the point of the fixture rather than an artefact of how it was built.
    await expect(
      prepareFrontendBackendBuildBinding(store, {
        projectId: input.projectId,
        runIntentHash: input.runIntentHash,
        businessProfileRef: input.businessProfileRef,
        sitePlanRef: input.sitePlanRef,
        jobSpec: input.jobSpec,
        specificationBaseCommit: input.specificationBaseCommit,
      }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildBindingCorrupt);

    const unchanged = (await store.frontendBackendBuildBindings.findOne({ _id: stored._id }))!;
    expect(unchanged.replanDecision).toEqual((input.lineage.provenance as { replanDecision: ArtifactRef }).replanDecision);
    expect(unchanged.predecessorBindingId).toBe(b0._id);
  });

  it('resolves the same prepared successor after objects are reconstructed', async () => {
    const projectId = 'proj_5q0_prepared_survives';
    const b0 = await promotedPredecessor(projectId);
    const input = await successorInput(projectId, b0, P1);
    const prepared = await prepareFrontendBackendBuildBinding(store, input);

    // A second "process": fresh store and registry handles, durable state only.
    const store2 = await StateStore.connect({
      uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
      dbName: 'statxai_test',
    });
    try {
      const again = await prepareFrontendBackendBuildBinding(store2, input);
      expect(again._id).toBe(prepared._id);
      expect(again.predecessorBindingId).toBe(b0._id);
      expect(again.replanDecision).toEqual((input.lineage.provenance as { replanDecision: ArtifactRef }).replanDecision);
      expect(again.sitePlan).toEqual(input.sitePlanRef);
      expect(again.jobId).toBe(input.jobSpec.jobId);
      expect(await store2.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(2);
    } finally {
      await store2.close();
    }
  });

  it('builds the successor index against historical bindings that have no lineage', async () => {
    const projectId = 'proj_5q0_migration';
    const now = new Date();
    const legacy = (id: string, status: string) =>
      ({
        _id: id,
        projectId,
        status,
        runIntentHash: 'h',
        businessProfile: { name: 'business-profile', version: 1 } as ArtifactRef,
        sitePlan: { name: 'site-plan', version: 1 } as ArtifactRef,
        jobSpec: {} as never,
        jobSpecHash: 'x',
        jobId: `job_${id}`,
        specificationBaseCommit: null,
        specificationCommitSha: null,
        promotionId: null,
        promotionCommitSha: null,
        createdAt: now,
        updatedAt: now,
      }) as unknown as FrontendBackendBuildBindingDocument;

    // Several pre-5q0 documents, none carrying the field the index filters on.
    await store.frontendBackendBuildBindings.insertMany([
      legacy('legacy_a', 'promoted'),
      legacy('legacy_b', 'promoted'),
      legacy('legacy_c', 'abandoned'),
    ]);

    // Dropped first, so this proves `ensureIndexes()` *creates* the constraint
    // rather than that the database happens to retain one from an earlier run:
    // Mongo keeps indexes independently of the code that declared them, so
    // asserting mere presence would pass even with the declaration deleted.
    await store.frontendBackendBuildBindings
      .dropIndex('projectId_1_predecessorBindingId_1')
      .catch(() => undefined);
    const beforeNames = (await store.frontendBackendBuildBindings.indexes()).map((i) => i.name);
    expect(beforeNames).not.toContain('projectId_1_predecessorBindingId_1');

    await expect(store.ensureIndexes()).resolves.not.toThrow();

    const names = (await store.frontendBackendBuildBindings.indexes()).map((i) => i.name);
    expect(names).toContain('projectId_1_predecessorBindingId_1');
    // Absent lineage means "initial or legacy" — they stay outside the index
    // and are never adopted as successors of anything.
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, predecessorBindingId: { $exists: true } })).toBe(0);
  });
});

describe('canonical authority advances only on promotion', () => {
  it('leaves the predecessor canonical when the successor never promotes', async () => {
    const projectId = 'proj_5q0_unpromoted';
    expectReplanCycles(1);
    revisedPlans = [P1];

    /**
     * The successor's candidate fails its isolated validation, so B1 is never
     * accepted and never promoted.
     *
     * Keyed on the plan being measured rather than a call count: 5g-1 runs the
     * very same gates against the candidate in its own disposable workspace,
     * so counting invocations rejects whichever generation happens to be
     * measured second — which is B0's own validation, not the rebuild's.
     */
    const gates = await import('@statxai/gates');
    vi.spyOn(gates, 'runGates').mockImplementation(((ctx: { plan: SitePlan }) =>
      ctx.plan.sitemap.pages.length === P0.sitemap.pages.length
        ? { passed: true, findings: [], gatesRun: ['claims'] }
        : {
            passed: false,
            findings: [{ severity: 'P0', gate: 'claims', location: 'app/page.tsx', message: 'unsupported claim' }],
            gatesRun: ['claims'],
          }) as never);

    const result = await runJobMode(projectId);
    expect(result.outcome).toBe('blocked');

    const all = await bindings(projectId);
    const b0 = all.find((b) => b.predecessorBindingId === undefined)!;
    const b1 = all.find((b) => b.predecessorBindingId !== undefined);

    // B0 stays the canonical, promoted authority.
    expect(b0.status).toBe('promoted');
    expect(b0.promotionCommitSha).not.toBeNull();

    // A successor that never promoted is not canonical and never finalised.
    if (b1) {
      expect(b1.status).toBe('prepared');
      expect(b1.promotionId).toBeNull();
      expect(b1.promotionCommitSha).toBeNull();
    }

    /**
     * Exactly one promotion exists, and it is the predecessor's.
     *
     * Deliberately not "HEAD still equals B0's promotion commit": the
     * successor's own specification commit legitimately advances HEAD before
     * the lifecycle runs, exactly as the initial build's does. That commit
     * touches `specs/`, `design/`, `client/` and `decisions/` and never
     * `app/`, so the canonical *site* is still the predecessor's — which is
     * the property that matters and the one asserted below.
     */
    const promotions = await store.promotions.find({ projectId }).toArray();
    expect(promotions).toHaveLength(1);
    expect(promotions[0]!.commitSha).toBe(b0.promotionCommitSha);

    const ws = await canonicalWorkspace(projectId);
    expect(existsSync(join(ws.siteRoot, 'app/services/page.tsx'))).toBe(true);
    // Terra's rebuilt candidate never reached the canonical tree.
    expect(await ws.trackedSiteFiles()).toContain('app/app/services/page.tsx');
  });
});

describe('unchanged paths', () => {
  it('creates an initial build with no lineage fields at all', async () => {
    const projectId = 'proj_5q0_initial';
    const result = await runJobMode(projectId);

    expect(result.outcome).toBe('released');
    const [b0, ...rest] = await bindings(projectId);
    expect(rest).toHaveLength(0);
    expect(b0!.status).toBe('promoted');
    expect('predecessorBindingId' in b0!).toBe(false);
    expect('replanDecision' in b0!).toBe(false);
    expect(replanSiteCalls).toBe(0);
  });

  it('leaves legacy_direct replans on the direct rebuild path', async () => {
    const projectId = 'proj_5q0_legacy';
    expectReplanCycles(1);
    revisedPlans = [P1];

    const result = await runLegacy(projectId);

    expect(result.outcome).toBe('released');
    expect(replanSiteCalls).toBe(1);
    // No job-mode authority is created for a legacy rollback run at all.
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(0);
    expect(await store.jobs.countDocuments({ projectId })).toBe(0);
    expect(await store.promotions.countDocuments({ projectId })).toBe(0);
  });

  it('charges the replan budget exactly once per replan', async () => {
    const projectId = 'proj_5q0_budget';
    expectReplanCycles(2);
    revisedPlans = [P1, P2];

    await runJobMode(projectId);

    const budget = await store.budgets.findOne({ _id: projectId });
    // Two replans, two rejection cycles — routing through the lifecycle adds
    // no second charge of its own.
    expect(budget?.used.replans).toBe(2);
    expect(budget?.used.reviewRejections).toBe(2);
    expect(budget?.used.fullRebuilds).toBe(0);
  });
});
