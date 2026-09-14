/**
 * Durable post-promotion outer `runProject` recovery (Phase 5q).
 *
 * Every scenario crashes a real `job_lifecycle` run at an exact point after its
 * build promoted, then invokes `runProject` again for the same project — a new
 * invocation with its own objects, sharing nothing with the first beyond what
 * is genuinely durable. Crashes are injected where the real run would die
 * (the first compile evaluation performs, the publish phase, the release
 * commit, the provider call) rather than hand-built, so the durable state under
 * test is the state a real crash leaves.
 *
 * Mocks mirror the replan-lineage suite: agents, the compiler, gates and the
 * Vercel calls are faked; `JobEngine`, `JobRunner`, the Terra handler, 5g-1,
 * 5g-2, 5h, 5p and `runProject` itself are real.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import type { SitePlan } from '@statxai/contracts';
import { StateStore, spend } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import {
  ActiveContinuationAwaitingHumanReview,
  ActiveContinuationCorrupt,
  ActiveContinuationIntentConflict,
  ActiveContinuationNotPromoted,
  ActiveContinuationWorkspaceDirty,
  LegacyDirectActiveLineageConflict,
  resolvePostPromotionRecovery,
} from '../src/run-recovery/frontend-backend.js';
import { authorizeReleaseRepublication, ReleasePublicationReconciliationRequired } from '../src/release-publication/publication.js';
import { findActiveLineageRoot } from '../src/run-binding/frontend-backend.js';
import { fakeExport } from './support/site-model-export.js';

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

// -- knobs and counters -------------------------------------------------------
let reviewSequence: { qualityScore: number; blocking: boolean; issues: ReviewIssue[] }[];
let adjudications: { action: string; reason: string; defectIds: string[] | null; objective: null; scope: 'page' | 'design' | 'site' | null }[];
let revisedPlans: SitePlan[];
let deployConfigured = false;
let crashOnCompile = 0;
let crashOnDeploymentConfiguredCall = 0;
let crashDeploy = false;
let calls = { plan: 0, terra: 0, replan: 0, review: 0, approval: 0, compile: 0, deploymentConfigured: 0, deploy: 0 };
let reviewedPlans: SitePlan[] = [];
let reviewedProfiles: { businessName: string }[] = [];

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
    sitemap: {
      pages: routes.map(([route, title]) => ({
        route, title, metaDescription: 'd', goal: 'g', primaryAction: 'call',
        sections: [{ id: 's1', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }],
      })),
    },
    acceptanceCriteria: ['a', 'b', 'c'],
  }) as unknown as SitePlan;

const P0 = planWith([['/', 'Home'], ['/services', 'Services'], ['/about', 'About']]);
const P1 = planWith([['/', 'Home'], ['/about', 'About']]);
const P2 = planWith([['/', 'Home']]);
const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => {
      calls.plan += 1;
      return { value: P0, model: 'gpt-5.6-sol', ...usage };
    }),
    routeBuild: vi.fn(async () => ({
      value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    buildSite: vi.fn(async (_c: unknown, profile: { businessName: string }, plan: SitePlan) => {
      calls.terra += 1;
      // Varies by business and build, so a genuinely new generation is never a
      // byte-identical candidate that promotion would rightly refuse as empty.
      const files = plan.sitemap.pages.map((p) => ({
        path: p.route === '/' ? 'app/page.tsx' : `app${p.route}/page.tsx`,
        contents: `export default function P(){return ${JSON.stringify(`${profile.businessName} ${calls.terra}`)}}`,
      }));
      return { value: { files, notes: '' }, model: 'gpt-5.6-terra', ...usage };
    }),
    reviewSite: vi.fn(async (_c: unknown, profile: { businessName: string }, plan: SitePlan) => {
      calls.review += 1;
      reviewedPlans.push(plan);
      reviewedProfiles.push(profile);
      const r = next(reviewSequence);
      return {
        value: { decision: r.blocking ? 'reject' : 'accept', qualityScore: r.qualityScore, blocking: r.blocking, issues: r.issues, summary: 's' },
        model: 'gpt-5.6-terra',
        ...usage,
      };
    }),
    recommendApproval: vi.fn(async () => {
      calls.approval += 1;
      return { value: { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: ['QA-004'] }, model: 'gpt-5.6-sol', ...usage };
    }),
    adjudicate: vi.fn(async () => ({ value: next(adjudications), model: 'gpt-5.6-sol', ...usage })),
    replanSite: vi.fn(async () => {
      calls.replan += 1;
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
    // Isolated validation compiles too, in its own workspace. Only compiles of
    // the canonical workspace — which only evaluation performs — are counted
    // and crashed, so a "crash after promotion" really is after promotion.
    buildSite: vi.fn(async (siteRoot: string) => {
      if (siteRoot.startsWith(workspacesRoot)) {
        calls.compile += 1;
        if (crashOnCompile === calls.compile) throw new Error('simulated crash during evaluation');
      }
      return { ok: true, durationMs: 5, output: '', outDir: '/out' };
    }),
    // A faithful export of the editable site model the run pinned, so the real site-model gate measures it.
    readBuiltFiles: vi.fn(async (siteRoot: string) => fakeExport(store, siteRoot, [{ path: 'index.html', contents: '<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Harrowgate Joinery</h1></main></body></html>' }], '<h1>Harrowgate Joinery</h1>')),
    readExportFiles: vi.fn(async () => []),
    readSourceFiles: vi.fn(async () => [{ path: 'app/page.tsx', contents: 'x' }]),
    deploymentConfigured: vi.fn(() => {
      calls.deploymentConfigured += 1;
      if (crashOnDeploymentConfiguredCall === calls.deploymentConfigured) throw new Error('simulated crash before the receipt');
      return deployConfigured;
    }),
    deploySite: vi.fn(async (_root: string, projectId: string, options: { meta?: Record<string, string> }) => {
      calls.deploy += 1;
      if (crashDeploy) throw new Error('connection reset before the response arrived');
      return {
        url: `https://${projectId}-${calls.deploy}.vercel.app`,
        deploymentId: `dpl_recovery_${calls.deploy}`,
        rollbackRef: null,
        fileCount: 1,
        durationMs: 1,
        meta: { ...(options.meta ?? {}) },
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
const OTHER_INTAKE = { ...INTAKE, businessName: 'Knaresborough Kitchens' };

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
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5q-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5q-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
  adjudications = [{ action: 'block', reason: 'unused', defectIds: null, objective: null, scope: null }];
  revisedPlans = [P1];
  deployConfigured = false;
  crashOnCompile = 0;
  crashOnDeploymentConfiguredCall = 0;
  crashDeploy = false;
  resetCalls();
  for (const name of [
    'jobs', 'audit_log', 'artifacts', 'projects', 'budgets', 'defect_budgets', 'job_promotions',
    'frontend_backend_build_bindings', 'release_publications', 'runs', 'run_events',
  ]) {
    await store.db.collection(name).deleteMany({});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function resetCalls(): void {
  calls = { plan: 0, terra: 0, replan: 0, review: 0, approval: 0, compile: 0, deploymentConfigured: 0, deploy: 0 };
  reviewedPlans = [];
  reviewedProfiles = [];
}

const events: string[] = [];
const run = async (projectId: string, over: { intake?: unknown; mode?: 'job_lifecycle' | 'legacy_direct' } = {}) => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({
    projectId,
    intake: over.intake ?? INTAKE,
    store,
    workspacesRoot,
    autonomyMode: 'full_autonomous',
    frontendBackendExecutionMode: over.mode ?? 'job_lifecycle',
    validationWorkspacesRoot,
    onProgress: (e) => events.push(e.detail),
  });
};

/** A real run that promotes, then dies at its first evaluation compile. */
const crashAfterPromotion = async (projectId: string) => {
  crashOnCompile = 1;
  await expect(run(projectId)).rejects.toThrow('simulated crash during evaluation');
  crashOnCompile = 0;
  resetCalls();
  events.length = 0;
};

const bindingsOf = (projectId: string) => store.frontendBackendBuildBindings.find({ projectId }).toArray();
const headOf = async (projectId: string) => (await ProjectWorkspace.open(projectId, workspacesRoot)).currentCommit();
const countArtifacts = (projectId: string, name: string) => store.artifacts.countDocuments({ projectId, name });

/** Everything a destructive reset would change — compared before and after a refusal. */
const snapshot = async (projectId: string) => ({
  project: await store.projects.findOne({ _id: projectId }),
  budget: await store.budgets.findOne({ _id: projectId }),
  bindings: (await bindingsOf(projectId)).length,
  head: await headOf(projectId),
});

// ---------------------------------------------------------------------------

describe('post-promotion recovery re-enters evaluation', () => {
  it('continues the promoted build without discovery, planning, build, validation, acceptance or promotion', async () => {
    const projectId = 'proj_5q_basic';
    await crashAfterPromotion(projectId);

    const [binding] = await bindingsOf(projectId);
    expect(binding!.status).toBe('promoted');
    expect(await findActiveLineageRoot(store, projectId)).not.toBeNull();
    const profileVersions = await countArtifacts(projectId, 'business-profile');
    const jobs = await store.jobs.countDocuments({ projectId });
    const promotions = await store.promotions.countDocuments({ projectId });

    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    expect(events).toContain(
      `Recovering unfinished run: lineage ${binding!._id}, canonical build ${binding!._id}, promotion ${binding!.promotionId}`,
    );
    expect(calls.plan).toBe(0);
    expect(calls.terra).toBe(0);
    expect(calls.compile).toBe(1); // evaluation, and only evaluation, ran again
    expect(calls.review).toBe(1);
    // Re-evaluation made fresh, exact visual evidence, bound to the recovered canonical build.
    const sets = await store.artifacts.find({ projectId, name: 'screenshot-set' }).toArray();
    const reviews = await store.artifacts.find({ projectId, name: 'visual-quality-review' }).toArray();
    expect(sets).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!.data as { screenshotSet: { version: number }; subject: { authority: unknown } };
    expect(review.screenshotSet.version).toBe(sets[0]!.version);
    expect(review.subject.authority).toEqual({ mode: 'job_lifecycle', buildBindingId: binding!._id, promotionId: binding!.promotionId, promotionCommitSha: binding!.promotionCommitSha });
    expect(await countArtifacts(projectId, 'business-profile')).toBe(profileVersions);
    expect(await store.jobs.countDocuments({ projectId })).toBe(jobs);
    expect(await store.promotions.countDocuments({ projectId })).toBe(promotions);
    expect(await bindingsOf(projectId)).toHaveLength(1);

    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('released');
    expect(await findActiveLineageRoot(store, projectId)).toBeNull();
  });

  it('reuses the exact bound profile and plan, not newer artifacts', async () => {
    const projectId = 'proj_5q_exact_refs';
    await crashAfterPromotion(projectId);

    // Unrelated newer versions a "latest" lookup would pick up.
    await registry.put(projectId, 'business-profile', { ...INTAKE, businessName: 'Not The Bound Profile' });
    await registry.put(projectId, 'site-plan', P2);

    const result = await run(projectId);
    expect(result.outcome).toBe('released');
    expect(reviewedProfiles[0]!.businessName).toBe('Harrowgate Joinery');
    expect(reviewedPlans[0]!.sitemap.pages.map((p) => p.route)).toEqual(['/', '/services', '/about']);
  });

  it('after two replans, evaluates the exact B2 plan with no replan or build before it', async () => {
    const projectId = 'proj_5q_two_replans';
    const blocking = { qualityScore: 60, blocking: true, issues: [issue({ id: 'QA-010', category: 'structure', severity: 'P1', reason: 'No way to make an enquiry.' })] };
    reviewSequence = [blocking, blocking, { qualityScore: 92, blocking: false, issues: [issue()] }];
    const replan = { action: 'replan', reason: 'The plan carries a route the business does not offer.', defectIds: null, objective: null, scope: 'site' as const };
    adjudications = [replan, replan, { action: 'block', reason: 'unused', defectIds: null, objective: null, scope: null }];
    revisedPlans = [P1, P2];

    crashOnCompile = 3; // after B2 promoted, at its first evaluation
    await expect(run(projectId)).rejects.toThrow('simulated crash during evaluation');
    crashOnCompile = 0;
    resetCalls();

    const bindings = await bindingsOf(projectId);
    expect(bindings).toHaveLength(3);
    const b2 = bindings.find((b) => bindings.every((o) => o.predecessorBindingId !== b._id))!;

    reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    expect(calls.replan).toBe(0);
    expect(calls.terra).toBe(0);
    expect(reviewedPlans[0]!.sitemap.pages.map((p) => p.route)).toEqual(['/']);
    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('released');
    expect(b2.sitePlan.version).toBeGreaterThan(bindings.find((b) => b.predecessorBindingId === undefined)!.sitePlan.version);
  });

  it('keeps durable budgets, deriving the review cycle from the spent allowance', async () => {
    const projectId = 'proj_5q_budgets';
    await crashAfterPromotion(projectId);

    await spend(store, projectId, 'reviewRejections');
    const before = await store.budgets.findOne({ _id: projectId });
    expect(before!.used.reviewRejections).toBe(1);

    await run(projectId);

    const after = await store.budgets.findOne({ _id: projectId });
    expect(after!.limits).toEqual(before!.limits);
    expect(after!.used.reviewRejections).toBe(1); // not reset
    const review = await store.artifacts.find({ projectId, name: 'visual-review' }).sort({ version: -1 }).limit(1).next();
    expect((review!.data as { reviewCycle: number }).reviewCycle).toBe(1);
  });

  it('evaluates a clean committed repair descendant — HEAD need not be the promotion commit', async () => {
    const projectId = 'proj_5q_repaired';
    await crashAfterPromotion(projectId);

    const [binding] = await bindingsOf(projectId);
    const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
    await ws.writeSiteFiles([{ path: 'app/page.tsx', contents: 'export default function P(){return "repaired"}' }]);
    await ws.commit('Luna: repair cycle 0');
    expect(await ws.currentCommit()).not.toBe(binding!.promotionCommitSha);

    const result = await run(projectId);
    expect(result.outcome).toBe('released');
    expect(calls.compile).toBe(1);
  });

  it('tolerates the harness decision records a crash leaves uncommitted', async () => {
    const projectId = 'proj_5q_decisions_dirt';
    await crashAfterPromotion(projectId);
    const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
    await ws.materialiseArtifact('decisions/adjudication-00.json', { interrupted: true });

    expect((await run(projectId)).outcome).toBe('released');
  });
});

describe('recovery refuses without destroying unfinished work', () => {
  it('malformed intake still reports itself with no side effect', async () => {
    const projectId = 'proj_5q_bad_intake';
    await crashAfterPromotion(projectId);
    const before = await snapshot(projectId);

    const result = await run(projectId, { intake: { businessName: '' } });

    expect(result.outcome).toBe('intake_insufficient');
    expect(await snapshot(projectId)).toEqual(before);
    expect(await findActiveLineageRoot(store, projectId)).not.toBeNull();
  });

  it('a different run intent is an explicit conflict — no discovery, reset, binding or Git change', async () => {
    const projectId = 'proj_5q_other_intent';
    await crashAfterPromotion(projectId);
    const before = await snapshot(projectId);

    await expect(run(projectId, { intake: OTHER_INTAKE })).rejects.toBeInstanceOf(ActiveContinuationIntentConflict);

    expect(calls.plan).toBe(0);
    expect(calls.compile).toBe(0);
    expect(await snapshot(projectId)).toEqual(before);
  });

  it('an interrupted uncommitted repair fails closed and is left exactly where it is', async () => {
    const projectId = 'proj_5q_dirty';
    await crashAfterPromotion(projectId);
    const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
    await ws.writeSiteFiles([{ path: 'app/page.tsx', contents: 'export default function P(){return "half repaired"}' }]);
    const before = await snapshot(projectId);

    await expect(run(projectId)).rejects.toBeInstanceOf(ActiveContinuationWorkspaceDirty);

    expect(calls.compile).toBe(0);
    expect(await snapshot(projectId)).toEqual(before);
    expect(await readFile(join(ws.siteRoot, 'app/page.tsx'), 'utf8')).toContain('half repaired');
  });

  it('a run parked for human review is never re-evaluated', async () => {
    const projectId = 'proj_5q_human_review';
    await crashAfterPromotion(projectId);
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'awaiting_human_review' } });

    await expect(run(projectId)).rejects.toBeInstanceOf(ActiveContinuationAwaitingHumanReview);
    expect(calls.compile).toBe(0);
    expect(calls.approval).toBe(0);
  });

  it.each([
    ['binding promotion commit', async (projectId: string) => {
      const [b] = await bindingsOf(projectId);
      await store.frontendBackendBuildBindings.updateOne({ _id: b!._id }, { $set: { promotionCommitSha: 'f'.repeat(40) } });
    }],
    ['promotion receipt', async (projectId: string) => {
      await store.promotions.updateOne({ projectId }, { $set: { status: 'prepared' } });
    }],
    ['promotion fence', async (projectId: string) => {
      await store.jobs.updateOne({ projectId }, { $set: { 'promotionFence.promotionId': 'promotion-elsewhere' } });
    }],
    ['Git marker', async (projectId: string) => {
      // Binding and receipt agree with each other, but no commit carries that sha.
      await store.frontendBackendBuildBindings.updateOne({ projectId }, { $set: { promotionCommitSha: 'e'.repeat(40) } });
      await store.promotions.updateOne({ projectId }, { $set: { commitSha: 'e'.repeat(40) } });
    }],
  ])('corrupt %s fails closed before discovery', async (_label, corrupt) => {
    const projectId = `proj_5q_corrupt_${_label.toLowerCase().replace(/\W+/g, '_')}`;
    await crashAfterPromotion(projectId);
    await corrupt(projectId);
    const before = await snapshot(projectId);

    await expect(run(projectId)).rejects.toBeInstanceOf(ActiveContinuationCorrupt);
    expect(calls.plan).toBe(0);
    expect(calls.compile).toBe(0);
    expect(await snapshot(projectId)).toEqual(before);
  });

  it('a non-promoted tip is never treated as canonical post-promotion authority', async () => {
    const projectId = 'proj_5q_unpromoted_tip';
    await crashAfterPromotion(projectId);
    const [b0] = await bindingsOf(projectId);
    // A successor still in flight: prepared, so Phase 5k owns it when it runs.
    const successor = {
      ...b0!,
      _id: `${b0!._id}-successor`,
      status: 'prepared' as const,
      jobId: 'job-successor',
      predecessorBindingId: b0!._id,
      replanDecision: { name: 'replan-decision', version: 1 },
      promotionId: null,
      promotionCommitSha: null,
      updatedAt: new Date(),
    };
    // Only the root carries the active marker.
    delete successor.activeLineage;
    await store.frontendBackendBuildBindings.insertOne(successor);

    await expect(
      resolvePostPromotionRecovery({
        store, registry, workspacesRoot, projectId,
        runIntentHash: b0!.runIntentHash,
      }),
    ).rejects.toBeInstanceOf(ActiveContinuationNotPromoted);
  });

  it('legacy_direct cannot bypass an unfinished job_lifecycle lineage', async () => {
    const projectId = 'proj_5q_legacy';
    await crashAfterPromotion(projectId);
    const before = await snapshot(projectId);

    await expect(run(projectId, { mode: 'legacy_direct' })).rejects.toBeInstanceOf(LegacyDirectActiveLineageConflict);
    expect(calls.plan).toBe(0);
    expect(calls.terra).toBe(0);
    expect(await snapshot(projectId)).toEqual(before);
  });
});

describe('Phase 5k keeps precedence', () => {
  it('a prepared build resumes through 5k, not post-promotion recovery', async () => {
    const projectId = 'proj_5q_5k_precedence';
    // Crash the first run while its build is still in flight: Terra throws, the
    // lifecycle does not promote, and the binding stays prepared.
    const agents = await import('@statxai/agents');
    vi.mocked(agents.buildSite).mockImplementationOnce(async () => {
      throw new Error('terra unavailable');
    });
    const first = await run(projectId);
    expect(first.outcome).toBe('blocked');
    expect((await bindingsOf(projectId))[0]!.status).toBe('prepared');
    events.length = 0;

    await run(projectId).catch(() => undefined);
    expect(events.some((e) => e.startsWith('Resuming active frontend_backend build binding'))).toBe(true);
    expect(events.some((e) => e.startsWith('Recovering unfinished run'))).toBe(false);
  });
});

describe('an existing release is stronger authority than re-evaluation', () => {
  it('authorisation persisted but no receipt yet: evaluation reruns and exactly one linked release publishes', async () => {
    const projectId = 'proj_5q_auth_no_receipt';
    deployConfigured = true;
    // seekRelease calls it twice; the third call is the publish phase, before
    // any receipt exists.
    crashOnDeploymentConfiguredCall = 3;
    await expect(run(projectId)).rejects.toThrow('simulated crash before the receipt');
    crashOnDeploymentConfiguredCall = 0;
    expect(await countArtifacts(projectId, 'release-authorization')).toBe(1);
    expect(await store.releasePublications.countDocuments({ projectId })).toBe(0);
    expect(calls.deploy).toBe(0);
    resetCalls();

    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    expect(calls.compile).toBe(1);
    expect(calls.approval).toBe(1);
    expect(calls.deploy).toBe(1);
    // The unused first authorisation had no effect; the release is the second.
    expect(await countArtifacts(projectId, 'release-authorization')).toBe(2);
    const receipts = await store.releasePublications.find({ projectId }).toArray();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.releaseAuthorization.version).toBe(2);
    expect(receipts[0]!.buildAuthority?.lineageRootBindingId).toBe((await bindingsOf(projectId))[0]!._id);
  });

  it('prepared receipt: publication resumes with the same authorisation and no re-evaluation', async () => {
    const projectId = 'proj_5q_prepared_receipt';
    deployConfigured = true;
    const original = ProjectWorkspace.prototype.commit;
    let armed = true;
    vi.spyOn(ProjectWorkspace.prototype, 'commit').mockImplementation(async function (this: ProjectWorkspace, message: string) {
      if (armed && message.startsWith('Harness: release-authorized revision')) {
        armed = false;
        throw new Error('simulated crash at the release commit');
      }
      return original.call(this, message);
    });
    await expect(run(projectId)).rejects.toThrow('simulated crash at the release commit');
    const [receipt] = await store.releasePublications.find({ projectId }).toArray();
    expect(receipt!.status).toBe('prepared');
    resetCalls();

    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    expect(calls.compile).toBe(0);
    expect(calls.approval).toBe(0);
    expect(calls.deploy).toBe(1);
    expect(await countArtifacts(projectId, 'release-authorization')).toBe(1);
    const after = await store.releasePublications.findOne({ _id: receipt!._id });
    expect(after!.status).toBe('committed');
    expect(result.qualityScore).toBe(92);
    // Exactly the gates the original evaluation certified — the site-model gate among them.
    expect(result.manifest?.checks).toEqual(['build', 'claims', 'site-model']);
  });

  it('publishing receipt: reconciliation required, and nothing is re-run or re-sent', async () => {
    const projectId = 'proj_5q_publishing';
    deployConfigured = true;
    crashDeploy = true;
    await expect(run(projectId)).rejects.toBeInstanceOf(ReleasePublicationReconciliationRequired);
    crashDeploy = false;
    resetCalls();

    await expect(run(projectId)).rejects.toBeInstanceOf(ReleasePublicationReconciliationRequired);

    expect(calls.deploy).toBe(0);
    expect(calls.approval).toBe(0);
    expect(calls.compile).toBe(0);
    expect(await countArtifacts(projectId, 'release-authorization')).toBe(1);
    expect(await findActiveLineageRoot(store, projectId)).not.toBeNull();
  });

  it('retry_authorized receipt: exactly one more provider attempt, same release', async () => {
    const projectId = 'proj_5q_retry';
    deployConfigured = true;
    crashDeploy = true;
    await expect(run(projectId)).rejects.toBeInstanceOf(ReleasePublicationReconciliationRequired);
    crashDeploy = false;
    const [receipt] = await store.releasePublications.find({ projectId }).toArray();
    await authorizeReleaseRepublication(store, { projectId, releaseId: receipt!._id, attempt: receipt!.attempt, actor: 'operator', reason: 'reconciled: nothing deployed' });
    resetCalls();

    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    expect(calls.deploy).toBe(1);
    expect(calls.approval).toBe(0);
    expect(await countArtifacts(projectId, 'release-authorization')).toBe(1);
    expect((await store.releasePublications.findOne({ _id: receipt!._id }))!.status).toBe('committed');
  });

  it('committed receipt with a stale project: finishes without deploying, approving or authorising again', async () => {
    const projectId = 'proj_5q_committed';
    deployConfigured = true;
    expect((await run(projectId)).outcome).toBe('released');
    const [receipt] = await store.releasePublications.find({ projectId }).toArray();
    const [root] = await bindingsOf(projectId);

    // The crash window: receipt committed, but the terminal transaction —
    // project released + lineage released together — never ran.
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'releasing' } });
    await store.frontendBackendBuildBindings.updateOne({ _id: root!._id }, { $set: { activeLineage: true } });
    resetCalls();

    const result = await run(projectId);

    expect(result.outcome).toBe('released');
    expect(calls.deploy).toBe(0);
    expect(calls.approval).toBe(0);
    expect(calls.compile).toBe(0);
    expect(await countArtifacts(projectId, 'release-authorization')).toBe(1);
    expect(result.manifest?.deploymentId).toBe(receipt!.deploymentId);
    expect((await store.projects.findOne({ _id: projectId }))?.state).toBe('released');
    expect(await findActiveLineageRoot(store, projectId)).toBeNull();
  });

  it('a historical lineage’s committed release is never taken as the current one', async () => {
    const projectId = 'proj_5q_historical_receipt';
    deployConfigured = true;
    expect((await run(projectId)).outcome).toBe('released');
    const [historical] = await store.releasePublications.find({ projectId }).toArray();

    // A later, legitimate generation crashes after its own promotion.
    crashOnCompile = calls.compile + 1;
    await expect(run(projectId, { intake: OTHER_INTAKE })).rejects.toThrow('simulated crash during evaluation');
    crashOnCompile = 0;
    resetCalls();

    const result = await run(projectId, { intake: OTHER_INTAKE });

    expect(result.outcome).toBe('released');
    expect(calls.compile).toBe(1); // evaluated, not "finished" from the old receipt
    expect(calls.deploy).toBe(1);
    const receipts = await store.releasePublications.find({ projectId }).toArray();
    expect(receipts).toHaveLength(2);
    expect(await store.releasePublications.findOne({ _id: historical!._id })).toEqual(historical);
  });
});

describe('telemetry is not authority', () => {
  it('recovers identically with run history gone, under a new run id', async () => {
    const projectId = 'proj_5q_run_ids';
    const { launchRun } = await import('../src/run-service.js');
    const launch = (intake: unknown) =>
      launchRun({ store, intake, workspacesRoot, projectId, frontendBackendExecutionMode: 'job_lifecycle', validationWorkspacesRoot });

    crashOnCompile = 1;
    const first = await launch(INTAKE);
    expect(await first.completed).toBeNull();
    crashOnCompile = 0;

    await store.runs.deleteMany({});
    await store.runEvents.deleteMany({});

    const second = await launch(INTAKE);
    const result = await second.completed;
    expect(result?.outcome).toBe('released');
    expect(second.runId).not.toBe(first.runId);
  });

  it('the recovery module never reads runs, events, or ordering by time', async () => {
    const source = await readFile(join(SRC, 'run-recovery', 'frontend-backend.ts'), 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/runEvents|run_events|\.runs\b/);
    expect(code).not.toMatch(/\.sort\(|createdAt|updatedAt|preparedAt/);
  });
});

describe('terminal history does not block new work', () => {
  it('after a lineage finishes, a new generation runs the ordinary fresh path', async () => {
    const projectId = 'proj_5q_terminal_then_fresh';
    expect((await run(projectId)).outcome).toBe('released');
    expect(await findActiveLineageRoot(store, projectId)).toBeNull();
    resetCalls();

    const result = await run(projectId, { intake: OTHER_INTAKE });

    expect(result.outcome).toBe('released');
    expect(calls.plan).toBe(1);
    expect(calls.terra).toBe(1);
    const roots = (await bindingsOf(projectId)).filter((b) => b.predecessorBindingId === undefined);
    expect(roots).toHaveLength(2);
  });
});

