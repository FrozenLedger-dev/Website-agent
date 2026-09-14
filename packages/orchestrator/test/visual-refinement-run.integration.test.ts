/**
 * Bounded Terra visual refinement, end to end, against a real Mongo replica set
 * and a real canonical Git workspace.
 *
 * `runProject` in `job_lifecycle` mode is real, and so is everything a
 * refinement crosses: the durable authorisation and budget, the refinement job
 * spec, `JobEngine`/`JobRunner`, the production handler (which reads the exact
 * source snapshot and recuts the exact reviewed frames from real PNG blobs),
 * isolated 5g-1 validation, 5g-2 acceptance, the 5h promotion fence, receipt and
 * exact-replacement promotion, the typed successor binding, fresh evaluation,
 * screenshot persistence, the multimodal review phase, Sol's approval and Phase
 * 5q recovery. Faked: the model skills, the compiler, the gates, and the browser
 * capture (which returns real PNGs bound to the exact subject it was asked to render).
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import {
  ScreenshotSet,
  VisualQualityReview,
  VisualRefinementSource,
  type ArtifactRef,
  type SitePlan,
} from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import type { FrontendBackendBuildBindingDocument } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace, WriteOutsideModelScope } from '@statxai/workspace';
import { FrontendBackendBuildBindingCorrupt } from '../src/run-binding/frontend-backend.js';

// ---------------------------------------------------------------------------
// Scripted collaborators
// ---------------------------------------------------------------------------

const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

const page = (route: string, title: string) => ({
  route,
  title,
  metaDescription: 'd',
  goal: 'g',
  primaryAction: 'call',
  sections: [{ id: 's1', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }],
});
const PLAN = {
  strategy: 'Local trade credibility',
  valueProposition: 'Fitted joinery.',
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: 'Trade-signage directness.',
    radius: 'square',
    rationale: 'Workwear palette.',
  },
  sitemap: { pages: [page('/', 'Home'), page('/services', 'Services')] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

const pagesOf = (plan: SitePlan, marker: string) =>
  plan.sitemap.pages.map((p) => ({ path: p.route === '/' ? 'app/page.tsx' : `app${p.route}/page.tsx`, contents: `export default function P(){return "${marker}"}` }));

/** A visual assessment that speaks only about targets the reviewer was shown. */
const assessment = (overallScore: number) => ({
  overallScore,
  scores: { composition: overallScore, typography: overallScore, spacingRhythm: overallScore, hierarchy: overallScore, brandDistinctiveness: overallScore, assetQuality: overallScore, conversionClarity: overallScore, mobileQuality: overallScore },
  summary: `overall ${overallScore}`,
  routeReviews: [{ route: '/', viewports: ['desktop', 'mobile'], score: overallScore, summary: 's' }],
  strengths: ['Clear phone'],
  issues: [{ id: 'VQ-001', route: '/', viewports: ['mobile'], dimension: 'mobileQuality', severity: 'moderate', problem: 'Stacked.', direction: 'Recompose.' }],
  antiPatterns: [{ pattern: 'three_equal_cards', route: '/services', viewports: ['desktop'] }],
  refinementPriorities: [{ rank: 1, dimension: 'composition', route: '/', direction: 'Break the hero.' }],
});

let visualScores: number[];
let refineBehaviour: ((n: number, plan: SitePlan) => { files: { path: string; contents: string }[] }) | null;
let captureFailures: Set<number>;
const calls = { buildSite: 0, reviewVisual: 0, capture: 0, refine: [] as Agents.VisualRefinementInput[], approve: [] as unknown[], adjudicate: 0 };

const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => ({ value: PLAN, model: 'sol', ...usage })),
    routeBuild: vi.fn(async () => ({ value: { action: 'one_shot', reason: 'small', confidence: 0.9, workstreams: null }, model: 'sol', ...usage })),
    buildSite: vi.fn(async (_r: unknown, _p: unknown, plan: SitePlan) => {
      calls.buildSite += 1;
      return { value: { files: pagesOf(plan, 'B0'), notes: '' }, model: 'terra', ...usage };
    }),
    reviewSite: vi.fn(async () => ({ value: { decision: 'accept', qualityScore: 91, blocking: false, issues: [], summary: 's' }, model: 'terra', ...usage })),
    reviewVisualQuality: vi.fn(async () => {
      calls.reviewVisual += 1;
      return { value: assessment(next(visualScores)), model: 'terra-vision', invocationId: `vr-${calls.reviewVisual}`, skill: 'terra-review', tier: 'terra', ...usage };
    }),
    refineSiteVisually: vi.fn(async (_r: unknown, input: Agents.VisualRefinementInput) => {
      calls.refine.push(input);
      const n = calls.refine.length;
      const value = refineBehaviour ? refineBehaviour(n, input.plan) : { files: pagesOf(input.plan, `refined ${n}`) };
      return { value: { ...value, notes: 'refined' }, model: 'terra', invocationId: `refine-${n}`, skill: 'terra-refine', tier: 'terra', ...usage };
    }),
    recommendApproval: vi.fn(async (_r: unknown, evidence: unknown) => {
      calls.approve.push(evidence);
      return { value: { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: [] }, model: 'sol', ...usage };
    }),
    adjudicate: vi.fn(async () => {
      calls.adjudicate += 1;
      return { value: { action: 'block', reason: 'unused', defectIds: null, objective: null, scope: null }, model: 'sol', ...usage };
    }),
  };
});

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, body: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
};
function png(width: number, height: number, seed: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row.fill((seed + (y >> 6)) & 0xff, 1);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async () => ({ ok: true, durationMs: 5, output: '', outDir: '/out' })),
    readBuiltFiles: vi.fn(async () => [
      { path: 'index.html', contents: '<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Harrowgate Joinery</h1></main></body></html>' },
    ]),
    readExportFiles: vi.fn(async () => []),
    readSourceFiles: vi.fn(async () => [{ path: 'app/page.tsx', contents: 'x' }]),
    deploymentConfigured: vi.fn(() => false),
    // Real PNGs of every planned route at every viewport, bound to exactly the subject the run asked to render.
    captureInBrowser: vi.fn(async (options: Workspace.BrowserRenderOptions) => {
      calls.capture += 1;
      if (captureFailures.has(calls.capture)) throw new Error('process died mid-evaluation');
      const subject = { ...options.subject, exportDigest: String(calls.capture).padStart(64, 'e') };
      const captures = options.plan.sitemap.pages.flatMap((p) =>
        actual.BROWSER_VIEWPORTS.map((viewport, i) => {
          const bytes = png(viewport.width, viewport.height, calls.capture * 16 + i);
          return { route: p.route, viewport, reason: 'captured' as const, page: { width: viewport.width, height: viewport.height }, truncated: false, png: bytes, width: viewport.width, height: viewport.height, detail: null };
        }),
      );
      return {
        report: {
          subject,
          runtime: { playwright: actual.PLAYWRIGHT_VERSION, image: actual.BROWSER_IMAGE },
          viewports: [...actual.BROWSER_VIEWPORTS],
          status: 'completed' as const,
          renders: captures.map((c) => ({ route: c.route, viewport: c.viewport.name, status: 'rendered' as const, httpStatus: 200, navigationMs: 1, readyMs: 1, findings: [] })),
          omittedRoutes: [],
          passed: true,
          truncated: false,
          durationMs: 1,
          reason: null,
        },
        captures,
        policy: actual.SCREENSHOT_POLICY,
      };
    }),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return { ...actual, runGates: vi.fn(() => ({ passed: true, findings: [], gatesRun: ['claims'] })) };
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
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-refine-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-refine-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  visualScores = [90];
  refineBehaviour = null;
  captureFailures = new Set();
  calls.buildSite = 0;
  calls.reviewVisual = 0;
  calls.capture = 0;
  calls.refine = [];
  calls.approve = [];
  calls.adjudicate = 0;
  for (const c of [store.jobs, store.auditLog, store.artifacts, store.projects, store.budgets, store.defectBudgets, store.promotions, store.frontendBackendBuildBindings, store.releasePublications, store.visualRefinementIntents, store.blobs]) {
    await (c as { deleteMany(f: object): Promise<unknown> }).deleteMany({});
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

const run = async (projectId: string) => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({ projectId, intake: INTAKE, store, workspacesRoot, autonomyMode: 'full_autonomous', frontendBackendExecutionMode: 'job_lifecycle', validationWorkspacesRoot });
};

/** The lineage from its root by exact predecessor id — never by time. */
async function chain(projectId: string): Promise<FrontendBackendBuildBindingDocument[]> {
  const all = await store.frontendBackendBuildBindings.find({ projectId }).toArray();
  const out = [all.find((b) => b.predecessorBindingId === undefined)!];
  for (;;) {
    const nextBuild = all.find((b) => b.predecessorBindingId === out.at(-1)!._id);
    if (!nextBuild) return out;
    out.push(nextBuild);
  }
}

const artifactsNamed = async (projectId: string, name: string) =>
  store.artifacts.find({ projectId, name }).sort({ lineageSeq: 1 }).toArray();
const refOf = (doc: { name: string; version: number; contentHash: string }): ArtifactRef => ({ name: doc.name, version: doc.version, contentHash: doc.contentHash });
const homeOnDisk = async (projectId: string) => readFile(join((await ProjectWorkspace.open(projectId, workspacesRoot)).siteRoot, 'app/page.tsx'), 'utf8');
const used = async (projectId: string) => (await store.budgets.findOne({ _id: projectId }))!.used.visualRefinements;

// ---------------------------------------------------------------------------

describe('two bounded passes through the ordinary lifecycle', () => {
  it('B0 → B1 → B2: each an exact, typed, promoted successor built from the exact evidence and source before it, then Sol judges only B2', async () => {
    const projectId = 'proj_refine_two_passes';
    visualScores = [62, 70, 75];

    const result = await run(projectId);
    expect(result.outcome).toBe('released');

    // --- Lineage: exact typed provenance, one successor per predecessor, one root.
    const [b0, b1, b2, ...rest] = await chain(projectId);
    expect(rest).toEqual([]);
    const sets = await artifactsNamed(projectId, 'screenshot-set');
    const reviews = await artifactsNamed(projectId, 'visual-quality-review');
    expect(sets).toHaveLength(3);
    expect(reviews).toHaveLength(3);
    const [s0, s1, s2] = sets.map(refOf) as [ArtifactRef, ArtifactRef, ArtifactRef];
    const [v0, v1, v2] = reviews.map(refOf) as [ArtifactRef, ArtifactRef, ArtifactRef];

    expect(b0!.predecessorBindingId).toBeUndefined();
    expect(b1).toMatchObject({ status: 'promoted', predecessorBindingId: b0!._id, lineageRootBindingId: b0!._id, successorProvenance: { kind: 'visual_refinement', visualQualityReview: v0, screenshotSet: s0, refinementCycle: 1 } });
    expect(b2).toMatchObject({ status: 'promoted', predecessorBindingId: b1!._id, lineageRootBindingId: b0!._id, successorProvenance: { kind: 'visual_refinement', visualQualityReview: v1, screenshotSet: s1, refinementCycle: 2 } });
    expect(b1).not.toHaveProperty('replanDecision');
    expect(b1).not.toHaveProperty('activeLineage');

    // --- Fresh evaluation of every build: its own gates, render, screenshots and review, bound to it.
    expect(calls.capture).toBe(3);
    expect(await store.artifacts.countDocuments({ projectId, name: 'test-report' })).toBe(3);
    const subjects = sets.map((s) => ScreenshotSet.parse(s.data).subject.authority);
    expect(subjects.map((a) => (a.mode === 'job_lifecycle' ? a.buildBindingId : null))).toEqual([b0!._id, b1!._id, b2!._id]);
    expect(subjects.map((a) => (a.mode === 'job_lifecycle' ? a.promotionCommitSha : null))).toEqual([b0!.promotionCommitSha, b1!.promotionCommitSha, b2!.promotionCommitSha]);
    expect(reviews.map((r) => VisualQualityReview.parse(r.data).screenshotSet)).toEqual([s0, s1, s2]);
    expect(new Set([s0.contentHash, s1.contentHash, s2.contentHash]).size).toBe(3);

    // --- Terra saw exactly the triggering evidence and the exact predecessor source, images included.
    expect(calls.refine).toHaveLength(2);
    expect(calls.refine[0]!.review).toMatchObject({ ref: v0, screenshotSet: s0 });
    expect(calls.refine[1]!.review).toMatchObject({ ref: v1, screenshotSet: s1 });
    // Every model-owned source file tracked at the rendered commit — the pages Terra wrote, and the scaffold's own layout and theme.
    const pages = (i: number) => calls.refine[i]!.source.filter((f) => f.path.endsWith('page.tsx'));
    expect(pages(0)).toEqual([{ path: 'app/page.tsx', contents: 'export default function P(){return "B0"}' }, { path: 'app/services/page.tsx', contents: 'export default function P(){return "B0"}' }]);
    expect(pages(1)).toEqual([{ path: 'app/page.tsx', contents: 'export default function P(){return "refined 1"}' }, { path: 'app/services/page.tsx', contents: 'export default function P(){return "refined 1"}' }]);
    expect(calls.refine[0]!.source.map((f) => f.path)).toContain('app/layout.tsx');
    expect(calls.refine[0]!.source.every((f) => !f.path.startsWith('components/ui/') && !f.path.includes('package.json'))).toBe(true);
    expect(calls.refine[1]!.predecessor.bindingId).toBe(b1!._id);
    expect(calls.refine.map((r) => r.refinementCycle)).toEqual([1, 2]);
    for (const [i, input] of calls.refine.entries()) {
      const review = VisualQualityReview.parse(reviews[i]!.data);
      expect(input.frames).toHaveLength(6);
      expect(input.frames.map((f) => `${f.route}@${f.viewport}`)).toEqual(review.frames.map((f) => `${f.route}@${f.viewport}`));
      expect(input.frames.every((f) => Buffer.from(f.png).subarray(1, 4).toString('latin1') === 'PNG')).toBe(true);
    }

    // --- The source each refinement read is exactly its predecessor's rendered commit.
    const intents = await store.visualRefinementIntents.find({ projectId }).sort({ refinementCycle: 1 }).toArray();
    expect(intents.map((i) => i.predecessorBindingId)).toEqual([b0!._id, b1!._id]);
    expect(intents.map((i) => i.budgetSlot)).toEqual([1, 2]);
    for (const [i, intent] of intents.entries()) {
      const source = VisualRefinementSource.parse(await registry.resolve(projectId, intent.source));
      expect(source.sourceCommit).toBe(ScreenshotSet.parse(sets[i]!.data).subject.sourceCommit);
      expect(source.promotionCommitSha).toBe([b0, b1][i]!.promotionCommitSha);
    }

    // --- Identity, origin, and the ordinary authority chain: acceptance, fence, receipt, replacement.
    const jobs = await Promise.all([b0, b1, b2].map((b) => store.jobs.findOne({ _id: b!.jobId })));
    expect(new Set(jobs.map((j) => j!._id)).size).toBe(3);
    expect(jobs.map((j) => j!.origin)).toEqual([{ kind: 'plan' }, { kind: 'visual_refine', refinementCycle: 1 }, { kind: 'visual_refine', refinementCycle: 2 }]);
    expect(jobs.every((j) => j!.state === 'accepted' && j!.promotionFence)).toBe(true);
    const receipts = await store.promotions.find({ projectId }).toArray();
    expect(receipts).toHaveLength(3);
    expect(receipts.every((r) => r.status === 'committed')).toBe(true);
    expect([b1, b2].map((b) => receipts.find((r) => r._id === b!.promotionId)?.commitSha)).toEqual([b1!.promotionCommitSha, b2!.promotionCommitSha]);
    expect(await homeOnDisk(projectId)).toBe('export default function P(){return "refined 2"}');

    // --- Budget: exactly two, and the third pass was refused even though B2 improved and is still low.
    expect(await used(projectId)).toBe(2);

    // --- Sol judged once, after refinement stopped, on B2's exact evidence.
    expect(calls.adjudicate).toBe(0);
    expect(calls.approve).toHaveLength(1);
    const approvals = await artifactsNamed(projectId, 'approval-recommendation');
    expect(approvals).toHaveLength(1);
    expect((approvals[0]!.data as { visualQualityReview: ArtifactRef }).visualQualityReview).toEqual(v2);
    expect(JSON.stringify(calls.approve[0])).toContain(`visual-quality-review@${v2.version} of screenshot-set@${s2.version}`);
    expect(JSON.stringify(calls.approve[0])).not.toContain(`visual-quality-review@${v0.version} `);
  });

  it('a refinement that did not improve stops there: the worse build stays canonical, both reviews are kept, and Sol judges it', async () => {
    const projectId = 'proj_refine_not_improved';
    visualScores = [62, 60];

    const result = await run(projectId);
    expect(result.outcome).toBe('released');

    const [b0, b1, ...rest] = await chain(projectId);
    expect(rest).toEqual([]);
    expect(b1!.status).toBe('promoted');
    expect(calls.refine).toHaveLength(1);
    expect(await used(projectId)).toBe(1);
    // No rollback: B1's tree is what is canonical, and B0's promotion is history.
    expect(await homeOnDisk(projectId)).toBe('export default function P(){return "refined 1"}');
    expect(await store.promotions.countDocuments({ projectId })).toBe(2);
    const reviews = await artifactsNamed(projectId, 'visual-quality-review');
    expect(reviews).toHaveLength(2);
    const approvals = await artifactsNamed(projectId, 'approval-recommendation');
    expect((approvals[0]!.data as { visualQualityReview: ArtifactRef }).visualQualityReview).toEqual(refOf(reviews[1]!));
    expect(b0!._id).toBe(b1!.lineageRootBindingId);
  });

  it('a high-quality initial build is never refined, and nothing is spent', async () => {
    const projectId = 'proj_refine_good_enough';
    visualScores = [90];

    expect((await run(projectId)).outcome).toBe('released');
    expect(await chain(projectId)).toHaveLength(1);
    expect(calls.refine).toHaveLength(0);
    expect(await used(projectId)).toBe(0);
    expect(await store.visualRefinementIntents.countDocuments({ projectId })).toBe(0);
  });
});

describe('a refinement that fails keeps its slot spent and never lands', () => {
  it('a candidate that adds a route fails official validation: blocked, B0 canonical, nothing promoted, the slot not restored', async () => {
    const projectId = 'proj_refine_validation_failed';
    visualScores = [62];
    refineBehaviour = (n, plan) => ({ files: [...pagesOf(plan, `refined ${n}`), { path: 'app/extra/page.tsx', contents: 'export default function E(){return 1}' }] });

    const result = await run(projectId);

    expect(result.outcome).toBe('blocked');
    expect(result.jobLifecycleOutcome).toBe('validation_failed');
    const [b0, b1] = await chain(projectId);
    expect(b1!.status).toBe('prepared');
    expect(await store.promotions.countDocuments({ projectId })).toBe(1);
    expect(await homeOnDisk(projectId)).toBe('export default function P(){return "B0"}');
    expect(await used(projectId)).toBe(1);
    expect(calls.approve).toHaveLength(0);
    expect(b0!.status).toBe('promoted');
  });

  it('a candidate path outside the model namespace is refused at the existing write boundary before anything canonical changes', async () => {
    const projectId = 'proj_refine_forbidden_path';
    visualScores = [62];
    refineBehaviour = (n, plan) => ({ files: [...pagesOf(plan, `refined ${n}`), { path: 'package.json', contents: '{"scripts":{"build":"curl evil"}}' }] });

    await expect(run(projectId)).rejects.toBeInstanceOf(WriteOutsideModelScope);
    expect(await store.promotions.countDocuments({ projectId })).toBe(1);
    expect(await homeOnDisk(projectId)).toBe('export default function P(){return "B0"}');
    const pkg = await readFile(join((await ProjectWorkspace.open(projectId, workspacesRoot)).siteRoot, 'package.json'), 'utf8');
    expect(pkg).not.toContain('curl evil');
    expect(await used(projectId)).toBe(1);
  });

  it('a failed model call is not retried into unlimited attempts: the slot stays spent, and the prepared successor is refused on the next invocation exactly as a prepared replan successor is', async () => {
    const projectId = 'proj_refine_model_failed';
    visualScores = [62];
    refineBehaviour = () => {
      throw new Error('provider unavailable');
    };

    const first = await run(projectId);
    expect(first.outcome).toBe('blocked');
    expect(['retry_ready', 'failed']).toContain(first.jobLifecycleOutcome);
    expect(calls.refine).toHaveLength(1);
    expect(await used(projectId)).toBe(1);

    // A restart: Phase 5k's existing prepared-binding recovery applies to a successor exactly as it does to a replan one.
    const again = run(projectId);
    await expect(again).rejects.toBeInstanceOf(FrontendBackendBuildBindingCorrupt);
    await expect(again).rejects.toThrow(/visual_refinement successor but was presented as an initial build/);
    expect(calls.refine).toHaveLength(1);
    expect(await used(projectId)).toBe(1);
    expect(await store.visualRefinementIntents.countDocuments({ projectId })).toBe(1);
  });
});

describe('Phase 5q owns a promoted visual refinement', () => {
  it('a crash after B1 promoted and before its evaluation recovers B1 itself: never re-created, never re-refined, no second slot, fresh evidence bound to B1', async () => {
    const projectId = 'proj_refine_crash_after_promotion';
    visualScores = [62, 90];
    captureFailures = new Set([2]);

    await expect(run(projectId)).rejects.toThrow(/process died mid-evaluation/);
    const [, b1] = await chain(projectId);
    expect(b1!.status).toBe('promoted');
    expect(await artifactsNamed(projectId, 'screenshot-set')).toHaveLength(1);
    expect(calls.refine).toHaveLength(1);
    expect(await used(projectId)).toBe(1);

    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    expect(calls.refine).toHaveLength(1);
    expect(await used(projectId)).toBe(1);
    expect(await chain(projectId)).toHaveLength(2);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(2);
    const sets = await artifactsNamed(projectId, 'screenshot-set');
    expect(sets).toHaveLength(2);
    const authority = ScreenshotSet.parse(sets[1]!.data).subject.authority;
    expect(authority).toMatchObject({ mode: 'job_lifecycle', buildBindingId: b1!._id, promotionId: b1!.promotionId });
    const reviews = await artifactsNamed(projectId, 'visual-quality-review');
    const approvals = await artifactsNamed(projectId, 'approval-recommendation');
    expect((approvals[0]!.data as { visualQualityReview: ArtifactRef }).visualQualityReview).toEqual(refOf(reviews.at(-1)!));
  });

  it('a recovered visual tip is refined again only under the same policy, from its own typed provenance: cycle two, improvement over its trigger', async () => {
    const projectId = 'proj_refine_recovered_second_pass';
    visualScores = [62, 70, 90];
    captureFailures = new Set([2]);

    await expect(run(projectId)).rejects.toThrow(/process died mid-evaluation/);
    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    const [b0, b1, b2] = await chain(projectId);
    expect(b2).toMatchObject({ predecessorBindingId: b1!._id, lineageRootBindingId: b0!._id, successorProvenance: { refinementCycle: 2 } });
    expect(calls.refine.map((r) => r.refinementCycle)).toEqual([1, 2]);
    expect(await used(projectId)).toBe(2);
  });
});
