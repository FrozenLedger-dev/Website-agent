/**
 * The semantic-edit worker, against a real Mongo replica set and a real canonical
 * Git workspace: durable submission that returns before any build, work
 * discovery and execution leases, exact expired-job reclamation, stale-worker
 * fencing, bounded retries and terminal dispositions, the crash matrix, and the
 * customer-safe status reader.
 *
 * Real: everything the semantic-edit lifecycle crosses (see the application
 * suite), the worker, execution leases and JobEngine. Faked: the model skills,
 * the compiler, the gates and the browser capture — as in the application suite.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir as mkdirp, rm as rmDir, writeFile as writeOut } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import type { ArtifactRef, EditableSiteModel, SitePlan } from '@statxai/contracts';
import { StateStore, createBudget, type CanonicalDraftDocument, type FrontendBackendBuildBindingDocument } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import { exportFromPageFiles, pageFilesForModel } from './support/site-model-export.js';
import {
  computeRunIntentHash,
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
  concludeCanonicalDraft,
  loadCurrentCanonicalDraft,
  resolveCanonicalDraftAuthority,
} from '../src/canonical-draft/authority.js';
import {
} from '../src/run-recovery/frontend-backend.js';
import {
  SemanticEditWorker,
  claimSemanticEditExecution,
  heartbeatSemanticEditExecution,
  readSemanticEditExecutionStatus,
  releaseSemanticEditExecution,
  resumeSemanticEditIntent,
} from '../src/index.js';
import {
  SEMANTIC_EDIT_SOURCE_ARTIFACT,
  submitSemanticEdit,
  applySemanticEdit,
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
/** While set, Terra waits on it — a build held mid-execution. */
let editGate: Promise<void> | null;
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
      if (editGate) await editGate;
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
      return { ok: true, durationMs: 5, output: '', outDir, exportDigest };
    }),
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
      // The renderer digests exactly the export it was handed, as the real one does.
      const subject = { ...options.subject, exportDigest: (await actual.readExportTree(options.exportDir)).exportDigest };
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
  editGate = null;
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
  if (!evaluation.siteExportSnapshot) throw new Error('fixture evaluation captured no export snapshot');
  const draft = options.conclude === false ? null : (await concludeCanonicalDraft({ store, registry, siteExportSnapshot: evaluation.siteExportSnapshot, workspace: ws, projectId, canonicalBindingId: b0._id, promotion: { promotionId: b0.promotionId, promotionCommitSha: b0.promotionCommitSha } })).draft;
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

const count = (projectId: string, name: string) => store.artifacts.countDocuments({ projectId, name });

const snapshot = async (d: Draft) => ({ models: await count(d.projectId, 'editable-site-model'), state: (await store.projects.findOne({ _id: d.projectId }))?.state });
// ---------------------------------------------------------------------------
// Worker rig
// ---------------------------------------------------------------------------

const workerFor = (owner: string, limits: Record<string, number> = {}, log?: (event: object) => void) =>
  new SemanticEditWorker({ ...deps(), owner, limits: { pollMs: 50, leaseMs: 5_000, heartbeatMs: 100, ...limits }, jobLeaseMs: 2_000, jobHeartbeatEveryMs: 200, ...(log ? { log } : {}) });

const intentOf = async (projectId: string) => (await store.semanticEditIntents.findOne({ projectId }))!;
const until = async (condition: () => boolean | Promise<boolean>, ms = 10_000) => {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const gate = () => {
  let open!: () => void;
  editGate = new Promise<void>((resolve) => (open = resolve));
  return () => {
    editGate = null;
    open();
  };
};

// ---------------------------------------------------------------------------

describe('durable submission', () => {
  it('submits an exact edit durably and returns before any build — replayable, and still exclusive', async () => {
    const d = await draftProject();
    const before = await snapshot(d);

    const submitted = await submitSemanticEdit(editInput(d));
    expect(submitted).toMatchObject({ status: 'building', sourceDraftId: d.d0._id, baseEditableSiteModel: d.m0, promotion: null, resultDraftId: null, replayed: false });
    expect(calls.edit).toEqual([]);
    expect(calls.capture).toBe(1);
    const intent = await intentOf(d.projectId);
    expect(await store.jobs.countDocuments({ _id: intent.jobId })).toBe(0);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId })).toBe(1);
    expect(intent).not.toHaveProperty('execution');
    expect(await count(d.projectId, 'editable-site-model')).toBe(before.models + 1);
    expect(await count(d.projectId, SEMANTIC_EDIT_SOURCE_ARTIFACT)).toBe(1);
    expect(await resolveCanonicalDraftAuthority(store, d.projectId)).toMatchObject({ state: 'handed_off', draft: { claim: { kind: 'semantic_edit', operationId: intent._id } } });
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intent._id)).toMatchObject({ state: 'queued', resultDraftId: null, failure: null });

    const again = await submitSemanticEdit(editInput(d));
    expect(again).toEqual({ ...submitted, replayed: true });
    expect(await count(d.projectId, 'editable-site-model')).toBe(before.models + 1);
    expect(await count(d.projectId, SEMANTIC_EDIT_SOURCE_ARTIFACT)).toBe(1);
    expect((await intentOf(d.projectId)).jobSpec).toEqual(intent.jobSpec);
    await expect(submitSemanticEdit(editInput(d, { patch: headingPatch(d.model0, d.m0, '/', 'A competing heading') }))).rejects.toMatchObject({ reason: 'draft_claimed' });
    expect(await store.semanticEditIntents.countDocuments({ projectId: d.projectId })).toBe(1);
  });

  it('a worker on a separate connection finishes a submitted edit from durable state alone', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));

    const elsewhere = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
    try {
      const worker = new SemanticEditWorker({ store: elsewhere, workspacesRoot, validationWorkspacesRoot, owner: 'elsewhere', limits: { pollMs: 50, leaseMs: 5_000, heartbeatMs: 100 } });
      expect(await worker.claimOne()).toBe(true);
      await worker.drain();
    } finally {
      await elsewhere.close();
    }
    const status = await readSemanticEditExecutionStatus(store, d.projectId, intentId);
    expect(status).toMatchObject({ state: 'completed' });
    expect((await loadCurrentCanonicalDraft(store, d.projectId))?._id).toBe(status!.resultDraftId);
    expect(calls.edit).toHaveLength(1);
    expect(await store.semanticEditIntents.findOne({ _id: intentId })).not.toHaveProperty('execution');
  });
});

describe('work discovery and execution leases', () => {
  it('one lease at a time; only its exact token renews it; an expired lease is replaced for the same edit, and the draft claim never moves', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    const t = Date.now();

    const a = (await claimSemanticEditExecution(store, { owner: 'a', leaseMs: 10_000, now: new Date(t) }))!;
    expect(a).toMatchObject({ intentId, projectId: d.projectId, status: 'building' });
    expect(await claimSemanticEditExecution(store, { owner: 'b', leaseMs: 10_000, now: new Date(t + 9_999) })).toBeNull();
    expect(await heartbeatSemanticEditExecution(store, a, 10_000, new Date(t + 5_000))).toBe(true);
    expect(await heartbeatSemanticEditExecution(store, { intentId, token: 'not-the-token' }, 10_000, new Date(t + 5_000))).toBe(false);
    expect(await claimSemanticEditExecution(store, { owner: 'b', leaseMs: 10_000, now: new Date(t + 14_999) })).toBeNull();

    const b = (await claimSemanticEditExecution(store, { owner: 'b', leaseMs: 10_000, now: new Date(t + 15_000) }))!;
    expect(b).toMatchObject({ intentId, jobId: a.jobId });
    expect(b.token).not.toBe(a.token);
    expect(await heartbeatSemanticEditExecution(store, a, 10_000, new Date(t + 15_001))).toBe(false);
    expect(await releaseSemanticEditExecution(store, a)).toBe(false);
    expect(await resolveCanonicalDraftAuthority(store, d.projectId)).toMatchObject({ state: 'handed_off', draft: { claim: { operationId: intentId } } });
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intentId, new Date(t + 15_001))).toMatchObject({ state: 'running' });
    expect(JSON.stringify(await readSemanticEditExecutionStatus(store, d.projectId, intentId, new Date(t + 15_001)))).not.toMatch(new RegExp(`${b.token}|execution|jobId|token`));
    expect(await releaseSemanticEditExecution(store, b)).toBe(true);
  });

  it('completed and dispositioned edits are not work; nothing else in the store is', async () => {
    const done = await draftProject();
    const completed = await applySemanticEdit(editInput(done));
    expect(await claimSemanticEditExecution(store, { owner: 'w', leaseMs: 5_000, intentId: completed.intentId })).toBeNull();

    const stuck = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(stuck));
    await store.semanticEditIntents.updateOne({ _id: intentId }, { $set: { disposition: { kind: 'failed', reason: 'validation_failed', at: new Date() } } });
    expect(await claimSemanticEditExecution(store, { owner: 'w', leaseMs: 5_000 })).toBeNull();
    expect(await readSemanticEditExecutionStatus(store, stuck.projectId, intentId)).toMatchObject({ state: 'failed', failure: 'validation_failed' });
  });

  it('two workers that both see an edit execute it exactly once', async () => {
    const d = await draftProject();
    await submitSemanticEdit(editInput(d));
    const open = gate();
    const a = workerFor('worker-a');
    const b = workerFor('worker-b');
    const claimed = await Promise.all([a.claimOne(), b.claimOne()]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    open();
    await Promise.all([a.drain(), b.drain()]);
    expect(calls.edit).toHaveLength(1);
    expect((await intentOf(d.projectId)).status).toBe('completed');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId })).toBe(2);
  });

  it('a worker never executes more edits at once than its concurrency', async () => {
    const drafts = [await draftProject(), await draftProject(), await draftProject()];
    for (const d of drafts) await submitSemanticEdit(editInput(d));
    const open = gate();
    const worker = workerFor('capped', { concurrency: 2 });
    expect([await worker.claimOne(), await worker.claimOne(), await worker.claimOne()]).toEqual([true, true, false]);
    expect(worker.activeCount).toBe(2);
    await until(() => calls.edit.length === 2);
    open();
    await worker.drain();
    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    for (const d of drafts) expect((await intentOf(d.projectId)).status).toBe('completed');
    expect(calls.edit).toHaveLength(3);
  });
});

describe('dead and stale workers', () => {
  it('an edit whose worker died mid-build is continued on the same job, once both leases have expired — and the dead attempt can never land', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    const intent = await intentOf(d.projectId);
    const engine = new JobEngine(store);
    // What a dead worker leaves: its intent lease and its job lease, both expired.
    await claimSemanticEditExecution(store, { owner: 'dead-worker', leaseMs: 1_000, now: new Date(Date.now() - 60_000) });
    await engine.enqueue({ spec: intent.jobSpec, origin: { kind: 'semantic_edit', intentId } });
    await engine.claim('dead-worker', 'terra', { jobId: intent.jobId, leaseMs: 1_000, now: new Date(Date.now() - 60_000) });

    const events: { event: string }[] = [];
    const worker = workerFor('survivor', {}, (e) => events.push(e as { event: string }));
    expect(await worker.claimOne()).toBe(true);
    await worker.drain();

    expect(events.map((e) => e.event)).toContain('job_lease_reclaimed');
    expect((await intentOf(d.projectId)).status).toBe('completed');
    const job = (await store.jobs.findOne({ _id: intent.jobId }))!;
    expect(job).toMatchObject({ state: 'accepted', attempt: 2 });
    expect(await store.jobs.countDocuments({ projectId: d.projectId })).toBe(2);
    expect(await store.promotions.findOne({ jobId: intent.jobId })).toMatchObject({ attempt: 2, status: 'committed' });
    expect(calls.edit).toHaveLength(1);
    // The dead execution's tokens are stale for everything.
    await expect(engine.submitForValidation(intent.jobId, 'dead-worker', 1, { outputs: [] })).rejects.toThrow();
    expect(await engine.heartbeat(intent.jobId, 'dead-worker', 1)).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/token/);
  });

  it('a job another worker still holds is never stolen: the edit waits', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    const intent = await intentOf(d.projectId);
    const engine = new JobEngine(store);
    await engine.enqueue({ spec: intent.jobSpec, origin: { kind: 'semantic_edit', intentId } });
    await engine.claim('live-worker', 'terra', { jobId: intent.jobId, leaseMs: 600_000 });

    const worker = workerFor('patient');
    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    expect(await store.jobs.findOne({ _id: intent.jobId })).toMatchObject({ state: 'running', attempt: 1, lease: { holder: 'live-worker' } });
    expect(await intentOf(d.projectId)).toMatchObject({ status: 'building' });
    expect(await intentOf(d.projectId)).not.toHaveProperty('execution');
    expect(calls.edit).toEqual([]);
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intentId)).toMatchObject({ state: 'queued' });
  });

  it('a worker that loses its lease mid-build is aborted and writes nothing to the edit; the new holder finishes it without rebuilding', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    const open = gate();
    const events: { event: string }[] = [];
    const a = workerFor('slow-worker', { leaseMs: 2_000, heartbeatMs: 100 }, (e) => events.push(e as { event: string }));
    expect(await a.claimOne()).toBe(true);
    await until(() => calls.edit.length === 1);

    // A legitimate takeover: the lease is expired by the clock, and another worker claims the same edit.
    await store.semanticEditIntents.updateOne({ _id: intentId }, { $set: { 'execution.expiresAt': new Date(Date.now() - 1) } });
    const b = (await claimSemanticEditExecution(store, { owner: 'new-holder', leaseMs: 60_000 }))!;
    expect(b.intentId).toBe(intentId);
    await until(() => events.some((e) => e.event === 'intent_lease_lost'));

    open();
    await a.drain();
    const afterA = await intentOf(d.projectId);
    expect(afterA.status).toBe('building');
    expect(afterA.execution?.token).toBe(b.token);
    expect(afterA).not.toHaveProperty('disposition');

    // The stale token cannot move the edit either.
    const { SemanticEditExecutionLeaseLost } = await import('../src/semantic-edit/apply.js');
    const capturesBeforeStale = calls.capture;
    await expect(resumeSemanticEditIntent(deps(), { projectId: d.projectId, intentId }, { leaseToken: 'stale-token' })).rejects.toBeInstanceOf(SemanticEditExecutionLeaseLost);
    // Refused at its first intent write: not promoted, not evaluated, nothing captured.
    const afterStale = await intentOf(d.projectId);
    expect(afterStale.status).toBe('building');
    expect(afterStale).not.toHaveProperty('promotion');
    expect(afterStale).not.toHaveProperty('evaluation');
    expect(calls.capture).toBe(capturesBeforeStale);

    const finished = await resumeSemanticEditIntent(deps(), { projectId: d.projectId, intentId }, { leaseToken: b.token });
    expect(finished).toMatchObject({ status: 'completed' });
    expect(calls.edit).toHaveLength(1);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId })).toBe(2);
    expect(await store.canonicalDrafts.countDocuments({ projectId: d.projectId, current: true })).toBe(1);
  });
});

describe('bounded failure and retry', () => {
  it('a candidate that fails official validation is not rebuilt or revalidated forever: it stops, and the draft stays claimed', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    editBehaviour = (_n, input) => ({ files: pageFilesForModel(input.model, '<p>x</p>', (html) => html.replace(/ data-statx-section-id="[^"]+"/, '')) });
    const worker = workerFor('validator');
    expect(await worker.claimOne()).toBe(true);
    await worker.drain();

    expect(await intentOf(d.projectId)).toMatchObject({ status: 'building', disposition: { kind: 'failed', reason: 'validation_failed' } });
    expect(await worker.claimOne()).toBe(false);
    expect(calls.edit).toHaveLength(1);
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intentId)).toMatchObject({ state: 'failed', failure: 'validation_failed', resultDraftId: null });
    expect(await resolveCanonicalDraftAuthority(store, d.projectId)).toMatchObject({ state: 'handed_off', draft: { _id: d.d0._id, claim: { operationId: intentId } } });
  });

  it('a model that keeps failing is retried within the job attempt bound, then stops', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    editFailures = new Set([1, 2, 3, 4, 5]);
    const worker = workerFor('persistent');
    for (let pass = 0; pass < 5 && (await worker.claimOne()); pass += 1) await worker.drain();

    expect(calls.edit).toHaveLength(3);
    expect(await store.jobs.findOne({ _id: (await intentOf(d.projectId)).jobId })).toMatchObject({ state: 'failed', attempt: 3 });
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intentId)).toMatchObject({ state: 'failed', failure: 'build_failed' });
    expect(await worker.claimOne()).toBe(false);
    const status = JSON.stringify(await readSemanticEditExecutionStatus(store, d.projectId, intentId));
    expect(status).not.toMatch(/model provider|Error|stack/);
  });

  it('an infrastructure failure after promotion keeps the same edit and retries it — without rebuilding — then bounds it', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    captureFailures = new Set([2]);
    const worker = workerFor('retrying');
    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    expect(await intentOf(d.projectId)).toMatchObject({ status: 'promoted', executionFailures: 1 });
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intentId)).toMatchObject({ state: 'finishing' });
    const models = await count(d.projectId, 'editable-site-model');

    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    expect(await intentOf(d.projectId)).toMatchObject({ status: 'completed' });
    expect(calls.edit).toHaveLength(1);
    expect(await count(d.projectId, 'editable-site-model')).toBe(models);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId })).toBe(2);

    const bounded = await draftProject();
    const second = await submitSemanticEdit(editInput(bounded));
    captureFailures = new Set(Array.from({ length: 20 }, (_, i) => calls.capture + 1 + i));
    for (let pass = 0; pass < 6 && (await worker.claimOne()); pass += 1) await worker.drain();
    expect(await readSemanticEditExecutionStatus(store, bounded.projectId, second.intentId)).toMatchObject({ state: 'failed', failure: 'temporarily_unavailable' });
    expect(await intentOf(bounded.projectId)).toMatchObject({ executionFailures: 3, disposition: { reason: 'execution_failed' } });
  });
});

describe('the crash matrix', () => {
  it('a worker that died holding the edit before claiming its job is replaced once its lease expires', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    await claimSemanticEditExecution(store, { owner: 'died-early', leaseMs: 60_000 });
    const worker = workerFor('next');
    expect(await worker.claimOne()).toBe(false);
    await store.semanticEditIntents.updateOne({ _id: intentId }, { $set: { 'execution.expiresAt': new Date(Date.now() - 1) } });
    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intentId)).toMatchObject({ state: 'completed' });
  });

  it('a crash after acceptance, before promotion, resumes the exact job — no rebuild, one successor', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    const real = store.promotions;
    let failed = false;
    vi.spyOn(store, 'promotions', 'get').mockReturnValue(
      new Proxy(real, {
        get(target, key, receiver) {
          if (key === 'insertOne' && !failed) {
            return async () => {
              failed = true;
              throw new Error('process died before promotion');
            };
          }
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    const worker = workerFor('crashy');
    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    vi.restoreAllMocks();
    const intent = await intentOf(d.projectId);
    expect(intent.status).toBe('building');
    expect((await store.jobs.findOne({ _id: intent.jobId }))?.state).toBe('accepted');

    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intentId)).toMatchObject({ state: 'completed' });
    expect(calls.edit).toHaveLength(1);
    expect(await store.jobs.findOne({ _id: intent.jobId })).toMatchObject({ attempt: 1 });
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: d.projectId, predecessorBindingId: d.b0._id })).toBe(1);
  });

  it('a crash after evaluation concludes from the recorded evidence; a crash after conclusion is simply complete', async () => {
    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    const real = store.canonicalDrafts;
    let failed = false;
    vi.spyOn(store, 'canonicalDrafts', 'get').mockReturnValue(
      new Proxy(real, {
        get(target, key, receiver) {
          if (key === 'insertOne' && !failed) {
            return async () => {
              failed = true;
              throw new Error('process died before conclusion');
            };
          }
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    const worker = workerFor('evaluator');
    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    vi.restoreAllMocks();
    const evaluated = await intentOf(d.projectId);
    expect(evaluated.status).toBe('evaluated');
    const captures = calls.capture;

    expect(await worker.claimOne()).toBe(true);
    await worker.drain();
    const done = await intentOf(d.projectId);
    expect(done).toMatchObject({ status: 'completed', evaluation: evaluated.evaluation });
    expect(calls.capture).toBe(captures);
    expect((await store.canonicalDrafts.findOne({ _id: done.resultDraftId! }))?.siteExportSnapshot).toEqual(evaluated.evaluation!.siteExportSnapshot);

    // Completed: not work, and no second draft.
    expect(await worker.claimOne()).toBe(false);
    expect(await claimSemanticEditExecution(store, { owner: 'late', leaseMs: 5_000, intentId })).toBeNull();
    expect(await store.canonicalDrafts.countDocuments({ projectId: d.projectId })).toBe(2);
    expect(await readSemanticEditExecutionStatus(store, d.projectId, intentId)).toMatchObject({ state: 'completed', resultDraftId: done.resultDraftId });
    expect(calls.approve + calls.refine + deployed.calls).toBe(0);
    expect(await store.releasePublications.countDocuments({ projectId: d.projectId })).toBe(0);
  });
});

describe('the worker loop', () => {
  it('polls without busy-looping, and stops claiming on shutdown without releasing the draft', async () => {
    const counted = { claims: 0 };
    const real = store.semanticEditIntents;
    vi.spyOn(store, 'semanticEditIntents', 'get').mockReturnValue(
      new Proxy(real, {
        get(target, key, receiver) {
          if (key === 'findOneAndUpdate') counted.claims += 1;
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    const idle = workerFor('idle', { pollMs: 200 });
    const loop = idle.start();
    await new Promise((r) => setTimeout(r, 1_100));
    await idle.stop(500);
    await loop;
    vi.restoreAllMocks();
    expect(counted.claims).toBeGreaterThanOrEqual(3);
    expect(counted.claims).toBeLessThanOrEqual(8);

    const d = await draftProject();
    const { intentId } = await submitSemanticEdit(editInput(d));
    const open = gate();
    const busy = workerFor('busy', { pollMs: 50 });
    const running = busy.start();
    await until(() => calls.edit.length === 1);
    await busy.stop(200);
    await running;
    expect(await busy.claimOne()).toBe(false);
    expect(await resolveCanonicalDraftAuthority(store, d.projectId)).toMatchObject({ state: 'handed_off', draft: { claim: { operationId: intentId } } });
    open();
    await busy.drain();
    // The aborted execution wrote no disposition; the edit is still work for the next worker.
    expect(await intentOf(d.projectId)).not.toHaveProperty('disposition');
  });
});
