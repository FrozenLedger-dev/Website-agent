/**
 * The editable site model through the real production pipeline.
 *
 * `runProject` in `job_lifecycle` mode is real: the model is materialised from
 * the exact plan before any code exists, pinned into the job spec and binding,
 * handed to Terra, and measured by the site-model gate in official validation
 * and in canonical evaluation — including after a Luna repair. The compiler is
 * faked with an export read straight from the page files the build wrote, so
 * the gate measures exactly what Terra (or Luna) produced, not a fixture.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { EDITABLE_SITE_MODEL_ARTIFACT, EditableSiteModel, SITE_MODEL_MARKERS, routeToOutputPath, routeToSourcePath, type ArtifactRef, type SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { contentHash } from '@statxai/workspace';
import { exportForModel, exportFromPageFiles } from './support/site-model-export.js';

const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };
const section = (id: string, heading: string, layout: string) => ({ id, heading, purpose: 'p', layout, contentBindings: ['services'] });
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
  sitemap: {
    pages: [
      { route: '/', title: 'Harrowgate Joinery', metaDescription: 'Fitted joinery in Harrogate.', goal: 'g', primaryAction: 'call', sections: [section('hero', 'Fitted joinery, made here', 'split-hero'), section('contact', 'Talk to the workshop', 'contact-panel')] },
      { route: '/services', title: 'Services', metaDescription: 'What we make.', goal: 'g', primaryAction: 'quote', sections: [section('list', 'What we make', 'rule-list')] },
    ],
  },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

type Tamper = (html: string, model: EditableSiteModel, route: string) => string;
let buildTamper: Tamper | null;
let repairTamper: Tamper | null;
let reviewSequence: { blocking: boolean }[];
let adjudications: { action: string; reason: string; defectIds: string[] | null; objective: null; scope: null }[];
const calls = { buildModels: [] as (EditableSiteModel | undefined)[], repairs: 0 };
const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);

/** Page files whose contents are the page's exported HTML — so the faked compiler exports exactly what was written. */
const pageFiles = (model: EditableSiteModel, tamper: Tamper | null) =>
  exportForModel(model, { body: '<h1>Harrowgate Joinery</h1>' }).map((file) => {
    const page = model.pages.find((p) => routeToOutputPath(p.route) === file.path)!;
    return { path: routeToSourcePath(page.route), contents: tamper ? tamper(file.contents, model, page.route) : file.contents };
  });

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => ({ value: PLAN, model: 'sol', ...usage })),
    routeBuild: vi.fn(async () => ({ value: { action: 'one_shot', reason: 'small', confidence: 0.9, workstreams: null }, model: 'sol', ...usage })),
    // Terra is handed the exact model; it builds from it — or, when a test says so, breaks it.
    buildSite: vi.fn(async (_r: unknown, _p: unknown, plan: SitePlan, options: { siteModel?: EditableSiteModel }) => {
      calls.buildModels.push(options.siteModel);
      const files = options.siteModel ? pageFiles(options.siteModel, buildTamper) : plan.sitemap.pages.map((p) => ({ path: routeToSourcePath(p.route), contents: '<html><head><title>T</title></head><body><main><h1>Harrowgate Joinery</h1></main></body></html>' }));
      return { value: { files, notes: '' }, model: 'terra', ...usage };
    }),
    reviewSite: vi.fn(async () => {
      const r = next(reviewSequence);
      const issues = r.blocking ? [{ id: 'QA-001', category: 'content', severity: 'P1', location: 'index.html', reason: 'Unsupported claim.', acceptanceTest: 'No unsupported claim.', recommendedAction: 'targeted_repair', evidence: [] }] : [];
      return { value: { decision: r.blocking ? 'reject' : 'accept', qualityScore: r.blocking ? 60 : 91, blocking: r.blocking, issues, summary: 's' }, model: 'terra', ...usage };
    }),
    reviewVisualQuality: vi.fn(async () => {
      throw new Error('no screenshots in this suite');
    }),
    recommendApproval: vi.fn(async () => ({ value: { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: [] }, model: 'sol', ...usage })),
    adjudicate: vi.fn(async () => ({ value: next(adjudications), model: 'sol', ...usage })),
    repairDefect: vi.fn(async (_r: unknown, _p: unknown, _task: unknown, files: { path: string; contents: string }[]) => {
      calls.repairs += 1;
      const target = files.find((f) => f.path === 'app/page.tsx')!;
      const model = EditableSiteModel.parse(JSON.parse(target.contents.match(/<!--model:(.*?)-->/)?.[1] ?? 'null') ?? null);
      return { value: { files: [{ path: 'app/page.tsx', contents: repairTamper ? repairTamper(target.contents, model, '/') : target.contents }], notes: 'repaired' }, model: 'luna', ...usage };
    }),
  };
});

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async () => ({ ok: true, durationMs: 5, output: '', outDir: '/out' })),
    readBuiltFiles: vi.fn(async (siteRoot: string) => exportFromPageFiles(siteRoot)),
    readExportFiles: vi.fn(async () => []),
    captureInBrowser: vi.fn(async () => null),
    deploymentConfigured: vi.fn(() => false),
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
let workspacesRoot: string;
let validationWorkspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-model-pipeline-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-model-pipeline-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  buildTamper = null;
  repairTamper = null;
  reviewSequence = [{ blocking: false }];
  adjudications = [{ action: 'block', reason: 'unused', defectIds: null, objective: null, scope: null }];
  calls.buildModels = [];
  calls.repairs = 0;
  for (const c of [store.jobs, store.auditLog, store.artifacts, store.projects, store.budgets, store.defectBudgets, store.promotions, store.frontendBackendBuildBindings, store.releasePublications, store.visualRefinementIntents]) {
    await (c as { deleteMany(f: object): Promise<unknown> }).deleteMany({});
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

const run = async (projectId: string, mode: 'job_lifecycle' | 'legacy_direct' = 'job_lifecycle') => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({ projectId, intake: INTAKE, store, workspacesRoot, autonomyMode: 'full_autonomous', frontendBackendExecutionMode: mode, validationWorkspacesRoot });
};
const models = async (projectId: string) => store.artifacts.find({ projectId, name: EDITABLE_SITE_MODEL_ARTIFACT }).sort({ version: 1 }).toArray();
const reports = async (projectId: string) => store.artifacts.find({ projectId, name: 'test-report' }).sort({ version: 1 }).toArray();

describe('a new generation is built from its exact model', () => {
  it('the model is materialised from the exact plan before any code, pinned into the job and binding, handed to Terra, and gated in validation and evaluation', async () => {
    const projectId = 'proj_model_fresh';
    const result = await run(projectId);
    expect(result.outcome).toBe('released');

    const [doc, ...more] = await models(projectId);
    expect(more).toEqual([]);
    const ref: ArtifactRef = { name: doc!.name, version: doc!.version, contentHash: doc!.contentHash };
    const model = EditableSiteModel.parse(doc!.data);
    const plan = (await store.artifacts.find({ projectId, name: 'site-plan' }).toArray())[0]!;
    expect(model.sitePlan).toEqual({ name: 'site-plan', version: plan.version, contentHash: plan.contentHash });
    expect(ref.contentHash).toBe(contentHash(model));
    // Created before the build: its lineage position precedes every job output.
    const candidate = await store.artifacts.findOne({ projectId, name: { $regex: /build-candidate$/ } });
    expect(doc!.lineageSeq!).toBeLessThan(candidate!.lineageSeq!);

    const [binding] = await store.frontendBackendBuildBindings.find({ projectId }).toArray();
    expect(binding!.jobSpec.inputs.editableSiteModel).toEqual(ref);
    const job = await store.jobs.findOne({ _id: binding!.jobId });
    expect(job!.spec.inputs.editableSiteModel).toEqual(ref);
    expect(calls.buildModels).toEqual([model]);

    const [report] = await reports(projectId);
    expect((report!.data as { gatesRun: string[] }).gatesRun).toContain('site-model');
  });

  it('a legacy_direct generation has no model and no site-model gate — it is unchanged', async () => {
    const projectId = 'proj_model_legacy';
    expect((await run(projectId, 'legacy_direct')).outcome).toBe('released');
    expect(await models(projectId)).toEqual([]);
    expect(calls.buildModels).toEqual([undefined]);
    expect(((await reports(projectId))[0]!.data as { gatesRun: string[] }).gatesRun).not.toContain('site-model');
  });
});

describe('Terra cannot break semantic identity', () => {
  it.each([
    ['omits a section marker', ((html, model) => html.replace(`${SITE_MODEL_MARKERS.section}="${model.pages[0]!.sections[1]!.sectionId}"`, '')) as Tamper],
    ['replaces the page ID with one it invented', ((html, model) => html.replace(model.pages[0]!.pageId, 'pg_0123456789abcdef')) as Tamper],
    ['renders a section twice', ((html, model) => html.replace('</main>', `<section ${SITE_MODEL_MARKERS.section}="${model.pages[0]!.sections[0]!.sectionId}"></section></main>`)) as Tamper],
    ['changes a heading', ((html) => html.replace('Fitted joinery, made here', 'Bespoke joinery for every home')) as Tamper],
    ['puts another page’s section on the homepage', ((html, model) => html.replace('</main>', `<section ${SITE_MODEL_MARKERS.section}="${model.pages[1]!.sections[0]!.sectionId}"></section></main>`)) as Tamper],
  ])('a candidate that %s fails official validation and never promotes', async (_label, tamper) => {
    const projectId = 'proj_model_tampered';
    buildTamper = (html, model, route) => (route === '/' ? tamper(html, model, route) : html);

    const result = await run(projectId);

    expect(result.outcome).toBe('blocked');
    expect(result.jobLifecycleOutcome).toBe('validation_failed');
    expect(await store.promotions.countDocuments({ projectId })).toBe(0);
  });
});

describe('a Luna repair is measured against the same model', () => {
  it('a repair that drops a marker is caught by the next canonical evaluation as a blocking site-model defect', async () => {
    const projectId = 'proj_model_repair';
    reviewSequence = [{ blocking: true }, { blocking: false }];
    adjudications = [
      { action: 'repair', reason: 'One unsupported claim.', defectIds: ['QA-001'], objective: null, scope: null },
      { action: 'block', reason: 'Semantic identity broken.', defectIds: null, objective: null, scope: null },
    ];
    // The model travels inside the page, so the fake Luna can find the marker to drop.
    buildTamper = (html, model) => html.replace('</body>', `<!--model:${JSON.stringify(model)}--></body>`);
    repairTamper = (html, model) => html.replace(`${SITE_MODEL_MARKERS.section}="${model.pages[0]!.sections[0]!.sectionId}"`, '');

    const result = await run(projectId);

    expect(calls.repairs).toBeGreaterThan(0);
    expect(result.outcome).toBe('blocked');
    const [, afterRepair] = await reports(projectId);
    const findings = (afterRepair!.data as { findings: { gate: string; severity: string; location: string }[]; gatesRun: string[] }).findings;
    expect(findings.some((f) => f.gate === 'site-model' && f.severity === 'P0' && f.location === 'app/page.tsx')).toBe(true);
    expect(await store.releasePublications.countDocuments({ projectId })).toBe(0);
  });
});
