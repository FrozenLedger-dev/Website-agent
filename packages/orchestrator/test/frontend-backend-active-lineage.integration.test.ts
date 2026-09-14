/**
 * Durable active frontend/backend lineage authority.
 *
 * The question this capability exists to answer is exactly one: *which build
 * lineage currently owns unfinished project continuation authority?* Before
 * it, that could not be answered at all once a project had more than one
 * generation — a promoted root freed the project's one-active-binding slot, so
 * a second, unrelated root could be founded for the same project and structural
 * tip selection then yielded two roots and two tips with nothing but timestamps
 * to separate them.
 *
 * So the invariant proven here is *at most one unfinished lineage owns a
 * project* — not one lineage root per project forever. Historical completed
 * lineages coexist freely; a later legitimate generation may acquire the slot
 * once the previous owner is durably done.
 *
 * The end-to-end cases drive the real `runProject` (mock setup mirrors
 * `frontend-backend-replan-lineage.integration.test.ts`: agents, the compiler
 * and the gates are faked; `JobEngine`, `JobRunner`, the production Terra
 * handler, 5g-1, 5g-2, 5h and `runProject` itself are real) because the facts
 * that matter — promotion does not release, a failed invocation does not
 * release, a terminal run does — are properties of the composition rather than
 * of any one helper. The rest call the module directly, which is both exact and
 * fast.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { ReplanSuccessorProvenance, type ArtifactRef, type BuildSuccessorProvenance, type SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import type { FrontendBackendBuildBindingDocument } from '@statxai/state';
import {
  FrontendBackendActiveLineageConflict,
  FrontendBackendBuildBindingConflict,
  FrontendBackendBuildLineageCorrupt,
  FrontendBackendBuildLineageRootUnproven,
  deriveActiveLineageTip,
  finalizeBindingPromoted,
  findActiveLineageRoot,
  prepareFrontendBackendBuildBinding,
  releaseActiveLineage,
} from '../src/run-binding/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import { fakeExport } from './support/site-model-export.js';

/** A replan reason, proven against the contract exactly as production proves it. */
const replan = (replanDecision: ArtifactRef): BuildSuccessorProvenance => ReplanSuccessorProvenance.parse({ kind: 'replan', replanDecision });

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

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
let gateVerdict: { passed: boolean; findings: unknown[]; gatesRun: string[] } = { passed: true, findings: [], gatesRun: ['claims'] };
let compileOk = true;
let terraBuildCalls = 0;

const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);

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

const P0 = planWith([['/', 'Home'], ['/about', 'About']]);

const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

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
    planSite: vi.fn(async () => ({ value: P0, model: 'gpt-5.6-sol', ...usage })),
    routeBuild: vi.fn(async () => ({
      value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    buildSite: vi.fn(async (_client: unknown, _profile: unknown, plan: SitePlan) => {
      terraBuildCalls += 1;
      return { value: { files: filesForPlan(plan, terraBuildCalls), notes: '' }, model: 'gpt-5.6-terra', ...usage };
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
      throw new Error('replan not expected in this suite');
    }),
  };
});

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    scaffoldSite: vi.fn(actual.scaffoldSite),
    buildSite: vi.fn(async () => ({ ok: compileOk, durationMs: 5, output: compileOk ? '' : 'compile error: x', outDir: '/out' })),
    // A faithful export of the editable site model the run pinned, so the real site-model gate measures it.
    readBuiltFiles: vi.fn(async (siteRoot: string) => fakeExport(store, siteRoot, [{ path: 'index.html', contents: '<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Harrowgate Joinery</h1></main></body></html>' }], '<h1>Harrowgate Joinery</h1>')),
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
let workspacesRoot: string;
let validationWorkspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-lineage-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-lineage-validate-'));
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
  await store.releasePublications.deleteMany({});
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

const ref = (name: string, version: number): ArtifactRef => ({ name, version });

/** Prepare a binding directly — no workspace, no lifecycle, just durable authority. */
const prepare = async (
  projectId: string,
  marker: string,
  lineage?: { predecessorBindingId: string; provenance: BuildSuccessorProvenance },
): Promise<FrontendBackendBuildBindingDocument> => {
  const businessProfileRef = ref('business-profile', 1);
  const sitePlanRef = ref('site-plan', Number(marker));
  const jobSpec = createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef });
  return prepareFrontendBackendBuildBinding(store, {
    projectId,
    runIntentHash: `intent-${marker}`,
    businessProfileRef,
    sitePlanRef,
    jobSpec,
    specificationBaseCommit: null,
    ...(lineage ? { lineage } : {}),
  });
};

const promote = (bindingId: string, n: number) =>
  finalizeBindingPromoted(store, bindingId, { promotionId: `promo-${n}`, promotionCommitSha: String(n).repeat(40).slice(0, 40) });

const activeCount = (projectId: string) =>
  store.frontendBackendBuildBindings.countDocuments({ projectId, activeLineage: true });

const reload = (id: string) => store.frontendBackendBuildBindings.findOne({ _id: id });

// ---------------------------------------------------------------------------

describe('lineage root identity', () => {
  it('an initial build founds its own lineage and acquires the project', async () => {
    const projectId = 'proj_lin_root';
    const b0 = await prepare(projectId, '1');

    expect(b0.lineageRootBindingId).toBe(b0._id);
    expect(b0.activeLineage).toBe(true);
    expect(await activeCount(projectId)).toBe(1);
  });

  it('an initial build records no replan lineage fields at all — absent, not null', async () => {
    const b0 = await prepare('proj_lin_initial_fields', '1');

    expect(b0.predecessorBindingId).toBeUndefined();
    expect(b0.replanDecision).toBeUndefined();
    expect('predecessorBindingId' in b0).toBe(false);
    expect('replanDecision' in b0).toBe(false);
  });

  it('successors inherit the exact root and take no second slot: B0 <- B1 <- B2, root B0 throughout', async () => {
    const projectId = 'proj_lin_chain';
    const b0 = await prepare(projectId, '1');
    await promote(b0._id, 1);

    const b1 = await prepare(projectId, '2', { predecessorBindingId: b0._id, provenance: replan(ref('replan-decision', 1)) });
    await promote(b1._id, 2);
    const b2 = await prepare(projectId, '3', { predecessorBindingId: b1._id, provenance: replan(ref('replan-decision', 2)) });

    // Predecessor links stay exact (Phase 5q0, unchanged) ...
    expect(b1.predecessorBindingId).toBe(b0._id);
    expect(b2.predecessorBindingId).toBe(b1._id);
    // ... and every generation names the same root, without walking for it.
    expect(b1.lineageRootBindingId).toBe(b0._id);
    expect(b2.lineageRootBindingId).toBe(b0._id);

    // Exactly one active owner, and it is the root — never a successor.
    expect(b1.activeLineage).toBeUndefined();
    expect(b2.activeLineage).toBeUndefined();
    expect(await activeCount(projectId)).toBe(1);
    expect((await findActiveLineageRoot(store, projectId))?._id).toBe(b0._id);
  });

  it('exact initial replay converges on the one binding and the one slot — never a second root', async () => {
    const projectId = 'proj_lin_replay';
    const first = await prepare(projectId, '1');
    const again = await prepare(projectId, '1');

    expect(again._id).toBe(first._id);
    expect(again.lineageRootBindingId).toBe(first._id);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
    expect(await activeCount(projectId)).toBe(1);
  });

  it('two concurrent incompatible fresh roots: exactly one acquires the project', async () => {
    const projectId = 'proj_lin_race';
    const results = await Promise.allSettled([prepare(projectId, '1'), prepare(projectId, '2')]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    // A confident authority conflict about this project — never misreported as
    // a replan lineage conflict, which is a different fact entirely.
    const error = (lost[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(FrontendBackendBuildBindingConflict);

    expect(await activeCount(projectId)).toBe(1);
  });
});

describe('active lineage lifecycle', () => {
  it('promotion does not release the project — the gap this capability closes', async () => {
    const projectId = 'proj_lin_promote';
    const b0 = await prepare(projectId, '1');
    await promote(b0._id, 1);

    const after = await reload(b0._id);
    expect(after?.status).toBe('promoted');
    expect(after?.activeLineage).toBe(true);
    expect((await findActiveLineageRoot(store, projectId))?._id).toBe(b0._id);
  });

  it('promoting a successor never moves ownership off the root', async () => {
    const projectId = 'proj_lin_promote_successor';
    const b0 = await prepare(projectId, '1');
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '2', { predecessorBindingId: b0._id, provenance: replan(ref('replan-decision', 1)) });
    await promote(b1._id, 2);

    expect((await reload(b1._id))?.activeLineage).toBeUndefined();
    expect((await findActiveLineageRoot(store, projectId))?._id).toBe(b0._id);
    expect(await activeCount(projectId)).toBe(1);
  });

  it('a run whose build never promotes keeps the project owned — a dead invocation is not terminal', async () => {
    const projectId = 'proj_lin_not_promoted';
    compileOk = false; // isolated validation fails, so the lifecycle never promotes

    const result = await runJobMode(projectId);
    expect(result.outcome).toBe('blocked');
    expect(result.jobLifecycleOutcome).toBeDefined();
    expect(result.jobLifecycleOutcome).not.toBe('promoted');

    // No terminal project state was written, so nothing released the project.
    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('building');
    expect(await activeCount(projectId)).toBe(1);
  });

  it('a released run releases the project, and the lineage stays as history', async () => {
    const projectId = 'proj_lin_released';

    const result = await runJobMode(projectId);
    expect(result.outcome).toBe('released');

    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('released');
    expect(await activeCount(projectId)).toBe(0);

    // History preserved, not deleted, and still naming its own lineage.
    const all = await store.frontendBackendBuildBindings.find({ projectId }).toArray();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('promoted');
    expect(all[0]!.lineageRootBindingId).toBe(all[0]!._id);
    expect(all[0]!.activeLineage).toBeUndefined();
  });

  it('a blocked run releases the project — matching the real terminal contract', async () => {
    const projectId = 'proj_lin_blocked';
    reviewSequence = [
      { qualityScore: 40, blocking: true, issues: [issue({ id: 'QA-900', severity: 'P0', reason: 'No contact route exists anywhere.' })] },
    ];
    adjudications = [{ action: 'block', reason: 'Unrecoverable.', defectIds: null, objective: null, scope: null }];

    const result = await runJobMode(projectId);
    expect(result.outcome).toBe('blocked');

    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('blocked');
    expect(await activeCount(projectId)).toBe(0);
  });

  it('a later legitimate generation may acquire the project once the previous owner is done', async () => {
    const projectId = 'proj_lin_next_generation';
    const b0 = await prepare(projectId, '1');
    await promote(b0._id, 1);

    // While owned, a second lineage is refused ...
    await expect(prepare(projectId, '2')).rejects.toBeInstanceOf(FrontendBackendActiveLineageConflict);

    // ... and once the owner is durably done, a fresh root is welcome.
    await releaseActiveLineage(store, projectId);
    const fresh = await prepare(projectId, '2');

    expect(fresh._id).not.toBe(b0._id);
    expect(fresh.lineageRootBindingId).toBe(fresh._id);
    expect(fresh.activeLineage).toBe(true);
    expect(await activeCount(projectId)).toBe(1);

    // The previous lineage is still there, readable, and inactive.
    const old = await reload(b0._id);
    expect(old?.status).toBe('promoted');
    expect(old?.activeLineage).toBeUndefined();
  });

  it('release is idempotent, so a crash between the terminal write and it converges on replay', async () => {
    const projectId = 'proj_lin_replay_release';
    const b0 = await prepare(projectId, '1');
    await promote(b0._id, 1);

    // The crash window: terminal state written, release not yet.
    await store.projects.insertOne({
      _id: projectId,
      state: 'released',
      autonomyMode: 'full_autonomous',
      reviewCycle: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await activeCount(projectId)).toBe(1);

    // Replaying the release completes it; replaying again changes nothing.
    await releaseActiveLineage(store, projectId);
    expect(await activeCount(projectId)).toBe(0);
    await releaseActiveLineage(store, projectId);
    expect(await activeCount(projectId)).toBe(0);

    expect((await reload(b0._id))?.status).toBe('promoted');
  });

  /**
   * Atomicity is the one property here that no behavioural test can observe:
   * reordering the terminal write and the release is invisible unless the
   * process dies between them. So it is pinned at the source, the same way
   * this repo already pins its project-state write surface.
   */
  it('writes every terminal project state and its release in one transaction', async () => {
    const stripped = (s: string) => s.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    /** Each `withTransaction(...)` call's full text, by paren matching. */
    const transactionBlocks = (code: string): string[] => {
      const blocks: string[] = [];
      let from = 0;
      for (;;) {
        const start = code.indexOf('withTransaction(', from);
        if (start === -1) return blocks;
        let depth = 0;
        let i = code.indexOf('(', start);
        for (; i < code.length; i += 1) {
          if (code[i] === '(') depth += 1;
          else if (code[i] === ')' && (depth -= 1) === 0) break;
        }
        blocks.push(code.slice(start, i + 1));
        from = i + 1;
      }
    };

    const pairedWith = async (file: string, state: string, expected: number) => {
      const code = stripped(await readFile(file, 'utf8'));
      const paired = transactionBlocks(code).filter(
        (b) => b.includes(`state: '${state}'`) && b.includes('releaseActiveLineage('),
      );
      // Every write of this state is inside a transaction that also releases —
      // none left outside one.
      expect(paired).toHaveLength(expected);
      expect(code.split(`state: '${state}'`).length - 1).toBe(expected);
    };

    await pairedWith(join(SRC, 'phases', 'publish.ts'), 'released', 1);
    await pairedWith(join(SRC, 'orchestrator.ts'), 'blocked', 2);

    // And the state that is parked for a person rather than finished is
    // deliberately not paired with a release at all.
    const orchestrator = stripped(await readFile(join(SRC, 'orchestrator.ts'), 'utf8'));
    expect(transactionBlocks(orchestrator).some((b) => b.includes("state: 'awaiting_human_review'"))).toBe(false);
  });
});

describe('structural lookups', () => {
  it('derives the exact tip of B0 -> B1 -> B2 from links alone', async () => {
    const projectId = 'proj_lin_tip';
    const b0 = await prepare(projectId, '1');
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '2', { predecessorBindingId: b0._id, provenance: replan(ref('replan-decision', 1)) });
    await promote(b1._id, 2);
    const b2 = await prepare(projectId, '3', { predecessorBindingId: b1._id, provenance: replan(ref('replan-decision', 2)) });

    const root = await findActiveLineageRoot(store, projectId);
    expect(root?._id).toBe(b0._id);
    expect((await deriveActiveLineageTip(store, root!))._id).toBe(b2._id);
  });

  it('a single-generation lineage is its own tip', async () => {
    const projectId = 'proj_lin_tip_single';
    const b0 = await prepare(projectId, '1');
    const root = await findActiveLineageRoot(store, projectId);
    expect((await deriveActiveLineageTip(store, root!))._id).toBe(b0._id);
  });

  it('fails closed on a branched chain rather than choosing a successor', async () => {
    const projectId = 'proj_lin_branch';
    const b0 = await prepare(projectId, '1');
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '2', { predecessorBindingId: b0._id, provenance: replan(ref('replan-decision', 1)) });
    await promote(b1._id, 2);

    // A branch cannot arise while Phase 5q0's one-successor index holds — that
    // is exactly what the index is for — so it is dropped to manufacture the
    // corrupt state this guard exists to catch, then restored immediately.
    await store.frontendBackendBuildBindings.dropIndex('projectId_1_predecessorBindingId_1');
    try {
      await store.frontendBackendBuildBindings.insertOne({
        ...b1,
        _id: `${b1._id}-rival`,
        status: 'promoted',
        updatedAt: new Date(),
      });

      const root = await findActiveLineageRoot(store, projectId);
      const error = await deriveActiveLineageTip(store, root!).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
      // The branch guard specifically, not merely "something rejected". The
      // reachability check below it would also refuse *this* shape, so an
      // assertion on the class alone would let the branch guard be deleted
      // unnoticed — and the two are not interchangeable: a rival successor
      // claiming a foreign root is invisible to reachability.
      expect((error as Error).message).toMatch(/does not branch/);
    } finally {
      // The branch itself has to go before the unique index can be rebuilt —
      // otherwise restoring the constraint fails on the rows just written.
      await store.frontendBackendBuildBindings.deleteMany({ projectId });
      await store.ensureIndexes();
    }
  });

  it('fails closed on a cycle', async () => {
    const projectId = 'proj_lin_cycle';
    const b0 = await prepare(projectId, '1');
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '2', { predecessorBindingId: b0._id, provenance: replan(ref('replan-decision', 1)) });

    // b0 now points at b1, which points at b0.
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $set: { predecessorBindingId: b1._id } });

    const root = await reload(b0._id);
    await expect(deriveActiveLineageTip(store, root!)).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
  });

  it('fails closed on a member that claims the root but is unreachable from it', async () => {
    const projectId = 'proj_lin_orphan';
    const b0 = await prepare(projectId, '1');

    // Claims the lineage, but its predecessor does not exist. Written as
    // `promoted` and without the active marker, so what fails here is the
    // reachability rule under test rather than either slot index.
    const orphan: FrontendBackendBuildBindingDocument = {
      ...b0,
      _id: `${b0._id}-orphan`,
      status: 'promoted',
      predecessorBindingId: 'frontend-backend-build-missing',
      replanDecision: ref('replan-decision', 1),
      updatedAt: new Date(),
    };
    delete orphan.activeLineage;
    await store.frontendBackendBuildBindings.insertOne(orphan);

    const root = await findActiveLineageRoot(store, projectId);
    await expect(deriveActiveLineageTip(store, root!)).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
  });

  it('fails closed when the presented root is not a root, or claims a foreign root', async () => {
    const projectId = 'proj_lin_bad_root';
    const b0 = await prepare(projectId, '1');

    await expect(
      deriveActiveLineageTip(store, { ...b0, predecessorBindingId: 'frontend-backend-build-elsewhere' }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);

    await expect(
      deriveActiveLineageTip(store, { ...b0, lineageRootBindingId: 'frontend-backend-build-elsewhere' }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
  });

  it('resolves ownership and the tip without any newest/latest/timestamp inference', async () => {
    const source = await readFile(join(SRC, 'run-binding', 'frontend-backend.ts'), 'utf8');
    const body = source.slice(source.indexOf('export async function findActiveLineageRoot'), source.indexOf('export async function releaseActiveLineage'));
    // Comments explain *why* time is not used, so they are stripped before the
    // claim is measured against the code itself.
    const code = body.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/\.sort\(/);
    expect(code).not.toMatch(/createdAt/);
    expect(code).not.toMatch(/updatedAt/);
    expect(code).toMatch(/activeLineage: true/);
  });
});

describe('legacy bindings that predate lineage authority', () => {
  /** A pre-capability document: no root, no active marker, and no backfill. */
  const insertLegacy = async (projectId: string, id: string, over: Partial<FrontendBackendBuildBindingDocument> = {}) => {
    const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef: ref('business-profile', 1), sitePlanRef: ref('site-plan', 1) });
    await store.frontendBackendBuildBindings.insertOne({
      _id: id,
      projectId,
      status: 'promoted',
      runIntentHash: 'legacy-intent',
      businessProfile: ref('business-profile', 1),
      sitePlan: ref('site-plan', 1),
      jobSpec: spec,
      jobSpecHash: 'legacy',
      jobId: spec.jobId,
      specificationBaseCommit: null,
      specificationCommitSha: null,
      promotionId: 'legacy-promo',
      promotionCommitSha: 'c'.repeat(40),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
  };

  it('are never silently adopted as the current authority', async () => {
    const projectId = 'proj_lin_legacy_ambiguous';
    // Exactly the ambiguity that forced Phase 5q to stop: two historical roots.
    await insertLegacy(projectId, 'legacy-root-a');
    await insertLegacy(projectId, 'legacy-root-b');

    // No guess, no newest-wins — simply no proven owner.
    expect(await findActiveLineageRoot(store, projectId)).toBeNull();
  });

  it('a successor of a legacy predecessor fails closed rather than inventing a root', async () => {
    const projectId = 'proj_lin_legacy_successor';
    await insertLegacy(projectId, 'legacy-root-c');

    await expect(
      prepare(projectId, '2', { predecessorBindingId: 'legacy-root-c', provenance: replan(ref('replan-decision', 1)) }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildLineageRootUnproven);
  });

  it('survive ensureIndexes with no backfill, and the active-lineage index really is built', async () => {
    const projectId = 'proj_lin_legacy_migration';
    await insertLegacy(projectId, 'legacy-root-d');

    const named = async () => (await store.frontendBackendBuildBindings.indexes()).map((i) => i.name);

    // Dropped first, so this proves `ensureIndexes()` *creates* the constraint
    // rather than finding one Mongo already happened to hold.
    if ((await named()).includes('projectId_1_activeLineage')) {
      await store.frontendBackendBuildBindings.dropIndex('projectId_1_activeLineage');
    }
    expect(await named()).not.toContain('projectId_1_activeLineage');

    await expect(store.ensureIndexes()).resolves.not.toThrow();
    expect(await named()).toContain('projectId_1_activeLineage');

    // Untouched: no root invented, no marker added.
    const legacy = await reload('legacy-root-d');
    expect(legacy?.lineageRootBindingId).toBeUndefined();
    expect(legacy?.activeLineage).toBeUndefined();
  });
});
