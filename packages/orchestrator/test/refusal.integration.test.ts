/**
 * A whole delivery that is refused a release.
 *
 * The last three defects in this area were all in the *result* rather than the
 * decision: the approval logic was right each time, while the telemetry around
 * it reported a different run — zeroed quality and cycles, a dropped terminal
 * decision, and a denied release describing itself as `accept_non_blocking`.
 * Each was found by reading code, because every test checked one piece in
 * isolation and nothing asserted the boundary the caller actually sees.
 *
 * This runs the real orchestrator against a real store and asserts the whole
 * `RunResult`, the persisted project state, and that nothing was deployed.
 *
 * Stubbed: the model tiers, the build toolchain, and deterministic gate
 * execution. Real: the orchestration control flow, the budget transactions, the
 * artifact registry, the project state and the result itself — which is the
 * boundary the reporting bugs lived in.
 *
 * Integration: needs the Mongo replica set, so it runs in CI's second job
 * alongside the other three suites that do, not in the deterministic one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { StateStore } from '@statxai/state';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Set per test to steer the stubbed approval. */
let approval: { recommendation: string; reason: string; acknowledgedIssues: string[] };
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

/**
 * Reviews the stubbed Terra returns, consumed in order.
 *
 * A sequence rather than a fixed value so a delivery can actually progress:
 * blocking first, clean after the repair. The last entry repeats, so a run that
 * loops more than expected does not fall off the end.
 */
let reviewSequence: { qualityScore: number; blocking: boolean; issues: ReviewIssue[] }[];
/** Adjudications the stubbed Sol returns, same convention. */
let adjudications: { action: string; reason: string; defectIds: string[] | null; objective: null; scope: null }[];
const repairCalls: string[] = [];

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
const deployCalls: string[] = [];

const PLAN = {
  strategy: 'Local trade credibility',
  valueProposition: 'Fitted joinery, made and installed by the same two people.',
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: 'Trade-signage directness.',
    radius: 'square',
    rationale: 'Workwear palette suits the trade.',
  },
  sitemap: {
    pages: [
      { route: '/', title: 'Home', metaDescription: 'd', goal: 'g', primaryAction: 'call', sections: [{ id: 'hero', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }] },
    ],
  },
  acceptanceCriteria: ['a', 'b', 'c'],
};

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
    replanSite: vi.fn(),
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
    deploymentConfigured: vi.fn(() => true),
    deploySite: vi.fn(async (root: string) => {
      deployCalls.push(root);
      return { url: 'https://should-not-happen', deploymentId: 'x', rollbackRef: null, fileCount: 1, durationMs: 1 };
    }),
  };
});

// Gates are stubbed to pass with one P2 open, so the run reaches approval with
// something real for Sol to acknowledge.
vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return {
    ...actual,
    runGates: vi.fn(() => ({
      passed: true,
      findings: [],
      gatesRun: ['claims', 'structure'],
    })),
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
  root = await mkdtemp(join(tmpdir(), 'refusal-test-'));
});

afterAll(async () => {
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  deployCalls.length = 0;
  repairCalls.length = 0;
  reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
  adjudications = [{ action: 'block', reason: 'unused by default', defectIds: null, objective: null, scope: null }];
  await store.artifacts.deleteMany({});
  await store.runs.deleteMany({});
});

const run = async (projectId: string, autonomyMode: 'full_autonomous' | 'supervised_autonomous') => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({ projectId, intake: INTAKE, store, workspacesRoot: root, autonomyMode });
};

describe('a delivery whose release Sol rejects', () => {
  beforeEach(() => {
    approval = {
      recommendation: 'reject',
      reason: 'The focus indicator problem is not cosmetic and should be fixed first.',
      acknowledgedIssues: [],
    };
  });

  it('reports the delivery that actually happened', async () => {
    const projectId = 'proj_refusal_reject';
    const result = await run(projectId, 'full_autonomous');

    expect(result.outcome).toBe('blocked');
    expect(result.terminalDecision).toBe('mark_blocked');

    // The fields the old late-exit helper zeroed. `qualityScore` alone would
    // catch a wholesale reset, but not a narrower one, so each is asserted at
    // its actual value — see the repair scenario below for cycles and repairs
    // with something other than zero to lose.
    expect(result.qualityScore).toBe(92);
    expect(result.reviewCycles).toBe(0);
    expect(result.repairsApplied).toBe(0);
    expect(result.openDefects.some((d) => d.id === 'QA-004')).toBe(true);
    expect(result.siteRoot).not.toBe('');
    expect(result.siteRoot).toContain(projectId);
    expect(result.usage.calls).toBeGreaterThan(0);
  });

  it('never reports a denied release as an acceptance', async () => {
    const result = await run('proj_refusal_reject_2', 'full_autonomous');
    expect(result.terminalDecision).not.toBe('accept_non_blocking');
  });

  it('marks the project blocked', async () => {
    await run('proj_refusal_state', 'full_autonomous');
    const project = await store.projects.findOne({ _id: 'proj_refusal_state' });
    expect(project?.state).toBe('blocked');
  });

  it('deploys nothing', async () => {
    await run('proj_refusal_nodeploy', 'full_autonomous');
    expect(deployCalls).toEqual([]);
  });

  it('writes no deployment manifest', async () => {
    await run('proj_refusal_nomanifest', 'full_autonomous');
    const manifest = await store.artifacts.findOne({
      projectId: 'proj_refusal_nomanifest',
      name: 'deployment-manifest',
    });
    expect(manifest).toBeNull();
  });

  it('persists the recommendation and the authorisation as separate artifacts', async () => {
    const projectId = 'proj_refusal_artifacts';
    await run(projectId, 'full_autonomous');

    const approvalDoc = await store.artifacts.findOne({ projectId, name: 'approval-recommendation' });
    const authDoc = await store.artifacts.findOne({ projectId, name: 'release-authorization' });

    expect((approvalDoc?.data as { recommendation?: string })?.recommendation).toBe('reject');
    expect((authDoc?.data as { authorized?: boolean })?.authorized).toBe(false);
    expect((authDoc?.data as { authorizedBy?: string })?.authorizedBy).toBe('harness-policy');
  });
});

describe('a delivery Sol refers to a person', () => {
  beforeEach(() => {
    approval = {
      recommendation: 'human_review',
      reason: 'Finely balanced; a person should look before this is public.',
      acknowledgedIssues: [],
    };
  });

  it('asks for a human rather than blocking', async () => {
    const result = await run('proj_refusal_human', 'supervised_autonomous');

    expect(result.outcome).toBe('blocked');
    expect(result.terminalDecision).toBe('request_human_review');
    expect(result.qualityScore).toBe(92);
  });

  it('leaves the project awaiting review, not blocked', async () => {
    await run('proj_refusal_human_state', 'supervised_autonomous');
    const project = await store.projects.findOne({ _id: 'proj_refusal_human_state' });
    expect(project?.state).toBe('awaiting_human_review');
  });

  it('deploys nothing', async () => {
    await run('proj_refusal_human_nodeploy', 'supervised_autonomous');
    expect(deployCalls).toEqual([]);
  });
});

describe('an acceptance that ignores what is still open', () => {
  beforeEach(() => {
    // A real P2 remains and the recommendation says nothing about it.
    approval = { recommendation: 'accept', reason: 'Looks good.', acknowledgedIssues: [] };
  });

  it('is refused, and reported as blocked rather than accepted', async () => {
    const result = await run('proj_refusal_incomplete', 'full_autonomous');

    expect(result.outcome).toBe('blocked');
    expect(result.terminalDecision).toBe('mark_blocked');
    expect(deployCalls).toEqual([]);
  });

  it('records why on the authorisation', async () => {
    const projectId = 'proj_refusal_incomplete_2';
    await run(projectId, 'full_autonomous');

    const authDoc = await store.artifacts.findOne({ projectId, name: 'release-authorization' });
    expect((authDoc?.data as { reason?: string })?.reason).toContain('QA-004');
  });
});

describe('a delivery that repairs before its release is refused', () => {
  /**
   * The scenario with something other than zero to lose.
   *
   * The earlier cases catch a wholesale reset because `qualityScore` is 92, but
   * they leave `reviewCycles` and `repairsApplied` legitimately at zero — so a
   * narrower regression that dropped only those would pass. Here a P1 is raised,
   * adjudicated to a repair, repaired, and the next evaluation comes back clean
   * apart from a P2, which Sol then refuses to ship.
   */
  beforeEach(() => {
    reviewSequence = [
      // First pass: a blocking defect, so adjudication runs.
      {
        qualityScore: 71,
        blocking: true,
        issues: [
          issue({
            id: 'QA-001',
            severity: 'P1',
            category: 'business_accuracy',
            reason: 'States a guarantee the profile does not support.',
          }),
        ],
      },
      // After the repair: only the cosmetic issue remains.
      { qualityScore: 88, blocking: false, issues: [issue()] },
    ];
    adjudications = [
      { action: 'repair', reason: 'One local unsupported claim.', defectIds: ['QA-001'], objective: null, scope: null },
    ];
    approval = {
      recommendation: 'reject',
      reason: 'The focus indicator problem should be fixed before release.',
      acknowledgedIssues: [],
    };
  });

  it('reports the cycles and repairs it actually performed', async () => {
    const result = await run('proj_refusal_repaired', 'full_autonomous');

    expect(repairCalls).toEqual(['QA-001']);
    expect(result.reviewCycles).toBe(1);
    expect(result.repairsApplied).toBe(1);

    // And the rest of the boundary, at its real values rather than defaults.
    expect(result.outcome).toBe('blocked');
    expect(result.terminalDecision).toBe('mark_blocked');
    expect(result.qualityScore).toBe(88);
    expect(result.openDefects.some((d) => d.id === 'QA-004')).toBe(true);
    expect(result.openDefects.some((d) => d.id === 'QA-001')).toBe(false);
    expect(result.commit).not.toBeNull();
    expect(result.siteRoot).toContain('proj_refusal_repaired');
    expect(deployCalls).toEqual([]);
  });

  it('spent the budgets the work required', async () => {
    const projectId = 'proj_refusal_repaired_budget';
    await run(projectId, 'full_autonomous');

    const budget = await store.budgets.findOne({ _id: projectId });
    expect(budget?.used.reviewRejections).toBe(1);
    expect(budget?.used.totalRepairJobs).toBe(1);
    expect(budget?.used.replans).toBe(0);
  });
});
