/**
 * Draft-targeted run completion, end to end, against a real Mongo replica set
 * and a real canonical Git workspace.
 *
 * `runProject` in `job_lifecycle` mode is real, and so is everything a run
 * crosses: planning, the lifecycle (Terra handler, isolated validation with the
 * site-model gate, acceptance, the promotion fence and receipt, promotion),
 * evaluation, screenshots, the visual review, adjudication, replan, bounded
 * visual refinement, canonical draft authority, Phase 5q, release authorisation
 * and publication — and the semantic-edit lifecycle that consumes the draft.
 * Faked: the model skills, the compiler (a faithful export of the pages a build
 * wrote), the gates and the browser capture.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir as mkdirp, rm as rmDir, writeFile as writeOut } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { EditableSiteModel, ScreenshotSet, type SitePlan } from '@statxai/contracts';
import { StateStore, type FrontendBackendBuildBindingDocument } from '@statxai/state';
import { ArtifactRegistry, BlobStore, ProjectWorkspace, contentHash, readSiteExportFile, readSiteExportSnapshot, resolveSiteExportRequest } from '@statxai/workspace';
import { pageFilesForModel, exportFromPageFiles } from './support/site-model-export.js';
import { computeRunIntentHash, deriveLineageTipFromRoot, FrontendBackendBuildBindingConflict } from '../src/run-binding/frontend-backend.js';
import { CanonicalDraftAuthorityCorrupt, loadCurrentCanonicalDraft } from '../src/canonical-draft/authority.js';
import { ActiveContinuationAwaitingHumanReview, ActiveContinuationConcludedDraft, ActiveContinuationIntentConflict } from '../src/run-recovery/frontend-backend.js';
import { validateIntake } from '../src/phases/discover.js';
import { applySemanticEdit } from '../src/semantic-edit/apply.js';

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
const planWith = (pages: [string, string][]) =>
  ({
    strategy: 'Local trade credibility',
    valueProposition: 'Fitted joinery.',
    brandSystem: {
      palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
      typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
      artDirection: 'Trade-signage directness.',
      radius: 'square',
      rationale: 'Workwear palette.',
    },
    sitemap: { pages: pages.map(([route, title]) => page(route, title)) },
    acceptanceCriteria: ['a', 'b', 'c'],
  }) as unknown as SitePlan;
const PLAN = planWith([['/', 'Home'], ['/services', 'Services']]);
const REVISED = planWith([['/', 'Home']]);

const assessment = (overallScore: number) => ({
  overallScore,
  scores: { composition: overallScore, typography: overallScore, spacingRhythm: overallScore, hierarchy: overallScore, brandDistinctiveness: overallScore, assetQuality: overallScore, conversionClarity: overallScore, mobileQuality: overallScore },
  summary: `overall ${overallScore}`,
  routeReviews: [{ route: '/', viewports: ['desktop', 'mobile'], score: overallScore, summary: 's' }],
  strengths: ['Clear phone'],
  issues: [{ id: 'VQ-001', route: '/', viewports: ['mobile'], dimension: 'mobileQuality', severity: 'moderate', problem: 'Stacked.', direction: 'Recompose.' }],
  antiPatterns: [],
  refinementPriorities: [{ rank: 1, dimension: 'composition', route: '/', direction: 'Break the hero.' }],
});

const blockingIssue = { id: 'QA-010', category: 'structure', severity: 'P1', location: 'index.html', reason: 'No enquiry route.', acceptanceTest: 'A visitor can contact the business.', recommendedAction: 'replan', evidence: [] };

let visualScores: number[];
let reviews: { blocking: boolean }[];
let adjudications: { action: string }[];
let captureFailures: Set<number>;
/** Gate verdicts in call order: official validation measures first, canonical evaluation after. */
let gateVerdicts: boolean[];
let reviewThrows: boolean;
/** Test levers on the faithful compile and renderer: a wrong build digest, or a renderer that rendered something else. */
let compileDigestTamper: boolean;
let renderDigestTamper: boolean;
const calls = { plan: 0, build: 0, refine: 0, approve: 0, adjudicate: 0, replan: 0, capture: 0, edit: 0, deploy: 0 };
const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => {
      calls.plan += 1;
      return { value: PLAN, model: 'sol', ...usage };
    }),
    routeBuild: vi.fn(async () => ({ value: { action: 'one_shot', reason: 'small', confidence: 0.9, workstreams: null }, model: 'sol', ...usage })),
    buildSite: vi.fn(async (_r: unknown, _p: unknown, _plan: SitePlan, options: { siteModel: EditableSiteModel }) => {
      calls.build += 1;
      return { value: { files: pageFilesForModel(options.siteModel, `<p>build ${calls.build}</p>`), notes: '' }, model: 'terra', ...usage };
    }),
    reviewSite: vi.fn(async () => {
      if (reviewThrows) throw new Error('reviewer unavailable');
      const r = next(reviews);
      return { value: { decision: r.blocking ? 'reject' : 'accept', qualityScore: r.blocking ? 60 : 92, blocking: r.blocking, issues: r.blocking ? [blockingIssue] : [], summary: 's' }, model: 'terra', ...usage };
    }),
    reviewVisualQuality: vi.fn(async () => ({ value: assessment(next(visualScores)), model: 'terra-vision', invocationId: 'vr', skill: 'terra-review', tier: 'terra', ...usage })),
    refineSiteVisually: vi.fn(async (_r: unknown, input: Agents.VisualRefinementInput) => {
      calls.refine += 1;
      return { value: { files: pageFilesForModel(input.siteModel!, `<p>refined ${calls.refine}</p>`), notes: 'refined' }, model: 'terra', invocationId: `refine-${calls.refine}`, skill: 'terra-refine', tier: 'terra', ...usage };
    }),
    recommendApproval: vi.fn(async () => {
      calls.approve += 1;
      return { value: { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: [] }, model: 'sol', ...usage };
    }),
    adjudicate: vi.fn(async () => {
      calls.adjudicate += 1;
      return { value: { ...next(adjudications), reason: 'plan carries a route not offered', defectIds: null, objective: null, scope: 'site' }, model: 'sol', ...usage };
    }),
    replanSite: vi.fn(async () => {
      calls.replan += 1;
      return { value: { failureDiagnosis: 'd', changes: [{ area: '/services', change: 'removed', reason: 'not offered' }], preservedAreas: ['brand'], revisedPlan: REVISED }, model: 'sol', ...usage };
    }),
    editSiteSemantically: vi.fn(async (_r: unknown, input: Agents.SemanticEditInput) => {
      calls.edit += 1;
      return { value: { files: pageFilesForModel(input.model, `<p>edited ${calls.edit}</p>`), notes: 'edited' }, model: 'terra', invocationId: `edit-${calls.edit}`, skill: 'terra-edit', tier: 'terra', ...usage };
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
    // A faithful compile: the page files a build wrote become its static export in `out`, with the build's own digest.
    buildSite: vi.fn(async (siteRoot: string) => {
      const files = await exportFromPageFiles(siteRoot);
      const outDir = join(siteRoot, 'out');
      await rmDir(outDir, { recursive: true, force: true });
      for (const file of files) {
        await mkdirp(join(outDir, file.path, '..'), { recursive: true });
        await writeOut(join(outDir, file.path), file.contents, 'utf8');
      }
      const exportDigest = actual.exportDigestOf(files.map((f) => ({ path: f.path, sha256: createHash('sha256').update(f.contents).digest('hex') })));
      return { ok: true, durationMs: 5, output: '', outDir, exportDigest: compileDigestTamper ? 'f'.repeat(64) : exportDigest };
    }),
    readBuiltFiles: vi.fn(async (siteRoot: string) => exportFromPageFiles(siteRoot)),
    readExportFiles: vi.fn(async () => []),
    readSourceFiles: vi.fn(async () => [{ path: 'app/page.tsx', contents: 'x' }]),
    deploymentConfigured: vi.fn(() => false),
    deploySite: vi.fn(async () => {
      calls.deploy += 1;
      throw new Error('no deployment is configured in this suite');
    }),
    captureInBrowser: vi.fn(async (options: Workspace.BrowserRenderOptions) => {
      calls.capture += 1;
      if (captureFailures.has(calls.capture)) throw new Error('process died mid-evaluation');
      // The renderer digests exactly the export it was handed, as the real one does.
      const subject = { ...options.subject, exportDigest: renderDigestTamper ? 'd'.repeat(64) : (await actual.readExportTree(options.exportDir)).exportDigest };
      const captures = options.plan.sitemap.pages.flatMap((p) =>
        actual.BROWSER_VIEWPORTS.map((viewport, i) => ({ route: p.route, viewport, reason: 'captured' as const, page: { width: viewport.width, height: viewport.height }, truncated: false, png: png(viewport.width, viewport.height, calls.capture * 16 + i), width: viewport.width, height: viewport.height, detail: null })),
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
  return { ...actual, runGates: vi.fn(() => ({ passed: next(gateVerdicts), findings: [], gatesRun: ['claims'] })) };
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
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-draft-run-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-draft-run-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  visualScores = [90];
  reviews = [{ blocking: false }];
  adjudications = [{ action: 'block' }];
  captureFailures = new Set();
  gateVerdicts = [true];
  reviewThrows = false;
  compileDigestTamper = false;
  renderDigestTamper = false;
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
  for (const c of [store.jobs, store.auditLog, store.artifacts, store.projects, store.budgets, store.defectBudgets, store.promotions, store.frontendBackendBuildBindings, store.releasePublications, store.visualRefinementIntents, store.blobs, store.canonicalDrafts, store.semanticEditIntents]) {
    await (c as { deleteMany(f: object): Promise<unknown> }).deleteMany({});
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

const run = async (projectId: string, over: { completionTarget?: 'release' | 'draft'; frontendBackendExecutionMode?: 'job_lifecycle' | 'legacy_direct'; autonomyMode?: 'full_autonomous' | 'human_in_the_loop' } = {}) => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({
    projectId,
    intake: INTAKE,
    store,
    workspacesRoot,
    autonomyMode: over.autonomyMode ?? 'full_autonomous',
    frontendBackendExecutionMode: over.frontendBackendExecutionMode ?? 'job_lifecycle',
    validationWorkspacesRoot,
    ...(over.completionTarget ? { completionTarget: over.completionTarget } : {}),
  });
};

async function chain(projectId: string): Promise<FrontendBackendBuildBindingDocument[]> {
  const all = await store.frontendBackendBuildBindings.find({ projectId }).toArray();
  const out = [all.find((b) => b.predecessorBindingId === undefined)!];
  for (;;) {
    const nextBuild = all.find((b) => b.predecessorBindingId === out.at(-1)!._id);
    if (!nextBuild) return out;
    out.push(nextBuild);
  }
}

const profile = (() => {
  const v = validateIntake(INTAKE);
  if (!v.ok) throw new Error('intake');
  return v.profile;
})();

const count = (projectId: string, name: string) => store.artifacts.countDocuments({ projectId, name });
const commitSubjects = async (projectId: string) => execFileSync('git', ['log', '--format=%s'], { cwd: (await ProjectWorkspace.open(projectId, workspacesRoot)).root, encoding: 'utf8' });

/** Nothing release-specific happened. */
async function expectNoRelease(projectId: string) {
  expect(calls.approve).toBe(0);
  expect(calls.deploy).toBe(0);
  expect(await count(projectId, 'approval-recommendation')).toBe(0);
  expect(await count(projectId, 'release-authorization')).toBe(0);
  expect(await count(projectId, 'deployment-manifest')).toBe(0);
  expect(await store.releasePublications.countDocuments({ projectId })).toBe(0);
  expect(await commitSubjects(projectId)).not.toMatch(/release-authorized|release manifest/);
}

// ---------------------------------------------------------------------------

describe('a draft-targeted run', () => {
  it('runs the whole pipeline, then concludes exactly its final build as an available draft — and nothing release-specific', async () => {
    const projectId = 'proj_draftrun_b0';
    const result = await run(projectId, { completionTarget: 'draft' });

    const [b0, ...rest] = await chain(projectId);
    expect(rest).toEqual([]);
    expect(result.outcome).toBe('draft');
    expect(result.completionTarget).toBe('draft');

    // Durable intent: the root records the target, and the run intent hash distinguishes it.
    expect(b0).toMatchObject({ status: 'promoted', completionTarget: 'draft' });
    expect(b0!.runIntentHash).toBe(computeRunIntentHash({ projectId, profile, completionTarget: 'draft' }));
    expect(b0!.runIntentHash).not.toBe(computeRunIntentHash({ projectId, profile }));

    // The normal pipeline ran: plan, lifecycle build, official validation, promotion, evaluation, screenshots, review.
    expect(calls.plan).toBe(1);
    expect(calls.build).toBe(1);
    expect((await store.jobs.findOne({ _id: b0!.jobId }))?.state).toBe('accepted');
    expect(await store.promotions.findOne({ _id: b0!.promotionId! })).toMatchObject({ status: 'committed' });
    expect(await count(projectId, 'test-report')).toBe(1);
    expect(await count(projectId, 'screenshot-set')).toBe(1);
    expect(await count(projectId, 'visual-quality-review')).toBe(1);
    const set = ScreenshotSet.parse((await store.artifacts.findOne({ projectId, name: 'screenshot-set' }))!.data);
    expect(set.subject.authority).toMatchObject({ buildBindingId: b0!._id });

    // The exact draft.
    const draft = (await loadCurrentCanonicalDraft(store, projectId))!;
    expect(draft).toMatchObject({ status: 'available', current: true, lineageRootBindingId: b0!._id, canonicalBindingId: b0!._id, promotionId: b0!.promotionId, promotionCommitSha: b0!.promotionCommitSha });
    expect(result.draft).toEqual({
      canonicalDraftId: draft._id,
      lineageRootBindingId: b0!._id,
      canonicalBindingId: b0!._id,
      promotionId: b0!.promotionId,
      promotionCommitSha: b0!.promotionCommitSha,
      editableSiteModel: b0!.jobSpec.inputs.editableSiteModel,
      siteExportSnapshot: draft.siteExportSnapshot,
    });
    expect(result.draft!.editableSiteModel.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('draft');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, activeLineage: true })).toBe(0);
    await expectNoRelease(projectId);

    // The draft names the exact immutable export of exactly B0 — the same bytes the browser rendered and photographed.
    const s0 = await readSiteExportSnapshot(registry, projectId, draft.siteExportSnapshot!);
    expect(s0.subject).toMatchObject({ projectId, sitePlan: b0!.sitePlan, authority: { mode: 'job_lifecycle', buildBindingId: b0!._id, promotionId: b0!.promotionId, promotionCommitSha: b0!.promotionCommitSha }, editableSiteModel: b0!.jobSpec.inputs.editableSiteModel });
    expect(s0.exportDigest).toBe(set.subject.exportDigest);
    expect(await count(projectId, 'site-export-snapshot')).toBe(1);
    const services = await resolveSiteExportRequest(s0, '/services');
    expect(services).toBe('services.html');
    expect((await readSiteExportFile(new BlobStore(store), s0, services!))!.bytes.toString()).toContain('<p>build 1</p>');

    // A retry, or any fresh run, stops at the concluded draft — no second draft, no new root.
    await expect(run(projectId, { completionTarget: 'draft' })).rejects.toBeInstanceOf(ActiveContinuationConcludedDraft);
    await expect(run(projectId)).rejects.toBeInstanceOf(ActiveContinuationConcludedDraft);
    expect(await store.canonicalDrafts.countDocuments({ projectId })).toBe(1);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
    expect(calls.plan).toBe(1);
  });

  it('the generated draft is consumed directly by the semantic-edit lifecycle: D0 → edit → D1', async () => {
    const projectId = 'proj_draftrun_edit';
    const result = await run(projectId, { completionTarget: 'draft' });
    const d0 = result.draft!;
    const m0 = EditableSiteModel.parse(await registry.resolve(projectId, d0.editableSiteModel));
    const heading = m0.pages[0]!.sections[0]!.fields.find((f) => f.key === 'heading')!;

    const edited = await applySemanticEdit({
      store,
      workspacesRoot,
      validationWorkspacesRoot,
      projectId,
      expectedDraftId: d0.canonicalDraftId,
      expectedCanonicalBindingId: d0.canonicalBindingId,
      baseEditableSiteModel: d0.editableSiteModel,
      patch: { baseModel: d0.editableSiteModel, operation: { op: 'set_field_value', fieldId: heading.fieldId, expected: heading.value, value: 'Wardrobes made here' } },
    });

    expect(edited).toMatchObject({ status: 'completed', sourceDraftId: d0.canonicalDraftId, baseEditableSiteModel: d0.editableSiteModel });
    expect(calls.edit).toBe(1);
    const d1 = (await loadCurrentCanonicalDraft(store, projectId))!;
    expect(d1._id).toBe(edited.resultDraftId);
    expect(d1.canonicalBindingId).toBe(edited.successorBindingId);
    expect(await store.canonicalDrafts.findOne({ _id: d0.canonicalDraftId })).toMatchObject({ supersededByDraftId: d1._id });
    await expectNoRelease(projectId);
  });

  it('after bounded visual refinement B0 → B1 → B2, the draft is exactly B2', async () => {
    const projectId = 'proj_draftrun_refined';
    visualScores = [62, 70, 75];
    const result = await run(projectId, { completionTarget: 'draft' });

    const [b0, b1, b2, ...rest] = await chain(projectId);
    expect(rest).toEqual([]);
    expect(calls.refine).toBe(2);
    expect(b1!.successorProvenance).toMatchObject({ kind: 'visual_refinement' });
    expect(b2!.successorProvenance).toMatchObject({ kind: 'visual_refinement' });
    expect(result.draft).toMatchObject({ canonicalBindingId: b2!._id, lineageRootBindingId: b0!._id, promotionId: b2!.promotionId });
    expect((await loadCurrentCanonicalDraft(store, projectId))?.canonicalBindingId).toBe(b2!._id);
    expect(await store.canonicalDrafts.countDocuments({ projectId })).toBe(1);
    // Only the root records the target; successors belong to its run.
    expect(b1).not.toHaveProperty('completionTarget');
    expect(b2!.runIntentHash).toBe(b0!.runIntentHash);
    await expectNoRelease(projectId);
  });

  it('after a replan B0 → B1, the draft is exactly B1 — never the predecessor', async () => {
    const projectId = 'proj_draftrun_replan';
    reviews = [{ blocking: true }, { blocking: false }];
    adjudications = [{ action: 'replan' }, { action: 'block' }];
    const result = await run(projectId, { completionTarget: 'draft' });

    const [b0, b1, ...rest] = await chain(projectId);
    expect(rest).toEqual([]);
    expect(calls.replan).toBe(1);
    expect(b1!.replanDecision).toBeDefined();
    expect(result.outcome).toBe('draft');
    expect(result.draft).toMatchObject({ canonicalBindingId: b1!._id, lineageRootBindingId: b0!._id });
    expect(result.draft!.editableSiteModel).toEqual(b1!.jobSpec.inputs.editableSiteModel);
    expect(result.draft!.editableSiteModel).not.toEqual(b0!.jobSpec.inputs.editableSiteModel);
    expect((await deriveLineageTipFromRoot(store, (await store.frontendBackendBuildBindings.findOne({ _id: b0!._id }))!))._id).toBe(b1!._id);
    await expectNoRelease(projectId);
  });

  it('a build that is not release-ready is blocked, not drafted', async () => {
    const projectId = 'proj_draftrun_gates';
    // Validated and promoted, then measured at evaluation with a failing, non-blocking gate.
    gateVerdicts = [true, false];
    const result = await run(projectId, { completionTarget: 'draft' });
    expect(result.outcome).toBe('blocked');
    expect(result.terminalDecision).toBe('mark_blocked');
    expect(await store.canonicalDrafts.countDocuments({ projectId })).toBe(0);
    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('blocked');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, activeLineage: true })).toBe(0);
    await expectNoRelease(projectId);

    const unavailable = 'proj_draftrun_review';
    gateVerdicts = [true];
    reviewThrows = true;
    expect((await run(unavailable, { completionTarget: 'draft' })).outcome).toBe('blocked');
    expect(await store.canonicalDrafts.countDocuments({ projectId: unavailable })).toBe(0);
  });

  it('an export that changed after its build, or a render of different bytes, never becomes a draft', async () => {
    const { RunCompletionTargetUnsupported } = await import('../src/orchestrator.js');
    const changed = 'proj_draftrun_export_changed';
    compileDigestTamper = true;
    await expect(run(changed, { completionTarget: 'draft' })).rejects.toBeInstanceOf(RunCompletionTargetUnsupported);
    expect(await count(changed, 'site-export-snapshot')).toBe(0);
    expect(await store.canonicalDrafts.countDocuments({ projectId: changed })).toBe(0);

    const mismatched = 'proj_draftrun_render_mismatch';
    compileDigestTamper = false;
    renderDigestTamper = true;
    const { EvaluationSiteExportMismatch } = await import('../src/phases/evaluate.js');
    await expect(run(mismatched, { completionTarget: 'draft' })).rejects.toBeInstanceOf(EvaluationSiteExportMismatch);
    expect(await count(mismatched, 'screenshot-set')).toBe(0);
    expect(await store.canonicalDrafts.countDocuments({ projectId: mismatched })).toBe(0);
  });

  it('legacy_direct cannot conclude a draft, and is refused before anything is created', async () => {
    const { RunCompletionTargetUnsupported } = await import('../src/orchestrator.js');
    await expect(run('proj_draftrun_legacy', { completionTarget: 'draft', frontendBackendExecutionMode: 'legacy_direct' })).rejects.toBeInstanceOf(RunCompletionTargetUnsupported);
    expect(await store.projects.countDocuments({ _id: 'proj_draftrun_legacy' })).toBe(0);
    expect(calls.plan).toBe(0);
  });

  it('an unknown completion target is refused', async () => {
    const { runProject } = await import('../src/orchestrator.js');
    await expect(runProject({ projectId: 'proj_draftrun_bad', intake: INTAKE, store, workspacesRoot, frontendBackendExecutionMode: 'job_lifecycle', validationWorkspacesRoot, completionTarget: 'publish' as never })).rejects.toThrow();
    expect(await store.projects.countDocuments({ _id: 'proj_draftrun_bad' })).toBe(0);
  });
});

describe('release-targeted runs are unchanged', () => {
  it.each([['omitted', undefined], ['explicit release', 'release']] as const)('%s: seeks release and publishes, with no draft and the historical intent hash', async (_label, completionTarget) => {
    const projectId = `proj_draftrun_release_${completionTarget ?? 'omitted'}`;
    const result = await run(projectId, completionTarget ? { completionTarget } : {});

    expect(result.outcome).toBe('released');
    expect(result).not.toHaveProperty('draft');
    const [b0] = await chain(projectId);
    expect(b0).not.toHaveProperty('completionTarget');
    expect(b0!.runIntentHash).toBe(contentHash({ projectId, profile }));
    expect(calls.approve).toBe(1);
    expect(await count(projectId, 'release-authorization')).toBe(1);
    expect(await count(projectId, 'deployment-manifest')).toBe(1);
    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('released');
    expect(await store.canonicalDrafts.countDocuments({ projectId })).toBe(0);
  });

  it('human review stays a hard stop for a release: parked, no draft, no release', async () => {
    const projectId = 'proj_draftrun_human';
    const result = await run(projectId, { autonomyMode: 'human_in_the_loop' });
    expect(result.outcome).toBe('blocked');
    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('awaiting_human_review');
    expect(await store.canonicalDrafts.countDocuments({ projectId })).toBe(0);
    expect(await store.releasePublications.countDocuments({ projectId })).toBe(0);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, activeLineage: true })).toBe(1);
  });
});

describe('recovery reads the durable completion target', () => {
  it('a crash after final promotion recovers as a draft: re-evaluated, concluded, never released — and cannot be continued as a release', async () => {
    const projectId = 'proj_draftrun_crash';
    captureFailures = new Set([1]);
    await expect(run(projectId, { completionTarget: 'draft' })).rejects.toThrow('process died mid-evaluation');
    const [b0] = await chain(projectId);
    expect(b0).toMatchObject({ status: 'promoted', completionTarget: 'draft', activeLineage: true });
    expect(await store.canonicalDrafts.countDocuments({ projectId })).toBe(0);

    // The same project asked to release instead is a different intent, and is refused.
    await expect(run(projectId)).rejects.toBeInstanceOf(ActiveContinuationIntentConflict);

    const recovered = await run(projectId, { completionTarget: 'draft' });
    expect(recovered.outcome).toBe('draft');
    expect(recovered.draft).toMatchObject({ canonicalBindingId: b0!._id });
    expect(calls.plan).toBe(1);
    expect(calls.build).toBe(1);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
    await expectNoRelease(projectId);
  });

  it('a draft-targeted lineage parked for human review is not drafted by recovery', async () => {
    const projectId = 'proj_draftrun_parked';
    captureFailures = new Set([1]);
    await expect(run(projectId, { completionTarget: 'draft' })).rejects.toThrow();
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'awaiting_human_review' } });

    await expect(run(projectId, { completionTarget: 'draft' })).rejects.toBeInstanceOf(ActiveContinuationAwaitingHumanReview);
    expect(await store.canonicalDrafts.countDocuments({ projectId })).toBe(0);
    await expectNoRelease(projectId);
  });

  it('a malformed concluded draft fails closed on the next run', async () => {
    const projectId = 'proj_draftrun_corrupt';
    await run(projectId, { completionTarget: 'draft' });
    await store.canonicalDrafts.updateMany({ projectId }, { $unset: { current: '' } });
    await expect(run(projectId, { completionTarget: 'draft' })).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
  });

  it('a resumed prepared root must record the same target the request asks for', async () => {
    const projectId = 'proj_draftrun_resume';
    captureFailures = new Set([1]);
    await expect(run(projectId, { completionTarget: 'draft' })).rejects.toThrow();
    // Force the root back to prepared, as a crash before promotion leaves it, and ask for a release.
    await store.frontendBackendBuildBindings.updateOne({ projectId }, { $set: { status: 'prepared', promotionId: null, promotionCommitSha: null } });
    await expect(run(projectId)).rejects.toBeInstanceOf(FrontendBackendBuildBindingConflict);
  });
});
