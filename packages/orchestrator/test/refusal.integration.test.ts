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
import type * as State from '@statxai/state';
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
/**
 * Fingerprints whose authoritative spend is refused, simulating drift.
 *
 * Within one run the spend cannot refuse a target policy authorised: the
 * targets are capped to the project allowance and filtered by per-fingerprint
 * eligibility from a snapshot read moments earlier. So the only way to reach
 * the exhaustion guard is for the transaction to disagree with that snapshot —
 * another writer, or a resumed run. That is precisely the case the guard exists
 * for, and it needs simulating to be tested at all.
 */
let driftRefuses: string[] = [];

vi.mock('@statxai/state', async (importOriginal) => {
  const actual = await importOriginal<typeof State>();
  return {
    ...actual,
    spendRepairAttempt: vi.fn(async (...args: Parameters<typeof actual.spendRepairAttempt>) => {
      const fingerprint = args[2];
      if (driftRefuses.includes(fingerprint)) throw new actual.BudgetExhausted('repairsPerDefect');
      return actual.spendRepairAttempt(...args);
    }),
  };
});

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
  driftRefuses = [];
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

describe('a defect that has spent its own repair allowance', () => {
  /**
   * `totalRepairJobs` is a project-wide allowance and `repairsPerDefect` is a
   * per-fingerprint one, and having the first does not imply having the second.
   * Policy used to reason only about the first, so a third cycle on the same
   * stubborn defect was authorised as a repair, reached `spendRepairAttempt`,
   * and was refused there — after the cycle had already been committed to.
   *
   * The same P1 comes back each time. `repairsPerDefect` is 2, so the third
   * adjudication must no longer be offered a repair it cannot be charged for.
   *
   * The cost of getting this wrong is a whole extra cycle: the run used to
   * adjudicate a third repair, fail to charge for it, evaluate again, and only
   * then block with its review-rejection allowance gone. So these assert the
   * *number* of cycles as much as their content — the old behaviour reached the
   * same ending, one wasted rejection later.
   */
  const stubborn = () =>
    issue({
      id: 'QA-001',
      severity: 'P1',
      category: 'business_accuracy',
      location: 'index.html',
      reason: 'States a guarantee the profile does not support.',
    });

  beforeEach(() => {
    reviewSequence = [
      { qualityScore: 62, blocking: true, issues: [stubborn()] },
      { qualityScore: 64, blocking: true, issues: [stubborn()] },
      { qualityScore: 66, blocking: true, issues: [stubborn()] },
    ];
    adjudications = [
      { action: 'repair', reason: 'Narrow claim fix.', defectIds: ['QA-001'], objective: null, scope: null },
      { action: 'repair', reason: 'Still there; try once more.', defectIds: ['QA-001'], objective: null, scope: null },
      { action: 'repair', reason: 'Try again.', defectIds: ['QA-001'], objective: null, scope: null },
    ];
    approval = { recommendation: 'accept', reason: 'unused', acknowledgedIssues: [] };
  });

  it('stops offering repair once the fingerprint is spent', async () => {
    const projectId = 'proj_repair_allowance';
    await run(projectId, 'full_autonomous');

    const decisions = await store.artifacts
      .find({ projectId, name: 'adjudication-decision' })
      .sort({ version: 1 })
      .toArray();

    const legalPerCycle = decisions.map(
      (d) => (d.data as { legalActions: string[] }).legalActions,
    );

    // Three cycles, not four: the run does not spend a review rejection to
    // discover an allowance policy could already see was gone.
    expect(legalPerCycle).toHaveLength(3);

    // Offered while the allowance lasts, withdrawn once it does not.
    expect(legalPerCycle[0]).toContain('repair');
    expect(legalPerCycle[1]).toContain('repair');
    expect(legalPerCycle[2]).not.toContain('repair');
    expect(legalPerCycle[2]).toEqual(['replan', 'block']);
  });

  it('charges the per-defect allowance exactly twice, and no more', async () => {
    const projectId = 'proj_repair_allowance_spend';
    await run(projectId, 'full_autonomous');

    const spent = await store.defectBudgets.find({ projectId }).toArray();
    expect(spent).toHaveLength(1);
    expect(spent[0]?.repairsUsed).toBe(2);

    // Every repair Luna was asked for was one the budget could pay for. Before
    // the fix a third was authorised and refused inside the transaction, which
    // rolled the spend back and left these two identical — the waste showed up
    // as an extra cycle rather than an extra charge.
    expect(repairCalls).toEqual(['QA-001', 'QA-001']);

    // Two rejections answered, and the third evaluation answered with `block`,
    // which spends none. The old path charged a third here for a repair it
    // could not perform.
    const budget = await store.budgets.findOne({ _id: projectId });
    expect(budget?.used.totalRepairJobs).toBe(2);
    expect(budget?.used.reviewRejections).toBe(2);
  });

  it('carries what was already attempted into the next adjudication', async () => {
    /**
     * The repair history is evidence for the *next* decision — it is how Sol
     * tells a first attempt from a defect narrow repair has already failed on.
     * It is produced by the repair phase, applied to the run by the loop, and
     * read back out through the adjudication constraints, so nothing else
     * notices if the middle step is dropped: the run still repairs, still
     * blocks, still reports the same totals, and quietly asks every later
     * adjudication to decide as though nothing had been tried.
     */
    const projectId = 'proj_repair_history_flows';
    await run(projectId, 'full_autonomous');

    const decisions = await store.artifacts
      .find({ projectId, name: 'adjudication-decision' })
      .sort({ version: 1 })
      .toArray();

    const previousRepairs = decisions.map(
      (d) => (d.data as { constraints: { previousRepairs: { defectId: string; outcome: string }[] } })
        .constraints.previousRepairs,
    );

    // Nothing attempted before the first decision; one attempt by the second.
    expect(previousRepairs[0]).toEqual([]);
    expect(previousRepairs[1]).toEqual([
      { defectId: 'QA-001', fingerprint: expect.any(String), outcome: '1 file(s) rewritten' },
    ]);
    expect(previousRepairs[2]).toHaveLength(2);
  });

  it('records what it refused, and why, on the last decision', async () => {
    const projectId = 'proj_repair_allowance_record';
    await run(projectId, 'full_autonomous');

    const decisions = await store.artifacts
      .find({ projectId, name: 'adjudication-decision' })
      .sort({ version: 1 })
      .toArray();
    expect(decisions).toHaveLength(3);
    const last = decisions[2]?.data as {
      action: string;
      source: string;
      targetDefectIds: string[];
      constraints: { repairsUsedByFingerprint: Record<string, number>; repairsLeft: number };
    };

    expect(last.action).not.toBe('repair');
    expect(last.targetDefectIds).toEqual([]);

    // The evidence for the refusal is on the artifact: project budget remained,
    // and the fingerprint's own allowance did not.
    expect(last.constraints.repairsLeft).toBeGreaterThan(0);
    expect(Object.values(last.constraints.repairsUsedByFingerprint)).toEqual([2]);
  });
});

describe('a repair naming more defects than the project allowance can pay for', () => {
  /**
   * `spendRepairAttempt` charges one `totalRepairJobs` unit per target, so a
   * repair naming five defects needs five units. Policy checked that repair was
   * affordable at all, never that the named set was — so with three units left
   * all five were authorised, three executed, two were refused inside the
   * transaction, and the artifact recorded five targets the harness already
   * knew it could not charge for.
   *
   * Five blocking defects against the default budget (8 total, 2 per defect):
   * cycle one spends five and leaves three, so cycle two is where the project
   * allowance, rather than per-defect eligibility, is the binding constraint.
   */
  const FIVE = ['QA-101', 'QA-102', 'QA-103', 'QA-104', 'QA-105'];

  const blockers = () =>
    FIVE.map((id, i) =>
      issue({
        id,
        severity: 'P1',
        category: 'business_accuracy',
        location: `page-${i}.html`,
        reason: `States a guarantee the profile does not support (${id}).`,
      }),
    );

  beforeEach(() => {
    reviewSequence = [
      { qualityScore: 55, blocking: true, issues: blockers() },
      { qualityScore: 58, blocking: true, issues: blockers() },
      { qualityScore: 61, blocking: true, issues: blockers() },
    ];
    adjudications = FIVE.map(() => ({
      action: 'repair',
      reason: 'All five are local unsupported claims.',
      defectIds: [...FIVE],
      objective: null,
      scope: null,
    }));
    approval = { recommendation: 'accept', reason: 'unused', acknowledgedIssues: [] };
  });

  it('authorises only what the remaining allowance covers', async () => {
    const projectId = 'proj_repair_capacity';
    await run(projectId, 'full_autonomous');

    const decisions = await store.artifacts
      .find({ projectId, name: 'adjudication-decision' })
      .sort({ version: 1 })
      .toArray();
    const targetsPerCycle = decisions.map(
      (d) => (d.data as { targetDefectIds: string[] }).targetDefectIds,
    );

    // Cycle one: eight units available, five named, five authorised.
    expect(targetsPerCycle[0]).toHaveLength(5);

    // Cycle two: three units left, five named, three authorised — and the two
    // it would not pay for are recorded rather than silently dropped.
    expect(targetsPerCycle[1]).toHaveLength(3);
    const second = decisions[1]?.data as { refusal: string | null };
    expect(second.refusal).toContain('project repair allowance');
  });

  it('asks Luna for exactly the repairs it can charge for', async () => {
    const projectId = 'proj_repair_capacity_spend';
    await run(projectId, 'full_autonomous');

    const budget = await store.budgets.findOne({ _id: projectId });
    expect(budget?.used.totalRepairJobs).toBe(8);
    expect(budget?.used.totalRepairJobs).toBe(budget?.limits.totalRepairJobs);

    // Never more calls than units spent. Before the fix the extra targets were
    // authorised, refused inside the transaction, and never reached Luna — so
    // the artifact and the work disagreed.
    expect(repairCalls).toHaveLength(8);
  });
});

describe('an adjudication artifact explains its own decision', () => {
  /**
   * Policy is deterministic, which is only worth something if the record keeps
   * the inputs. The snapshot first kept just the defect ids — and the merged
   * defect, carrying the fingerprint the repair budget is charged against, is
   * computed in the orchestrator and stored nowhere else: `test-report` has the
   * raw gate findings and `visual-review` the raw reviewer value. So an
   * artifact could not explain why one target was kept and another trimmed
   * without recomputing the merge from two other artifacts.
   *
   * Each persisted decision is replayed back through the policy engine and must
   * reproduce what was recorded. Two scenarios, because the two facts the
   * snapshot gained bind in different places: severity decides a capacity trim,
   * and fingerprint decides per-defect exhaustion.
   */
  const replayAll = async (projectId: string) => {
    const { legalAdjudicationActions, authorizeAdjudication } = await import(
      '@statxai/policy-engine'
    );

    await run(projectId, 'full_autonomous');

    const decisions = await store.artifacts
      .find({ projectId, name: 'adjudication-decision' })
      .sort({ version: 1 })
      .toArray();

    expect(decisions.length).toBeGreaterThan(1);

    for (const [cycle, doc] of decisions.entries()) {
      const record = doc.data as {
        action: string;
        source: string;
        refusal: string | null;
        targetDefectIds: string[];
        legalActions: string[];
        constraints: Parameters<typeof legalAdjudicationActions>[0];
        proposed: { action: string; defectIds: string[] } | null;
      };

      // The recorded constraints alone must reproduce the legal set...
      expect(legalAdjudicationActions(record.constraints), `cycle ${cycle} legal`).toEqual(
        record.legalActions,
      );

      // ...and, with Sol's own words, the authorisation that followed.
      if (!record.proposed) continue;
      const replayed = authorizeAdjudication(
        { action: record.proposed.action as 'repair', defectIds: record.proposed.defectIds },
        record.legalActions as 'repair'[],
        record.constraints,
      );

      expect(replayed.action, `cycle ${cycle} action`).toBe(record.action);
      expect(replayed.source, `cycle ${cycle} source`).toBe(record.source);
      expect(replayed.targetIds, `cycle ${cycle} targets`).toEqual(record.targetDefectIds);
      expect(replayed.refusal, `cycle ${cycle} refusal`).toBe(record.refusal);
    }

    return decisions;
  };

  const claim = (id: string, severity: 'P0' | 'P1', index: number) =>
    issue({
      id,
      severity,
      category: 'business_accuracy',
      location: `page-${index}.html`,
      reason: `Unsupported guarantee (${id}).`,
    });

  describe('a decision whose targets were trimmed for capacity', () => {
    /**
     * Five defects against the default budget: cycle one spends five of eight,
     * and cycle two has three units for five named defects — so the trim runs,
     * and it runs on severity.
     *
     * `QA-E` is the P0 deliberately: it sorts last by id, so a replay that lost
     * severity would keep a different pair and this would fail.
     */
    const FIVE = ['QA-A', 'QA-B', 'QA-C', 'QA-D', 'QA-E'];

    beforeEach(() => {
      const blockers = () => FIVE.map((id, i) => claim(id, id === 'QA-E' ? 'P0' : 'P1', i));
      reviewSequence = [
        { qualityScore: 51, blocking: true, issues: blockers() },
        { qualityScore: 54, blocking: true, issues: blockers() },
        { qualityScore: 57, blocking: true, issues: blockers() },
      ];
      adjudications = FIVE.map(() => ({
        action: 'repair',
        reason: 'All five are local unsupported claims.',
        defectIds: [...FIVE],
        objective: null,
        scope: null,
      }));
      approval = { recommendation: 'accept', reason: 'unused', acknowledgedIssues: [] };
    });

    it('replays to the same decision', async () => {
      const decisions = await replayAll('proj_replay_capacity');

      // The trim really happened, and severity really chose: the P0 survives a
      // cut that id order alone would have dropped it from.
      const second = decisions[1]?.data as { targetDefectIds: string[] };
      expect(second.targetDefectIds).toHaveLength(3);
      expect(second.targetDefectIds).toContain('QA-E');
    });
  });

  describe('a decision refused because the fingerprints were spent', () => {
    /**
     * Three defects, so the project allowance never binds first: each spends its
     * own two attempts over two cycles, and the third adjudication is refused on
     * per-fingerprint exhaustion alone. A replay that lost the fingerprint would
     * read every defect as fresh and offer repair.
     */
    const THREE = ['QA-A', 'QA-B', 'QA-C'];

    beforeEach(() => {
      const blockers = () => THREE.map((id, i) => claim(id, 'P1', i));
      reviewSequence = [
        { qualityScore: 51, blocking: true, issues: blockers() },
        { qualityScore: 54, blocking: true, issues: blockers() },
        { qualityScore: 57, blocking: true, issues: blockers() },
      ];
      adjudications = THREE.map(() => ({
        action: 'repair',
        reason: 'All three are local unsupported claims.',
        defectIds: [...THREE],
        objective: null,
        scope: null,
      }));
      approval = { recommendation: 'accept', reason: 'unused', acknowledgedIssues: [] };
    });

    it('replays to the same decision', async () => {
      const decisions = await replayAll('proj_replay_exhaustion');

      // Repair was withdrawn on per-defect grounds, with project budget left.
      const last = decisions.at(-1)?.data as {
        legalActions: string[];
        constraints: { repairsLeft: number };
      };
      expect(last.legalActions).not.toContain('repair');
      expect(last.constraints.repairsLeft).toBeGreaterThan(0);
    });
  });

  it('carries the policy input for each defect, and nothing beyond it', async () => {
    reviewSequence = [
      { qualityScore: 51, blocking: true, issues: [claim('QA-A', 'P1', 0)] },
      { qualityScore: 88, blocking: false, issues: [issue()] },
    ];
    adjudications = [
      { action: 'repair', reason: 'One claim.', defectIds: ['QA-A'], objective: null, scope: null },
    ];
    approval = { recommendation: 'reject', reason: 'unused', acknowledgedIssues: [] };

    const projectId = 'proj_replay_shape';
    await run(projectId, 'full_autonomous');

    const doc = await store.artifacts.findOne({ projectId, name: 'adjudication-decision' });
    const blocking = (doc?.data as { constraints: { blockingDefects: unknown[] } }).constraints
      .blockingDefects as { id: string; severity: string; fingerprint: string }[];

    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.severity).toMatch(/^P[0-3]$/);
    expect(blocking[0]?.fingerprint).toBeTruthy();

    // The reviewer's prose stays on the review outcome rather than being copied
    // into every adjudication: only what a policy rule reads goes in.
    expect(Object.keys(blocking[0]!).sort()).toEqual(['fingerprint', 'id', 'severity']);
  });
});

describe('a repair cycle that was refused every spend', () => {
  /**
   * The guard asks whether *this* cycle hit exhaustion and achieved nothing.
   *
   * It used to read the run's cumulative repair count, so a cycle that was
   * refused every spend still continued as long as some earlier cycle had
   * succeeded: another evaluation, another rejection spent, the same defects.
   *
   * Reaching it needs the authoritative spend to disagree with the snapshot
   * policy authorised from, which cannot happen inside one run — targets are
   * capped to both allowances first. So the refusal is simulated, which is
   * honest about what the branch is for: drift, or a concurrent writer.
   */
  const stubborn = (id: string) =>
    issue({
      id,
      severity: 'P1',
      category: 'business_accuracy',
      location: 'index.html',
      reason: 'States a guarantee the profile does not support.',
    });

  beforeEach(() => {
    reviewSequence = [
      // Cycle one repairs successfully, so the cumulative count is non-zero.
      { qualityScore: 60, blocking: true, issues: [stubborn('QA-501')] },
      // Cycle two: a second defect, whose every spend the store refuses.
      { qualityScore: 62, blocking: true, issues: [stubborn('QA-502')] },
      // Only reached if the run wrongly continues.
      { qualityScore: 64, blocking: true, issues: [stubborn('QA-503')] },
    ];
    adjudications = [
      { action: 'repair', reason: 'Narrow claim fix.', defectIds: ['QA-501'], objective: null, scope: null },
      { action: 'repair', reason: 'Narrow claim fix.', defectIds: ['QA-502'], objective: null, scope: null },
      { action: 'repair', reason: 'Narrow claim fix.', defectIds: ['QA-503'], objective: null, scope: null },
    ];
    approval = { recommendation: 'accept', reason: 'unused', acknowledgedIssues: [] };
  });

  it('stops instead of spending another rejection on the same defects', async () => {
    const projectId = 'proj_repair_drift';

    // Every fingerprint for this location and category collapses to one, so
    // refusing it refuses cycle two's only target.
    const { defectFingerprint } = await import('@statxai/contracts');
    driftRefuses = [defectFingerprint({ category: 'business_accuracy', location: 'index.html' })];

    // Cycle one must still succeed, so the refusal starts after it.
    const original = [...driftRefuses];
    driftRefuses = [];
    let cycle = 0;
    const armAfterFirstRepair = () => {
      cycle += 1;
      if (cycle === 1) driftRefuses = original;
    };

    const { runProject } = await import('../src/orchestrator.js');
    const result = await runProject({
      projectId,
      intake: INTAKE,
      store,
      workspacesRoot: root,
      autonomyMode: 'full_autonomous',
      onProgress: (e) => {
        if (e.phase === 'repair' && e.detail.includes('written')) armAfterFirstRepair();
      },
    });

    // One repair landed, then the next cycle was refused and the run stopped.
    expect(result.repairsApplied).toBe(1);
    expect(result.outcome).toBe('blocked');
    expect(result.terminalDecision).toBe('rollback_to_last_accepted');

    // Two evaluations, not three: the refused cycle did not buy another one.
    const budget = await store.budgets.findOne({ _id: projectId });
    expect(budget?.used.reviewRejections).toBe(2);
    expect(repairCalls).toEqual(['QA-501']);
  });
});
