/**
 * Characterisation of a whole delivery, written to make Phase 4a safe.
 *
 * `refusal.integration.test.ts` covers every way a delivery is *refused*, and
 * covers them well — but it never lets one succeed, so the released path (the
 * commit, the deployment, the manifest, the `released` state) had no end-to-end
 * assertion at all. Neither did the order artifacts are written in, which is
 * the property a refactor is most likely to break while leaving the final
 * result identical.
 *
 * These are parity tests, not new requirements. Every value asserted here is
 * what the orchestrator did before the phase extraction began; the point is
 * that it still does it afterwards. They were written against the pre-refactor
 * code and must not be adjusted to match a refactor's output — a change here is
 * a behaviour change, which Phase 4a is not permitted to make.
 *
 * Integration: needs the Mongo replica set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { StateStore } from '@statxai/state';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
let replans: { failureDiagnosis: string; changes: { area: string; change: string; reason: string }[]; preservedAreas: string[] }[];
let deploymentIsConfigured = true;

const repairCalls: string[] = [];
const deployCalls: string[] = [];

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

const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);

const page = (route: string, title: string) => ({
  route,
  title,
  metaDescription: 'd',
  goal: 'g',
  primaryAction: 'call',
  sections: [{ id: 'hero', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }],
});

const planWith = (routes: [string, string][]) => ({
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
});

const PLAN = planWith([['/', 'Home']]);
const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => ({ value: PLAN, model: 'gpt-5.6-sol', ...usage })),
    routeBuild: vi.fn(async () => ({
      value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    buildSite: vi.fn(async () => ({
      value: { files: [{ path: 'app/page.tsx', contents: 'export default function P(){return null}' }], notes: '' },
      model: 'gpt-5.6-terra',
      ...usage,
    })),
    reviewSite: vi.fn(async () => {
      const r = next(reviewSequence);
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
    adjudicate: vi.fn(async () => ({ value: next(adjudications), model: 'gpt-5.6-sol', ...usage })),
    replanSite: vi.fn(async () => {
      const r = next(replans);
      return { value: { ...r, revisedPlan: planWith([['/', 'Home'], ['/contact', 'Contact']]) }, model: 'gpt-5.6-sol', ...usage };
    }),
    repairDefect: vi.fn(async (_client: unknown, _profile: unknown, task: { id: string }) => {
      repairCalls.push(task.id);
      return {
        value: { files: [{ path: 'app/page.tsx', contents: 'export default function P(){return null}' }], notes: '' },
        model: 'gpt-5.6-luna',
        ...usage,
      };
    }),
  };
});

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    scaffoldSite: vi.fn(async () => {}),
    buildSite: vi.fn(async () => ({ ok: true, durationMs: 1200, output: '', outDir: '/out' })),
    readBuiltFiles: vi.fn(async () => [
      { path: 'index.html', contents: '<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Harrowgate Joinery</h1></main></body></html>' },
    ]),
    readExportFiles: vi.fn(async () => []),
    readSourceFiles: vi.fn(async () => [{ path: 'app/page.tsx', contents: 'x' }]),
    deploymentConfigured: vi.fn(() => deploymentIsConfigured),
    deploySite: vi.fn(async (root: string) => {
      deployCalls.push(root);
      return { url: 'https://harrowgate.example', deploymentId: 'dpl_1', rollbackRef: 'dpl_0', fileCount: 3, durationMs: 42 };
    }),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return {
    ...actual,
    runGates: vi.fn(() => ({ passed: true, findings: [], gatesRun: ['claims', 'structure'] })),
  };
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
let root: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  root = await mkdtemp(join(tmpdir(), 'parity-test-'));
});

afterAll(async () => {
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  deployCalls.length = 0;
  repairCalls.length = 0;
  deploymentIsConfigured = true;
  reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
  adjudications = [{ action: 'block', reason: 'unused by default', defectIds: null, objective: null, scope: null }];
  replans = [{ failureDiagnosis: 'The plan omitted a contact route.', changes: [{ area: '/contact', change: 'added', reason: 'no way to enquire' }], preservedAreas: ['brand'] }];
  approval = { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: ['QA-004'] };
  await store.artifacts.deleteMany({});
  await store.runs.deleteMany({});
});

const phases: string[] = [];

const run = async (projectId: string, autonomyMode: 'full_autonomous' | 'supervised_autonomous' = 'full_autonomous') => {
  const { runProject } = await import('../src/orchestrator.js');
  phases.length = 0;
  return runProject({
    projectId,
    intake: INTAKE,
    store,
    workspacesRoot: root,
    autonomyMode,
    onProgress: (e) => phases.push(e.phase),
  });
};

/**
 * The artifact stream in the order it was written.
 *
 * Ordered by `createdAt` rather than `_id`, which is
 * `projectId:name:version` and therefore sorts alphabetically. Every write here
 * is separated by at least one await, so the millisecond resolution is enough
 * to distinguish them.
 */
const lineage = async (projectId: string) =>
  (await store.artifacts.find({ projectId }).sort({ createdAt: 1 }).toArray()).map(
    (a) => `${a.name}@${a.version}`,
  );

describe('a delivery that is released', () => {
  it('reports the run the caller is owed', async () => {
    const result = await run('proj_parity_released');

    expect(result.outcome).toBe('released');
    expect(result.terminalDecision).toBeUndefined();
    expect(result.qualityScore).toBe(92);
    expect(result.reviewCycles).toBe(0);
    expect(result.repairsApplied).toBe(0);
    expect(result.openDefects.map((d) => d.id)).toEqual(['QA-004']);
    expect(result.commit).not.toBeNull();
    expect(result.siteRoot).toContain('proj_parity_released');

    // Telemetry, which past refactors of the exit paths have zeroed.
    expect(result.usage.calls).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(Object.keys(result.usageByTier).sort()).toEqual(['sol', 'terra']);
    expect(Object.keys(result.phaseMs).length).toBeGreaterThan(0);
  });

  it('reaches deployment and records what shipped', async () => {
    const result = await run('proj_parity_deployed');

    expect(deployCalls).toHaveLength(1);
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.url).toBe('https://harrowgate.example');
    expect(result.manifest?.deploymentId).toBe('dpl_1');
    expect(result.manifest?.rollbackRef).toBe('dpl_0');

    // Sol recommends and the harness authorises; the manifest keeps them apart,
    // and no field lets a model appear to have released anything.
    expect(result.manifest?.recommendation.by).toBe('sol');
    expect(result.manifest?.recommendation.decision).toBe('accept');
    expect(result.manifest?.authorization.by).toBe('harness-policy');
    expect(result.manifest?.authorization.action).toBe('release');
  });

  it('leaves the project released', async () => {
    const projectId = 'proj_parity_state';
    await run(projectId);
    const project = await store.projects.findOne({ _id: projectId });
    expect(project?.state).toBe('released');
  });

  it('spends nothing it did not need', async () => {
    const projectId = 'proj_parity_budget';
    await run(projectId);

    const budget = await store.budgets.findOne({ _id: projectId });
    expect(budget?.used.reviewRejections).toBe(0);
    expect(budget?.used.totalRepairJobs).toBe(0);
    expect(budget?.used.replans).toBe(0);
    expect(budget?.used.failedDeployments).toBe(0);
    expect(await store.defectBudgets.countDocuments({ projectId })).toBe(0);
  });

  it('writes the artifact stream in the order the audit trail depends on', async () => {
    // Order is meaning here: a plan recorded after the build it produced, or an
    // authorisation before the recommendation it answers, would read as a
    // different run even with identical contents.
    const projectId = 'proj_parity_lineage';
    await run(projectId);

    expect(await lineage(projectId)).toEqual([
      'business-profile@1',
      'site-plan@1',
      'route-decision@1',
      'test-report@1',
      'visual-review@1',
      'approval-recommendation@1',
      'release-authorization@1',
      'deployment-manifest@1',
    ]);
  });

  it('reports progress in the order the phases ran', async () => {
    await run('proj_parity_phases');
    // Deduplicated: what matters is that the phases happen in this sequence,
    // not how many lines each one emitted.
    const order = phases.filter((p, i) => p !== phases[i - 1]);
    expect(order).toEqual(['discover', 'plan', 'build', 'evaluate', 'approve', 'publish']);
  });

  it('does not deploy when no deployment is configured, and still releases', async () => {
    deploymentIsConfigured = false;
    const result = await run('proj_parity_undeployed');

    expect(deployCalls).toEqual([]);
    expect(result.outcome).toBe('released');
    expect(result.manifest?.url).toBeNull();
    expect(result.manifest?.deploymentId).toBeNull();
  });
});

describe('a delivery that replans before it is released', () => {
  /**
   * The replan path has no end-to-end coverage elsewhere — `replanSite` is a
   * bare mock in the refusal suite — and Phase 4a moves `revisePlan`. This pins
   * the plan lineage, the budget spend and the artifact it records.
   */
  beforeEach(() => {
    reviewSequence = [
      { qualityScore: 60, blocking: true, issues: [issue({ id: 'QA-010', severity: 'P1', category: 'structure', reason: 'No way to make an enquiry anywhere on the site.' })] },
      { qualityScore: 90, blocking: false, issues: [issue()] },
    ];
    adjudications = [
      { action: 'replan', reason: 'The plan has no contact route at all.', defectIds: null, objective: null, scope: 'site' },
    ];
  });

  it('activates the revised plan as a new version and releases from it', async () => {
    const projectId = 'proj_parity_replan';
    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    expect(result.reviewCycles).toBe(1);
    expect(result.repairsApplied).toBe(0);
    expect(repairCalls).toEqual([]);

    const stream = await lineage(projectId);
    expect(stream).toContain('replan-decision@1');
    // A new version of the plan, never an overwrite: the plan that failed stays
    // readable next to the one that replaced it.
    expect(stream).toContain('site-plan@2');
    expect(stream.indexOf('replan-decision@1')).toBeLessThan(stream.indexOf('site-plan@2'));

    const budget = await store.budgets.findOne({ _id: projectId });
    expect(budget?.used.replans).toBe(1);
    expect(budget?.used.reviewRejections).toBe(1);
    expect(budget?.used.totalRepairJobs).toBe(0);
  });
});

