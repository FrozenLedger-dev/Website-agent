/**
 * Semantic edits applied through the normal build lifecycle, end to end,
 * against a real Mongo replica set and a real canonical Git workspace.
 *
 * Real: canonical draft authority (conclusion, handoff, supersession), the
 * semantic patch engine and model persistence, the durable intent, the exact
 * source snapshot, the semantic-edit job spec and origin, `JobEngine`/`JobRunner`,
 * the production handler, isolated 5g-1 validation with the real site-model gate,
 * 5g-2 acceptance, the 5h promotion fence, receipt and exact-replacement
 * promotion, the typed successor binding, fresh evaluation and screenshot
 * persistence, Phase 5q and `runProject`'s refusals. Faked: the model skills,
 * the compiler (a faithful export of the page files a build wrote), the gates
 * and the browser capture.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import {
  EditableSiteModel,
  JobOrigin,
  ScreenshotSet,
  SemanticEditSource,
  VisualQualityReview,
  type ArtifactRef,
  type SitePlan,
} from '@statxai/contracts';
import { StateStore, createBudget, type CanonicalDraftDocument, type FrontendBackendBuildBindingDocument } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace, contentHash } from '@statxai/workspace';
import { exportFromPageFiles, pageFilesForModel } from './support/site-model-export.js';
import {
  computeRunIntentHash,
  deriveLineageTipFromRoot,
  ensureSpecificationCommitted,
  finalizeBindingPromoted,
  prepareFrontendBackendBuildBinding,
  rehydrateSpecificationFiles,
} from '../src/run-binding/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import { createFrontendBackendLifecycleCoordinator } from '../src/job-lifecycle/frontend-backend.js';
import { JobEngine } from '@statxai/job-engine';
import { ModelRuntime } from '@statxai/agents';
import { validateIntake } from '../src/phases/discover.js';
import { evaluateSite } from '../src/phases/evaluate.js';
import { createRunProgress, snapshotProgress, type RunContext } from '../src/run-context.js';
import { modelFromPlan } from '../src/site-model/materialize.js';
import { recordEditableSiteModel } from '../src/site-model/persist.js';
import {
  CanonicalDraftAuthorityCorrupt,
  claimCanonicalDraft,
  concludeCanonicalDraft,
  loadCurrentCanonicalDraft,
  resolveCanonicalDraftAuthority,
} from '../src/canonical-draft/authority.js';
import {
  ActiveContinuationConcludedDraft,
  ActiveContinuationSemanticEditOwned,
  resolvePostPromotionRecovery,
} from '../src/run-recovery/frontend-backend.js';
import {
  SEMANTIC_EDIT_SOURCE_ARTIFACT,
  SemanticEditAuthorityCorrupt,
  SemanticEditRefused,
  applySemanticEdit,
  resumeSemanticEdit,
  semanticEditIntentId,
  type ApplySemanticEditInput,
} from '../src/semantic-edit/apply.js';

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

const assessment = (overallScore: number) => ({
  overallScore,
  scores: { composition: overallScore, typography: overallScore, spacingRhythm: overallScore, hierarchy: overallScore, brandDistinctiveness: overallScore, assetQuality: overallScore, conversionClarity: overallScore, mobileQuality: overallScore },
  summary: `overall ${overallScore}`,
  routeReviews: [{ route: '/', viewports: ['desktop', 'mobile'], score: overallScore, summary: 's' }],
  strengths: ['Clear phone'],
  issues: [{ id: 'VQ-001', route: '/', viewports: ['mobile'], dimension: 'mobileQuality', severity: 'major', problem: 'Stacked.', direction: 'Recompose.' }],
  antiPatterns: [],
  refinementPriorities: [{ rank: 1, dimension: 'composition', route: '/', direction: 'Break the hero.' }],
});

type EditBehaviour = (n: number, input: Agents.SemanticEditInput) => { files: { path: string; contents: string }[] };
let editBehaviour: EditBehaviour | null;
let editFailures: Set<number>;
let captureFailures: Set<number>;
const calls = { edit: [] as Agents.SemanticEditInput[], capture: 0, reviewVisual: 0, refine: 0, approve: 0, adjudicate: 0, build: 0 };

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    buildSite: vi.fn(async (_r: unknown, _p: unknown, _plan: SitePlan, options: { siteModel: EditableSiteModel }) => {
      calls.build += 1;
      return { value: { files: pageFilesForModel(options.siteModel, '<p>B0</p>'), notes: '' }, model: 'terra', ...usage };
    }),
    routeBuild: vi.fn(async () => ({ value: { action: 'one_shot', reason: 'small', confidence: 0.9, workstreams: null }, model: 'sol', ...usage })),
    reviewSite: vi.fn(async () => ({ value: { decision: 'accept', qualityScore: 91, blocking: false, issues: [], summary: 's' }, model: 'terra', ...usage })),
    // A low score with a major issue: a run would refine this — a semantic edit must not.
    reviewVisualQuality: vi.fn(async () => {
      calls.reviewVisual += 1;
      return { value: assessment(55), model: 'terra-vision', invocationId: `vr-${calls.reviewVisual}`, skill: 'terra-review', tier: 'terra', ...usage };
    }),
    editSiteSemantically: vi.fn(async (_r: unknown, input: Agents.SemanticEditInput) => {
      calls.edit.push(input);
      const n = calls.edit.length;
      if (editFailures.has(n)) throw new Error('the model provider failed');
      const value = editBehaviour ? editBehaviour(n, input) : { files: pageFilesForModel(input.model, `<p>edited ${n}</p>`) };
      return { value: { ...value, notes: 'edited' }, model: 'terra', invocationId: `edit-${n}`, skill: 'terra-edit', tier: 'terra', ...usage };
    }),
    refineSiteVisually: vi.fn(async () => {
      calls.refine += 1;
      throw new Error('no visual refinement may run');
    }),
    recommendApproval: vi.fn(async () => {
      calls.approve += 1;
      throw new Error('no release judgement may run');
    }),
    adjudicate: vi.fn(async () => {
      calls.adjudicate += 1;
      throw new Error('no adjudication may run');
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

const deployed = { calls: 0 };

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async () => ({ ok: true, durationMs: 5, output: '', outDir: '/out' })),
    readBuiltFiles: vi.fn(async (siteRoot: string) => exportFromPageFiles(siteRoot)),
    readExportFiles: vi.fn(async () => []),
    readSourceFiles: vi.fn(async () => [{ path: 'app/page.tsx', contents: 'x' }]),
    deploymentConfigured: vi.fn(() => false),
    deploySite: vi.fn(async () => {
      deployed.calls += 1;
      throw new Error('no deployment may run');
    }),
    captureInBrowser: vi.fn(async (options: Workspace.BrowserRenderOptions) => {
      calls.capture += 1;
      if (captureFailures.has(calls.capture)) throw new Error('process died mid-evaluation');
      const subject = { ...options.subject, exportDigest: String(calls.capture).padStart(64, 'e') };
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
  return { ...actual, runGates: vi.fn(() => ({ passed: true, findings: [], gatesRun: ['claims'] })) };
});

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

let store: StateStore;
let registry: ArtifactRegistry;
let workspacesRoot: string;
let validationWorkspacesRoot: string;
let counter = 0;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-edit-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-edit-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  editBehaviour = null;
  editFailures = new Set();
  captureFailures = new Set();
  calls.edit = [];
  calls.capture = 0;
  calls.reviewVisual = 0;
  calls.refine = 0;
  calls.approve = 0;
  calls.adjudicate = 0;
  calls.build = 0;
  deployed.calls = 0;
  for (const c of [store.jobs, store.auditLog, store.artifacts, store.projects, store.budgets, store.defectBudgets, store.promotions, store.frontendBackendBuildBindings, store.releasePublications, store.visualRefinementIntents, store.blobs, store.canonicalDrafts, store.semanticEditIntents]) {
    await (c as { deleteMany(f: object): Promise<unknown> }).deleteMany({});
  }
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const profile = (() => {
  const validated = validateIntake(INTAKE);
  if (!validated.ok) throw new Error('fixture intake invalid');
  return validated.profile;
})();

const deps = () => ({ store, workspacesRoot, validationWorkspacesRoot });

function contextFor(projectId: string, workspace: ProjectWorkspace): RunContext {
  const progress = createRunProgress();
  progress.plan = PLAN;
  return {
    deps: { store, registry, workspace, model: new ModelRuntime(), say: () => {} },
    facts: { projectId, profile, autonomyMode: 'full_autonomous', budgetLimits: {} as never },
    progress: snapshotProgress(progress),
  };
}

interface Draft {
  readonly projectId: string;
  readonly ws: ProjectWorkspace;
  readonly b0: FrontendBackendBuildBindingDocument;
  readonly m0: ArtifactRef;
  readonly model0: EditableSiteModel;
  readonly d0: CanonicalDraftDocument;
  readonly b0ScreenshotSet: ArtifactRef;
}

/** B0 built, validated, accepted and promoted through the real lifecycle, evaluated, and concluded as the available draft D0. */
async function draftProject(options: { conclude?: boolean } = {}): Promise<Draft> {
  const projectId = `proj_edit_${(counter += 1)}`;
  const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
  await store.projects.insertOne({ _id: projectId, state: 'building', autonomyMode: 'full_autonomous', reviewCycle: 0, createdAt: new Date(), updatedAt: new Date() });
  await createBudget(store, projectId);
  const businessProfileRef = await registry.put(projectId, 'business-profile', profile);
  const sitePlanRef = await registry.put(projectId, 'site-plan', PLAN);
  const model = await recordEditableSiteModel(registry, projectId, modelFromPlan({ projectId, sitePlanRef, plan: PLAN }));
  const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef, editableSiteModelRef: model.ref });
  const binding = await prepareFrontendBackendBuildBinding(store, { projectId, runIntentHash: computeRunIntentHash({ projectId, profile }), businessProfileRef, sitePlanRef, jobSpec: spec, specificationBaseCommit: await ws.currentCommit() });
  await rehydrateSpecificationFiles(ws, profile, PLAN);
  await ensureSpecificationCommitted(store, ws, binding, PLAN);
  const coordinator = createFrontendBackendLifecycleCoordinator({ store, registry, engine: new JobEngine(store), model: new ModelRuntime(), workerIdentity: { workerId: `fixture:${projectId}`, tier: 'terra' }, workspacesRoot, validationWorkspacesRoot });
  const built = await coordinator.run(spec);
  if (built.outcome !== 'promoted') throw new Error(`fixture build did not promote: ${built.outcome}`);
  await finalizeBindingPromoted(store, binding._id, { promotionId: built.promotionId, promotionCommitSha: built.commitSha });
  const b0 = (await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))!;
  const evaluation = await evaluateSite(contextFor(projectId, ws), { sitePlan: sitePlanRef, editableSiteModel: model.ref, authority: { mode: 'job_lifecycle', buildBindingId: b0._id, promotionId: b0.promotionId, promotionCommitSha: b0.promotionCommitSha } });
  if (evaluation.kind !== 'evaluated' || !evaluation.screenshotSet) throw new Error('fixture evaluation failed');
  const draft = options.conclude === false ? null : (await concludeCanonicalDraft({ store, workspace: ws, projectId, canonicalBindingId: b0._id, promotion: { promotionId: b0.promotionId, promotionCommitSha: b0.promotionCommitSha } })).draft;
  return { projectId, ws, b0, m0: model.ref, model0: model.model, d0: draft!, b0ScreenshotSet: evaluation.screenshotSet };
}

const headingOf = (model: EditableSiteModel, route: string) => model.pages.find((p) => p.route === route)!.sections[0]!.fields.find((f) => f.key === 'heading')!;

const headingPatch = (model: EditableSiteModel, ref: ArtifactRef, route: string, value: string) => {
  const field = headingOf(model, route);
  return { baseModel: ref, operation: { op: 'set_field_value', fieldId: field.fieldId, expected: field.value, value } };
};

const editInput = (d: Draft, over: Partial<ApplySemanticEditInput> = {}): ApplySemanticEditInput => ({
  ...deps(),
  projectId: d.projectId,
  expectedDraftId: d.d0._id,
  expectedCanonicalBindingId: d.b0._id,
  baseEditableSiteModel: d.m0,
  patch: headingPatch(d.model0, d.m0, '/', 'Wardrobes made in our workshop'),
  ...over,
});

const modelAt = async (projectId: string, ref: ArtifactRef) => EditableSiteModel.parse(await registry.resolve(projectId, ref));
const count = (projectId: string, name: string) => store.artifacts.countDocuments({ projectId, name });

/** Nothing about an edit was written. */
async function expectNothingWritten(d: Draft, before: { models: number; state: string | undefined }) {
  expect(await store.semanticEditIntents.countDocuments({ projectId: d.projectId })).toBe(0);
  expect(await count(d.projectId, 'editable-site-model')).toBe(before.models);
  expect(await count(d.projectId, SEMANTIC_EDIT_SOURCE_ARTIFACT)).toBe(0);
  expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId })).toBe(1);
  expect((await store.projects.findOne({ _id: d.projectId }))?.state).toBe(before.state);
  expect(calls.edit).toEqual([]);
}

const snapshot = async (d: Draft) => ({ models: await count(d.projectId, 'editable-site-model'), state: (await store.projects.findOne({ _id: d.projectId }))?.state });

// ---------------------------------------------------------------------------
// The whole edit
// ---------------------------------------------------------------------------

describe('one semantic edit, from draft to draft', () => {
  it('D0/B0/M0 + P → claim, M1, source, terra-edit, validation, promotion, B1, fresh evaluation, D1 — and nothing else', async () => {
    const d = await draftProject();
    const m0Before = await store.artifacts.findOne({ projectId: d.projectId, name: 'editable-site-model', version: d.m0.version });
    const input = editInput(d, { requestedBy: { customerUserId: `cu_${'1'.repeat(32)}` } });

    const result = await applySemanticEdit(input);

    // --- The intent: deterministic, complete, audit-only actor, no secrets.
    const intentId = semanticEditIntentId({ projectId: d.projectId, sourceDraftId: d.d0._id, predecessorBindingId: d.b0._id, baseEditableSiteModel: d.m0, patchDigest: contentHash(input.patch) });
    expect(result).toMatchObject({ intentId, status: 'completed', sourceDraftId: d.d0._id, baseEditableSiteModel: d.m0, lifecycleOutcome: null, evaluationUnavailable: null, replayed: false });
    const intent = (await store.semanticEditIntents.findOne({ _id: intentId }))!;
    expect(intent).toMatchObject({ status: 'completed', predecessorBindingId: d.b0._id, lineageRootBindingId: d.b0._id, requestedBy: { customerUserId: `cu_${'1'.repeat(32)}` }, resultDraftId: result.resultDraftId });
    expect(JSON.stringify(intent)).not.toMatch(/session|cookie|token|bearer|password|email/i);

    // --- M1: exactly P applied to M0, M0 untouched.
    const m1 = await modelAt(d.projectId, result.editableSiteModel);
    expect(result.editableSiteModel.version).toBe(d.m0.version + 1);
    expect(headingOf(m1, '/').value).toBe('Wardrobes made in our workshop');
    expect(headingOf(m1, '/services').value).toBe(headingOf(d.model0, '/services').value);
    expect(m1.provenance).toEqual({ kind: 'semantic_patch', base: d.m0, operation: 'set_field_value', target: headingOf(d.model0, '/').fieldId });
    expect(await store.artifacts.findOne({ projectId: d.projectId, name: 'editable-site-model', version: d.m0.version })).toEqual(m0Before);

    // --- B1: the semantic-edit successor of exactly B0, same lineage, promoted by the lifecycle.
    const b1 = (await store.frontendBackendBuildBindings.findOne({ _id: result.successorBindingId }))!;
    expect(b1).toMatchObject({
      status: 'promoted',
      predecessorBindingId: d.b0._id,
      lineageRootBindingId: d.b0._id,
      successorProvenance: { kind: 'semantic_edit', baseEditableSiteModel: d.m0, editableSiteModel: result.editableSiteModel },
      promotionId: result.promotion!.promotionId,
      promotionCommitSha: result.promotion!.promotionCommitSha,
    });
    expect(b1).not.toHaveProperty('replanDecision');
    expect(b1).not.toHaveProperty('activeLineage');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId, predecessorBindingId: { $exists: false } })).toBe(1);
    const job = (await store.jobs.findOne({ _id: b1.jobId }))!;
    expect(JobOrigin.parse(job.origin)).toEqual({ kind: 'semantic_edit', intentId });
    expect(job.state).toBe('accepted');
    expect(job.promotionFence?.promotionId).toBe(b1.promotionId);
    expect(job.spec.inputs).toMatchObject({ editableSiteModel: result.editableSiteModel, baseEditableSiteModel: d.m0, semanticEditSource: intent.source });
    expect(job._id).not.toBe(d.b0.jobId);
    const receipt = (await store.promotions.findOne({ _id: b1.promotionId! }))!;
    expect(receipt).toMatchObject({ status: 'committed', jobId: b1.jobId, commitSha: b1.promotionCommitSha });

    // --- Terra saw exactly M0, M1, P and the exact B0 source, through its own skill.
    expect(calls.edit).toHaveLength(1);
    const seen = calls.edit[0]!;
    expect(seen.baseModel).toEqual(d.model0);
    expect(seen.model).toEqual(m1);
    expect(seen.patch).toEqual(input.patch);
    expect(seen.predecessor).toEqual({ bindingId: d.b0._id, sourceCommit: intent.sourceCommit });
    expect(seen.source.filter((f) => f.path.endsWith('page.tsx')).map((f) => [f.path, f.contents.includes('<p>B0</p>')])).toEqual([['app/page.tsx', true], ['app/services/page.tsx', true]]);
    const source = SemanticEditSource.parse(await registry.resolve(d.projectId, intent.source));
    expect(source).toMatchObject({ intentId, sourceDraftId: d.d0._id, predecessorBindingId: d.b0._id, promotionId: d.b0.promotionId, promotionCommitSha: d.b0.promotionCommitSha, sourceCommit: intent.sourceCommit });
    expect(source.filesDigest).toBe(contentHash(source.files));
    expect(source.files).toEqual(seen.source);

    // --- Fresh evaluation of exactly B1: new test report, render, screenshots and review.
    expect(calls.capture).toBe(2);
    const sets = await store.artifacts.find({ projectId: d.projectId, name: 'screenshot-set' }).sort({ version: 1 }).toArray();
    expect(sets).toHaveLength(2);
    const b1Set = ScreenshotSet.parse(sets[1]!.data);
    expect(b1Set.subject.authority).toMatchObject({ mode: 'job_lifecycle', buildBindingId: b1._id, promotionId: b1.promotionId, promotionCommitSha: b1.promotionCommitSha });
    expect(intent.evaluation!.screenshotSet).toEqual({ name: 'screenshot-set', version: sets[1]!.version, contentHash: sets[1]!.contentHash });
    expect(intent.evaluation!.screenshotSet).not.toEqual(d.b0ScreenshotSet);
    const review = VisualQualityReview.parse(await registry.resolve(d.projectId, intent.evaluation!.visualQualityReview!));
    expect(review.screenshotSet).toEqual(intent.evaluation!.screenshotSet);
    expect(intent.evaluation!.testReport.version).toBe(2);

    // --- D1 current and available, D0 superseded as history, the project a draft again.
    const d1 = (await store.canonicalDrafts.findOne({ _id: result.resultDraftId! }))!;
    expect(d1).toMatchObject({ current: true, status: 'available', canonicalBindingId: b1._id, lineageRootBindingId: d.b0._id, promotionId: b1.promotionId });
    const d0 = (await store.canonicalDrafts.findOne({ _id: d.d0._id }))!;
    expect(d0).toMatchObject({ status: 'claimed', claim: { kind: 'semantic_edit', operationId: intentId }, supersededByDraftId: d1._id, canonicalBindingId: d.b0._id });
    expect(d0).not.toHaveProperty('current');
    expect((await store.projects.findOne({ _id: d.projectId }))?.state).toBe('draft');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId, activeLineage: true })).toBe(0);
    expect((await loadCurrentCanonicalDraft(store, d.projectId))?._id).toBe(d1._id);
    expect((await deriveLineageTipFromRoot(store, (await store.frontendBackendBuildBindings.findOne({ _id: d.b0._id }))!))._id).toBe(b1._id);

    // --- Draft only: no refinement, adjudication, approval, release or deployment.
    expect(calls.refine).toBe(0);
    expect(calls.adjudicate).toBe(0);
    expect(calls.approve).toBe(0);
    expect(deployed.calls).toBe(0);
    expect(await store.releasePublications.countDocuments({ projectId: d.projectId })).toBe(0);
    expect(await count(d.projectId, 'release-authorization')).toBe(0);
    expect(await count(d.projectId, 'deployment-manifest')).toBe(0);
    expect(await store.visualRefinementIntents.countDocuments({ projectId: d.projectId })).toBe(0);
  });

  it('an exact replay of a completed edit returns it complete — no Terra, no model, no successor, no evaluation', async () => {
    const d = await draftProject();
    const first = await applySemanticEdit(editInput(d));
    const before = { models: await count(d.projectId, 'editable-site-model'), bindings: await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId }), captures: calls.capture, edits: calls.edit.length, drafts: await store.canonicalDrafts.countDocuments({ projectId: d.projectId }) };

    const again = await applySemanticEdit(editInput(d));
    expect(again).toEqual({ ...first, replayed: true });
    expect(await count(d.projectId, 'editable-site-model')).toBe(before.models);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId })).toBe(before.bindings);
    expect(await store.canonicalDrafts.countDocuments({ projectId: d.projectId })).toBe(before.drafts);
    expect(await store.semanticEditIntents.countDocuments({ projectId: d.projectId })).toBe(1);
    expect(calls.capture).toBe(before.captures);
    expect(calls.edit).toHaveLength(before.edits);
    // D0 is not made available or current again.
    expect(await store.canonicalDrafts.findOne({ _id: d.d0._id })).toMatchObject({ status: 'claimed', supersededByDraftId: first.resultDraftId });
  });

  it('sequential edits: D1/M1 claimed for E1 produces M2, B2 (M1→M2) and D2 — each exactly one step', async () => {
    const d = await draftProject();
    const e0 = await applySemanticEdit(editInput(d));
    const m1 = await modelAt(d.projectId, e0.editableSiteModel);

    const e1 = await applySemanticEdit({
      ...deps(),
      projectId: d.projectId,
      expectedDraftId: e0.resultDraftId!,
      expectedCanonicalBindingId: e0.successorBindingId,
      baseEditableSiteModel: e0.editableSiteModel,
      patch: headingPatch(m1, e0.editableSiteModel, '/services', 'Services built to last'),
    });

    expect(e1.status).toBe('completed');
    expect(e1.intentId).not.toBe(e0.intentId);
    const m2 = await modelAt(d.projectId, e1.editableSiteModel);
    expect(headingOf(m2, '/').value).toBe('Wardrobes made in our workshop');
    expect(headingOf(m2, '/services').value).toBe('Services built to last');
    const b2 = (await store.frontendBackendBuildBindings.findOne({ _id: e1.successorBindingId }))!;
    expect(b2).toMatchObject({ predecessorBindingId: e0.successorBindingId, lineageRootBindingId: d.b0._id, successorProvenance: { kind: 'semantic_edit', baseEditableSiteModel: e0.editableSiteModel, editableSiteModel: e1.editableSiteModel } });
    const b1 = (await store.frontendBackendBuildBindings.findOne({ _id: e0.successorBindingId }))!;
    expect(new Set([d.b0.jobId, b1.jobId, b2.jobId]).size).toBe(3);
    expect((await deriveLineageTipFromRoot(store, (await store.frontendBackendBuildBindings.findOne({ _id: d.b0._id }))!))._id).toBe(b2._id);
    expect((await loadCurrentCanonicalDraft(store, d.projectId))?._id).toBe(e1.resultDraftId);
    expect(await store.canonicalDrafts.findOne({ _id: e0.resultDraftId! })).toMatchObject({ supersededByDraftId: e1.resultDraftId, claim: { kind: 'semantic_edit', operationId: e1.intentId } });
    expect(calls.edit[1]!.baseModel).toEqual(m1);
    expect(calls.edit[1]!.source.find((f) => f.path === 'app/page.tsx')!.contents).toContain('<p>edited 1</p>');
  });
});

// ---------------------------------------------------------------------------
// Refusals before anything is written
// ---------------------------------------------------------------------------

describe('an edit starts only from the exact available draft, model and patch', () => {
  const refusal = (reason: string, patchRejection?: string) => ({ name: 'SemanticEditRefused', reason, ...(patchRejection ? { patchRejection } : {}) });

  it('refuses a stale draft, a stale build and a stale base — before any claim, model, source or Terra', async () => {
    const d = await draftProject();
    const before = await snapshot(d);
    await expect(applySemanticEdit(editInput(d, { expectedDraftId: 'canonical-draft-old' }))).rejects.toMatchObject(refusal('stale_draft'));
    await expect(applySemanticEdit(editInput(d, { expectedCanonicalBindingId: 'frontend-backend-build-old' }))).rejects.toMatchObject(refusal('stale_tip'));

    // Another model version of the same project, not the one B0 carries.
    const other = await recordEditableSiteModel(registry, d.projectId, { ...d.model0, provenance: d.model0.provenance });
    const stale = { ...other.ref };
    await expect(applySemanticEdit(editInput(d, { baseEditableSiteModel: stale, patch: headingPatch(d.model0, stale, '/', 'x') }))).rejects.toMatchObject(refusal('stale_base'));
    await expect(applySemanticEdit(editInput(d, { baseEditableSiteModel: { ...d.m0, contentHash: 'f'.repeat(64) } }))).rejects.toMatchObject(refusal('stale_base'));
    await expectNothingWritten(d, { ...before, models: before.models + 1 });
    expect((await store.canonicalDrafts.findOne({ _id: d.d0._id }))?.status).toBe('available');
  });

  it.each([
    ['an unknown target', (d: Draft) => ({ baseModel: d.m0, operation: { op: 'set_field_value', fieldId: 'fld_ffffffffffffffff', expected: 'H', value: 'x' } }), 'unknown_target'],
    ['a wrong target type', (d: Draft) => ({ baseModel: d.m0, operation: { op: 'set_field_value', fieldId: d.model0.pages[0]!.sections[0]!.sectionId, expected: 'H', value: 'x' } }), 'wrong_target_type'],
    ['a malformed patch', (d: Draft) => ({ baseModel: d.m0, operation: { op: 'rewrite_everything' } }), 'invalid_patch'],
    ['a stale expectation', (d: Draft) => ({ baseModel: d.m0, operation: { op: 'set_field_value', fieldId: headingOf(d.model0, '/').fieldId, expected: 'not what is there', value: 'x' } }), 'stale_expectation'],
    ['a patch written against another base', (d: Draft) => ({ baseModel: { ...d.m0, version: d.m0.version + 7 }, operation: { op: 'set_field_value', fieldId: headingOf(d.model0, '/').fieldId, expected: 'H', value: 'x' } }), 'base_mismatch'],
  ])('refuses %s before anything is written', async (_label, patch, code) => {
    const d = await draftProject();
    const before = await snapshot(d);
    await expect(applySemanticEdit(editInput(d, { patch: patch(d) }))).rejects.toMatchObject(refusal('invalid_patch', code));
    await expectNothingWritten(d, before);
  });

  it('refuses an active run, a parked, released or blocked project, a release-owned draft, and a draft held by another operation', async () => {
    const active = await draftProject({ conclude: false });
    const input = (d: Draft) => editInput({ ...d, d0: { _id: 'canonical-draft-none' } as CanonicalDraftDocument });
    await expect(applySemanticEdit(input(active))).rejects.toMatchObject(refusal('no_current_draft'));

    for (const state of ['awaiting_human_review', 'released', 'blocked'] as const) {
      await store.projects.updateOne({ _id: active.projectId }, { $set: { state } });
      await expect(applySemanticEdit(input(active))).rejects.toMatchObject(refusal('no_current_draft'));
    }
    expect(await store.semanticEditIntents.countDocuments({})).toBe(0);

    const owned = await draftProject();
    await store.releasePublications.insertOne({ _id: `release-${owned.projectId}`, projectId: owned.projectId, active: true, status: 'prepared' } as never);
    await expect(applySemanticEdit(editInput(owned))).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);

    const held = await draftProject();
    await claimCanonicalDraft({ store, projectId: held.projectId, expectedDraftId: held.d0._id, expectedCanonicalBindingId: held.b0._id, claimant: { kind: 'release', operationId: 'release-op-1' } });
    await expect(applySemanticEdit(editInput(held))).rejects.toMatchObject(refusal('draft_claimed'));
    expect(await store.semanticEditIntents.countDocuments({})).toBe(0);
    expect(calls.edit).toEqual([]);
  });

  it('refuses uncommitted work, an unproven HEAD and oversize source — never truncated, never built over', async () => {
    const d = await draftProject();
    const before = await snapshot(d);

    await writeFile(join(d.ws.siteRoot, 'app/page.tsx'), 'UNCOMMITTED', 'utf8');
    await expect(applySemanticEdit(editInput(d))).rejects.toMatchObject(refusal('source_unavailable'));
    execFileSync('git', ['checkout', '--', 'app/page.tsx'], { cwd: d.ws.siteRoot });

    // HEAD on a commit that carries model source but does not descend from the draft build's promotion.
    const head = (await d.ws.currentCommit())!;
    execFileSync('git', ['checkout', '-q', '--detach', `${d.b0.promotionCommitSha}~1`], { cwd: d.ws.root });
    for (const file of pageFilesForModel(d.model0, '<p>DIVERGED</p>')) {
      await mkdir(join(d.ws.siteRoot, file.path, '..'), { recursive: true });
      await writeFile(join(d.ws.siteRoot, file.path), file.contents, 'utf8');
    }
    await d.ws.commit('an unrelated line of history');
    await expect(applySemanticEdit(editInput(d))).rejects.toMatchObject(refusal('source_unavailable', undefined));
    await expect(applySemanticEdit(editInput(d))).rejects.toThrow(/does not descend from promotion/);
    execFileSync('git', ['checkout', '-q', '-f', head], { cwd: d.ws.root });

    await mkdir(join(d.ws.siteRoot, 'components', 'site'), { recursive: true });
    for (let i = 0; i < 90; i += 1) await writeFile(join(d.ws.siteRoot, 'components', 'site', `part-${i}.tsx`), `export const P${i} = ${i};`, 'utf8');
    await d.ws.commit('Luna: many parts');
    await expect(applySemanticEdit(editInput(d))).rejects.toMatchObject(refusal('source_too_large'));
    await expectNothingWritten(d, before);
    expect((await store.canonicalDrafts.findOne({ _id: d.d0._id }))?.status).toBe('available');
  });

  it('reads the exact canonical commit — a Luna repair committed after promotion is the source, uncommitted edits never are', async () => {
    const d = await draftProject();
    const home = pageFilesForModel(d.model0, '<p>REPAIRED</p>').find((f) => f.path === 'app/page.tsx')!;
    await writeFile(join(d.ws.siteRoot, home.path), home.contents, 'utf8');
    const repair = (await d.ws.commit('Luna: repair cycle 1'))!;

    const result = await applySemanticEdit(editInput(d));
    expect(result.status).toBe('completed');
    const intent = (await store.semanticEditIntents.findOne({ _id: result.intentId }))!;
    expect(intent.sourceCommit).toBe(repair);
    expect(calls.edit[0]!.source.find((f) => f.path === 'app/page.tsx')!.contents).toContain('<p>REPAIRED</p>');
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('two edits of one draft', () => {
  it('only one wins; the loser is a typed conflict and leaves no model, intent or successor', async () => {
    const d = await draftProject();
    const p1 = editInput(d);
    const p2 = editInput(d, { patch: headingPatch(d.model0, d.m0, '/', 'A different heading') });
    const models = await count(d.projectId, 'editable-site-model');

    const results = await Promise.allSettled([applySemanticEdit(p1), applySemanticEdit(p2)]);
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof applySemanticEdit>>> => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(SemanticEditRefused);
    expect(lost[0]!.reason).toMatchObject({ reason: 'draft_claimed' });
    expect(won[0]!.value.status).toBe('completed');

    expect(await store.semanticEditIntents.countDocuments({ projectId: d.projectId })).toBe(1);
    expect(await count(d.projectId, 'editable-site-model')).toBe(models + 1);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId, predecessorBindingId: d.b0._id })).toBe(1);
    expect(calls.edit).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('official validation proves M1', () => {
  it.each([
    ['a dropped section marker', (_n: number, input: Agents.SemanticEditInput) => ({ files: pageFilesForModel(input.model, '<p>x</p>', (html) => html.replace(/ data-statx-section-id="[^"]+"/, '')) })],
    ['unrelated modeled drift', (_n: number, input: Agents.SemanticEditInput) => {
      const drifted = structuredClone(input.model);
      headingOf(drifted, '/services').value = 'Quietly changed';
      return { files: pageFilesForModel(drifted, '<p>x</p>') };
    }],
    ['the requested change left unimplemented', (_n: number, input: Agents.SemanticEditInput) => ({ files: pageFilesForModel(input.baseModel, '<p>x</p>') })],
    ['an added route', (_n: number, input: Agents.SemanticEditInput) => ({ files: [...pageFilesForModel(input.model, '<p>x</p>'), { path: 'app/extra/page.tsx', contents: '<main>extra</main>' }] })],
  ] as const)('%s is not promoted: the edit stops durable, still owning its draft and job', async (_label, behaviour) => {
    const d = await draftProject();
    editBehaviour = behaviour;

    const result = await applySemanticEdit(editInput(d));
    expect(result).toMatchObject({ status: 'building', lifecycleOutcome: 'validation_failed', promotion: null, resultDraftId: null });
    const b1 = (await store.frontendBackendBuildBindings.findOne({ _id: result.successorBindingId }))!;
    expect(b1.status).toBe('prepared');
    expect(await store.promotions.countDocuments({ jobId: b1.jobId })).toBe(0);
    expect((await store.jobs.findOne({ _id: b1.jobId }))?.state).toBe('validating');
    // Not rolled back to available: the job and successor own continuation.
    const authority = await resolveCanonicalDraftAuthority(store, d.projectId);
    expect(authority).toMatchObject({ state: 'handed_off', draft: { _id: d.d0._id, claim: { operationId: result.intentId } } });
    expect((await store.projects.findOne({ _id: d.projectId }))?.state).toBe('building');
  });

  it('a forbidden source path never reaches the canonical tree', async () => {
    const d = await draftProject();
    editBehaviour = (_n, input) => ({ files: [...pageFilesForModel(input.model, '<p>x</p>'), { path: 'components/ui/button.tsx', contents: 'export const Button = 1;' }] });
    const head = await d.ws.currentCommit();

    await expect(applySemanticEdit(editInput(d))).rejects.toThrow();
    const intent = (await store.semanticEditIntents.findOne({ projectId: d.projectId }))!;
    expect(intent.status).toBe('building');
    expect(await store.promotions.countDocuments({ projectId: d.projectId })).toBe(1);
    const log = execFileSync('git', ['log', '--format=%s', `${head}..HEAD`], { cwd: d.ws.root, encoding: 'utf8' });
    expect(log).not.toMatch(/Promote/);
  });
});

// ---------------------------------------------------------------------------
// Crashes and recovery
// ---------------------------------------------------------------------------

describe('recovery from durable state', () => {
  it('a model failure before promotion leaves a prepared successor that an exact replay resumes on the same job', async () => {
    const d = await draftProject();
    editFailures = new Set([1]);

    const stopped = await applySemanticEdit(editInput(d));
    expect(stopped).toMatchObject({ status: 'building', lifecycleOutcome: 'retry_ready' });
    const b1 = (await store.frontendBackendBuildBindings.findOne({ _id: stopped.successorBindingId }))!;
    expect(b1.status).toBe('prepared');
    // A run may not resume or replace it; the edit owns it.
    const { runProject } = await import('../src/orchestrator.js');
    await expect(runProject({ projectId: d.projectId, intake: INTAKE, store, workspacesRoot, frontendBackendExecutionMode: 'job_lifecycle', validationWorkspacesRoot })).rejects.toBeInstanceOf(ActiveContinuationSemanticEditOwned);

    const models = await count(d.projectId, 'editable-site-model');
    const resumed = await applySemanticEdit(editInput(d));
    expect(resumed).toMatchObject({ intentId: stopped.intentId, status: 'completed', successorBindingId: stopped.successorBindingId, replayed: true });
    expect(calls.edit).toHaveLength(2);
    expect((await store.jobs.findOne({ _id: b1.jobId }))?.attempt).toBe(2);
    expect(await count(d.projectId, 'editable-site-model')).toBe(models);
    expect(await store.semanticEditIntents.countDocuments({ projectId: d.projectId })).toBe(1);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId })).toBe(2);
  });

  it('a crash after promotion: Phase 5q hands the edit its continuation, which evaluates exactly B1 and concludes D1 without Terra', async () => {
    const d = await draftProject();
    captureFailures = new Set([2]);

    await expect(applySemanticEdit(editInput(d))).rejects.toThrow('process died mid-evaluation');
    const intent = (await store.semanticEditIntents.findOne({ projectId: d.projectId }))!;
    expect(intent.status).toBe('promoted');
    const b1 = (await store.frontendBackendBuildBindings.findOne({ _id: intent.successorBindingId }))!;
    expect(b1.status).toBe('promoted');

    const recovery = await resolvePostPromotionRecovery({ store, registry, workspacesRoot, projectId: d.projectId, runIntentHash: b1.runIntentHash, completionTarget: 'release' }).catch((e: unknown) => e);
    expect(recovery).toBeInstanceOf(ActiveContinuationSemanticEditOwned);
    expect(recovery).toMatchObject({ draftId: d.d0._id, intentId: intent._id });

    const models = await count(d.projectId, 'editable-site-model');
    const resumed = await resumeSemanticEdit({ ...deps(), projectId: d.projectId });
    expect(resumed).toMatchObject({ intentId: intent._id, status: 'completed', successorBindingId: b1._id });
    expect(calls.edit).toHaveLength(1);
    expect(calls.capture).toBe(3);
    const done = (await store.semanticEditIntents.findOne({ _id: intent._id }))!;
    const set = ScreenshotSet.parse(await registry.resolve(d.projectId, done.evaluation!.screenshotSet!));
    expect(set.subject.authority).toMatchObject({ buildBindingId: b1._id });
    expect(await count(d.projectId, 'editable-site-model')).toBe(models);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId })).toBe(2);
    expect(await store.semanticEditIntents.countDocuments({ projectId: d.projectId })).toBe(1);
    expect((await loadCurrentCanonicalDraft(store, d.projectId))?._id).toBe(done.resultDraftId);
    expect(deployed.calls + calls.approve + calls.refine).toBe(0);

    // Completed: recovery reports a concluded draft, and nothing resumes.
    await expect(resolvePostPromotionRecovery({ store, registry, workspacesRoot, projectId: d.projectId, runIntentHash: b1.runIntentHash, completionTarget: 'release' })).rejects.toBeInstanceOf(ActiveContinuationConcludedDraft);
    expect(await resumeSemanticEdit({ ...deps(), projectId: d.projectId })).toBeNull();
  });

  it('a crash after evaluation, before conclusion: replay concludes D1 from the recorded evidence, without re-evaluating', async () => {
    const d = await draftProject();
    const real = store.canonicalDrafts;
    let failed = false;
    vi.spyOn(store, 'canonicalDrafts', 'get').mockReturnValue(
      new Proxy(real, {
        get(target, key, receiver) {
          if (key === 'insertOne' && !failed) {
            return async () => {
              failed = true;
              throw new Error('injected: died before conclusion committed');
            };
          }
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );

    await expect(applySemanticEdit(editInput(d))).rejects.toThrow('injected');
    vi.restoreAllMocks();
    const intent = (await store.semanticEditIntents.findOne({ projectId: d.projectId }))!;
    expect(intent.status).toBe('evaluated');
    expect((await store.canonicalDrafts.findOne({ _id: d.d0._id }))).toHaveProperty('current', true);

    const captures = calls.capture;
    const resumed = await applySemanticEdit(editInput(d));
    expect(resumed).toMatchObject({ status: 'completed', evaluation: intent.evaluation });
    expect(calls.capture).toBe(captures);
    expect(calls.edit).toHaveLength(1);
    expect(await store.canonicalDrafts.countDocuments({ projectId: d.projectId, current: true })).toBe(1);
  });

  it('a handed-off draft whose intent is missing fails closed', async () => {
    const d = await draftProject();
    captureFailures = new Set([2]);
    await expect(applySemanticEdit(editInput(d))).rejects.toThrow();
    await store.semanticEditIntents.deleteMany({ projectId: d.projectId });
    await expect(resumeSemanticEdit({ ...deps(), projectId: d.projectId })).rejects.toBeInstanceOf(SemanticEditAuthorityCorrupt);
  });
});
