/**
 * Authorising a visual refinement against real durable state and a real
 * canonical Git workspace.
 *
 * What is proven here is everything that happens before any model is invoked:
 * the exact canonical build and its promotion, the exact review of its exact
 * screenshots, the exact source at the exact rendered commit, the one durable
 * budget slot, the replay ledger, and the human-review and release fences.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  VISUAL_REVIEW_FRAME_POLICY_VERSION,
  VISUAL_REVIEW_SCHEMA_VERSION,
  VisualRefinementSource,
  VisualRefinementSuccessorProvenance,
  type ArtifactRef,
  type VisualQualityReview,
} from '@statxai/contracts';
import { StateStore, createBudget, type FrontendBackendBuildBindingDocument, type ReleasePublicationStatus } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace, contentHash } from '@statxai/workspace';
import {
  FrontendBackendBuildLineageConflict,
  finalizeBindingPromoted,
  prepareFrontendBackendBuildBinding,
} from '../src/run-binding/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import { promotionMarker } from '../src/job-promotion/frontend-backend.js';
import {
  VISUAL_REFINEMENT_SOURCE_ARTIFACT,
  VisualRefinementAuthorityInvalid,
  authorizeVisualRefinement,
  visualRefinementIntentId,
  type AuthorizeVisualRefinementInput,
} from '../src/visual-refinement/authorize.js';
import type { VisualQualityReviewOutcome } from '../src/phases/visual-review.js';

let store: StateStore;
let registry: ArtifactRegistry;
let workspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-refine-authority-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const collection of [store.frontendBackendBuildBindings, store.visualRefinementIntents, store.promotions, store.releasePublications, store.projects, store.budgets, store.artifacts]) {
    await collection.deleteMany({ projectId: { $regex: /^proj_vra_/ } } as never);
  }
  await store.projects.deleteMany({ _id: { $regex: /^proj_vra_/ } } as never);
  await store.budgets.deleteMany({ _id: { $regex: /^proj_vra_/ } } as never);
});

const LOW = {
  overallScore: 62,
  scores: { composition: 58, typography: 72, spacingRhythm: 55, hierarchy: 66, brandDistinctiveness: 50, assetQuality: 60, conversionClarity: 75, mobileQuality: 52 },
  summary: 'Generic.',
  routeReviews: [],
  strengths: [],
  issues: [{ id: 'VQ-001', route: '/', viewports: ['mobile' as const], dimension: 'mobileQuality' as const, severity: 'major' as const, problem: 'Stacked.', direction: 'Recompose.' }],
  antiPatterns: [],
  refinementPriorities: [],
};

async function commitFiles(ws: ProjectWorkspace, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(ws.root, path, '..'), { recursive: true });
    await writeFile(join(ws.root, path), contents, 'utf8');
  }
  return (await ws.commit(message))!;
}

interface Fixture {
  readonly projectId: string;
  readonly ws: ProjectWorkspace;
  readonly b0: FrontendBackendBuildBindingDocument;
  readonly promotionCommitSha: string;
  readonly input: (over?: { review?: VisualQualityReview['assessment']; status?: VisualQualityReview['status']; sourceCommit?: string; complete?: boolean }) => Promise<AuthorizeVisualRefinementInput>;
}

/** A project whose canonical build B0 is promoted exactly as the lifecycle would leave it: receipt, marker commit, finalised binding. */
async function promotedProject(projectId: string): Promise<Fixture> {
  const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
  await store.projects.insertOne({ _id: projectId, state: 'validating', autonomyMode: 'full_autonomous', reviewCycle: 0, createdAt: new Date(), updatedAt: new Date() });
  await createBudget(store, projectId);

  const businessProfileRef = await registry.put(projectId, 'business-profile', { businessName: 'Harrowgate Joinery' });
  const sitePlanRef = await registry.put(projectId, 'site-plan', { sitemap: { pages: [{ route: '/' }] } });
  const jobSpec = createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef });
  const b0 = await prepareFrontendBackendBuildBinding(store, {
    projectId,
    runIntentHash: 'intent',
    businessProfileRef,
    sitePlanRef,
    jobSpec,
    specificationBaseCommit: null,
  });
  const promotionId = `promotion-${projectId}`;
  const promotionCommitSha = await commitFiles(
    ws,
    { 'app/app/page.tsx': 'export default function Home(){return "B0"}', 'app/components/site/hero.tsx': 'export const Hero = 0;', 'app/package.json': '{}' },
    `Promote accepted frontend/backend candidate\n\n${promotionMarker(promotionId)}`,
  );
  await store.promotions.insertOne({ _id: promotionId, projectId, jobId: b0.jobId, attempt: 1, output: { name: 'x', version: 1 }, baseCommit: null, status: 'committed', commitSha: promotionCommitSha, createdAt: new Date(), updatedAt: new Date() });
  await finalizeBindingPromoted(store, b0._id, { promotionId, promotionCommitSha });
  const promoted = (await store.frontendBackendBuildBindings.findOne({ _id: b0._id }))!;

  const input: Fixture['input'] = async (over = {}) => {
    const screenshotSet = await registry.put(projectId, 'screenshot-set', { captures: [] });
    const review: VisualQualityReview = {
      schemaVersion: VISUAL_REVIEW_SCHEMA_VERSION,
      framePolicyVersion: VISUAL_REVIEW_FRAME_POLICY_VERSION,
      screenshotSet,
      screenshotPolicyVersion: 'statxai-screenshots@1',
      subject: {
        projectId,
        sitePlan: sitePlanRef,
        sourceCommit: over.sourceCommit ?? (await ws.currentCommit()),
        exportDigest: 'e'.repeat(64),
        authority: { mode: 'job_lifecycle', buildBindingId: promoted._id, promotionId, promotionCommitSha },
      },
      status: over.status ?? 'reviewed',
      coverage: { expectedTargets: 3, reviewedTargets: 3, missing: [], notReviewed: [], complete: over.complete ?? true },
      frames: [],
      assessment: (over.status ?? 'reviewed') === 'reviewed' ? (over.review ?? LOW) : null,
      failure: null,
      reviewer: null,
    };
    const ref = await registry.put(projectId, 'visual-quality-review', review);
    const outcome: VisualQualityReviewOutcome = { ref, review };
    return {
      store,
      registry,
      workspace: ws,
      projectId,
      canonicalBindingId: promoted._id,
      canonicalPromotion: { promotionId, promotionCommitSha },
      screenshotSet,
      review: outcome,
    };
  };
  return { projectId, ws, b0: promoted, promotionCommitSha, input };
}

const used = async (projectId: string) => (await store.budgets.findOne({ _id: projectId }))!.used.visualRefinements;

describe('authorisation', () => {
  it('a low-quality review of the exact build authorises exactly one durable slot, one exact source snapshot and one intent', async () => {
    const f = await promotedProject('proj_vra_first');
    const input = await f.input();

    const result = await authorizeVisualRefinement(input);

    expect(result.kind).toBe('authorized');
    if (result.kind !== 'authorized') return;
    expect(result.replayed).toBe(false);
    expect(await used(f.projectId)).toBe(1);

    const { intent } = result;
    expect(intent._id).toBe(visualRefinementIntentId(f.projectId, f.b0._id));
    expect(intent).toMatchObject({
      predecessorBindingId: f.b0._id,
      lineageRootBindingId: f.b0._id,
      visualQualityReview: input.review.ref,
      screenshotSet: input.screenshotSet,
      refinementCycle: 1,
      policyVersion: 'statxai-visual-refinement-policy@1',
      sourceCommit: await f.ws.currentCommit(),
      budgetSlot: 1,
      jobId: intent.jobSpec.jobId,
    });

    // The source is exactly the model-owned source tracked at the rendered commit — nothing platform-owned.
    const source = VisualRefinementSource.parse(await registry.resolve(f.projectId, intent.source));
    expect(intent.source.name).toBe(VISUAL_REFINEMENT_SOURCE_ARTIFACT);
    expect(source).toMatchObject({ predecessorBindingId: f.b0._id, promotionCommitSha: f.promotionCommitSha, sourceCommit: intent.sourceCommit, refinementCycle: 1 });
    expect(source.files).toEqual([
      { path: 'app/page.tsx', contents: 'export default function Home(){return "B0"}' },
      { path: 'components/site/hero.tsx', contents: 'export const Hero = 0;' },
    ]);
    expect(source.filesDigest).toBe(contentHash(source.files));

    // The job pins exactly the source, review and screenshot set, and differs from B0.
    expect(intent.jobSpec.inputs).toMatchObject({ visualRefinementSource: intent.source, visualQualityReview: input.review.ref, screenshotSet: input.screenshotSet });
    expect(intent.jobId).not.toBe(f.b0.jobId);
  });

  it('a replay of the same build — even from a fresh evaluation with a newer review, after a restart — reuses the intent and spends nothing', async () => {
    const f = await promotedProject('proj_vra_replay');
    const first = await authorizeVisualRefinement(await f.input());
    // "Restart": nothing in memory survives; a newer, even high-scoring, review of the same build arrives.
    const again = await authorizeVisualRefinement(await f.input({ review: { ...LOW, overallScore: 95, issues: [], scores: { ...LOW.scores, mobileQuality: 95, composition: 95 } } }));

    expect(first.kind).toBe('authorized');
    expect(again).toMatchObject({ kind: 'authorized', replayed: true });
    if (first.kind !== 'authorized' || again.kind !== 'authorized') return;
    expect(again.intent).toEqual(first.intent);
    expect(await used(f.projectId)).toBe(1);
    expect(await store.visualRefinementIntents.countDocuments({ projectId: f.projectId })).toBe(1);
    expect(await store.artifacts.countDocuments({ projectId: f.projectId, name: VISUAL_REFINEMENT_SOURCE_ARTIFACT })).toBe(1);
  });

  it('concurrent authorisations of the same build converge on one intent and one spend', async () => {
    const f = await promotedProject('proj_vra_race');
    const [a, b] = await Promise.all([authorizeVisualRefinement(await f.input()), authorizeVisualRefinement(await f.input())]);
    expect(a.kind === 'authorized' && b.kind === 'authorized' && a.intent._id === b.intent._id).toBe(true);
    expect(await used(f.projectId)).toBe(1);
    expect(await store.visualRefinementIntents.countDocuments({ projectId: f.projectId })).toBe(1);
  });

  it('spends nothing and writes nothing when the review does not call for refinement, or cannot be used', async () => {
    const f = await promotedProject('proj_vra_skip');
    const good = { ...LOW, overallScore: 90, issues: [], scores: { ...LOW.scores, composition: 90, hierarchy: 90, mobileQuality: 90 } };
    expect(await authorizeVisualRefinement(await f.input({ review: good }))).toMatchObject({ kind: 'ineligible', decision: { reason: 'quality_sufficient' } });
    expect(await authorizeVisualRefinement(await f.input({ status: 'provider_failed' }))).toMatchObject({ kind: 'ineligible', decision: { reason: 'review_unusable' } });
    expect(await authorizeVisualRefinement(await f.input({ complete: false }))).toMatchObject({ kind: 'ineligible', decision: { reason: 'coverage_incomplete' } });
    expect(await used(f.projectId)).toBe(0);
    expect(await store.visualRefinementIntents.countDocuments({ projectId: f.projectId })).toBe(0);
    expect(await store.artifacts.countDocuments({ projectId: f.projectId, name: VISUAL_REFINEMENT_SOURCE_ARTIFACT })).toBe(0);
  });

  it('a third refinement is impossible when two are spent', async () => {
    const f = await promotedProject('proj_vra_third');
    await store.budgets.updateOne({ _id: f.projectId }, { $set: { 'used.visualRefinements': 2 } });
    expect(await authorizeVisualRefinement(await f.input())).toMatchObject({ kind: 'ineligible', decision: { reason: 'budget_exhausted' } });
    expect(await store.visualRefinementIntents.countDocuments({ projectId: f.projectId })).toBe(0);
  });

  it('a budget that predates visual refinement refines nothing, and is not rewritten', async () => {
    const f = await promotedProject('proj_vra_legacy_budget');
    await store.budgets.updateOne({ _id: f.projectId }, { $unset: { 'used.visualRefinements': '', 'limits.visualRefinements': '' } });
    expect(await authorizeVisualRefinement(await f.input())).toMatchObject({ kind: 'ineligible', decision: { reason: 'budget_exhausted' } });
    expect((await store.budgets.findOne({ _id: f.projectId }))!.limits).not.toHaveProperty('visualRefinements');
  });
});

describe('source authority', () => {
  it('refines exactly the rendered source when a repair committed after promotion — never the stale promoted candidate', async () => {
    const f = await promotedProject('proj_vra_repaired');
    // A Luna repair commits straight to the canonical tree after promotion, as the run's repair phase does.
    const repaired = await commitFiles(f.ws, { 'app/app/page.tsx': 'export default function Home(){return "REPAIRED"}' }, 'Luna: repair cycle 1');
    expect(repaired).not.toBe(f.promotionCommitSha);

    const result = await authorizeVisualRefinement(await f.input());

    expect(result.kind).toBe('authorized');
    if (result.kind !== 'authorized') return;
    const source = VisualRefinementSource.parse(await registry.resolve(f.projectId, result.intent.source));
    expect(source.sourceCommit).toBe(repaired);
    expect(source.promotionCommitSha).toBe(f.promotionCommitSha);
    expect(source.files.find((file) => file.path === 'app/page.tsx')!.contents).toContain('REPAIRED');
    expect(result.intent.sourceCommit).toBe(repaired);
  });

  it('fails closed when canonical HEAD has moved past the commit the screenshots rendered', async () => {
    const f = await promotedProject('proj_vra_stale');
    const input = await f.input();
    await commitFiles(f.ws, { 'app/app/page.tsx': 'export default function Home(){return "LATER"}' }, 'a later change');
    await expect(authorizeVisualRefinement(input)).rejects.toBeInstanceOf(VisualRefinementAuthorityInvalid);
    expect(await used(f.projectId)).toBe(0);
  });

  it('fails closed when the rendered commit does not descend from the build’s own promotion', async () => {
    const f = await promotedProject('proj_vra_foreign');
    const input = await f.input({ sourceCommit: '0'.repeat(40) });
    await expect(authorizeVisualRefinement(input)).rejects.toBeInstanceOf(VisualRefinementAuthorityInvalid);
    expect(await used(f.projectId)).toBe(0);
  });

  it('reads the source at the rendered commit from Git, never the working tree', async () => {
    const f = await promotedProject('proj_vra_dirty');
    const input = await f.input();
    await writeFile(join(f.ws.root, 'app/app/page.tsx'), 'export default function Home(){return "UNCOMMITTED"}', 'utf8');
    const result = await authorizeVisualRefinement(input);
    expect(result.kind).toBe('authorized');
    if (result.kind !== 'authorized') return;
    const source = VisualRefinementSource.parse(await registry.resolve(f.projectId, result.intent.source));
    expect(JSON.stringify(source.files)).not.toContain('UNCOMMITTED');
  });

  it('fails closed on a review of a different build, a missing receipt, or a promotion the run does not hold', async () => {
    const f = await promotedProject('proj_vra_mismatch');
    const input = await f.input();
    const otherBuild = { ...input.review, review: { ...input.review.review, subject: { ...input.review.review.subject, authority: { ...input.review.review.subject.authority, buildBindingId: 'someone-else' } } } } as VisualQualityReviewOutcome;
    await expect(authorizeVisualRefinement({ ...input, review: otherBuild })).rejects.toBeInstanceOf(VisualRefinementAuthorityInvalid);
    await expect(authorizeVisualRefinement({ ...input, canonicalPromotion: { promotionId: 'other', promotionCommitSha: f.promotionCommitSha } })).rejects.toBeInstanceOf(VisualRefinementAuthorityInvalid);
    await store.promotions.updateOne({ _id: f.b0.promotionId! }, { $set: { status: 'prepared' } });
    await expect(authorizeVisualRefinement(input)).rejects.toBeInstanceOf(VisualRefinementAuthorityInvalid);
    expect(await used(f.projectId)).toBe(0);
  });
});

describe('lineage', () => {
  it('refuses a build that is not the exact tip of the one active lineage, and a successor slot stays one per predecessor across reasons', async () => {
    const f = await promotedProject('proj_vra_tip');
    const input = await f.input();
    const authorized = await authorizeVisualRefinement(input);
    if (authorized.kind !== 'authorized') throw new Error('expected authorisation');
    const { intent } = authorized;

    // The authorised successor, prepared as the orchestrator prepares it.
    const provenance = VisualRefinementSuccessorProvenance.parse({ kind: 'visual_refinement', visualQualityReview: intent.visualQualityReview, screenshotSet: intent.screenshotSet, refinementCycle: intent.refinementCycle });
    const successor = await prepareFrontendBackendBuildBinding(store, {
      projectId: f.projectId,
      runIntentHash: 'intent',
      businessProfileRef: f.b0.businessProfile,
      sitePlanRef: f.b0.sitePlan,
      jobSpec: intent.jobSpec,
      specificationBaseCommit: await f.ws.currentCommit(),
      lineage: { predecessorBindingId: f.b0._id, provenance },
    });
    expect(successor._id).toBe(intent.successorBindingId);
    expect(successor.successorProvenance).toEqual(provenance);
    expect(successor.lineageRootBindingId).toBe(f.b0._id);

    // B0 is no longer the tip: nothing more may be authorised against it.
    await store.visualRefinementIntents.deleteMany({ projectId: f.projectId });
    await expect(authorizeVisualRefinement(input)).rejects.toBeInstanceOf(VisualRefinementAuthorityInvalid);

    // And a replan cannot branch from the same predecessor.
    const replanSpec = { ...createFrontendBackendJobSpec({ projectId: f.projectId, businessProfileRef: f.b0.businessProfile, sitePlanRef: f.b0.sitePlan }), objective: 'replan' };
    await expect(
      prepareFrontendBackendBuildBinding(store, {
        projectId: f.projectId,
        runIntentHash: 'intent',
        businessProfileRef: f.b0.businessProfile,
        sitePlanRef: f.b0.sitePlan,
        jobSpec: replanSpec,
        specificationBaseCommit: null,
        lineage: { predecessorBindingId: f.b0._id, provenance: { kind: 'replan', replanDecision: { name: 'replan-decision', version: 1 } as ArtifactRef & { name: 'replan-decision' } } },
      }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildLineageConflict);
  });
});

describe('fences', () => {
  it('awaiting human review prevents refinement — a fresh authorisation and a replay alike — and spends nothing', async () => {
    const f = await promotedProject('proj_vra_human');
    const input = await f.input();
    await store.projects.updateOne({ _id: f.projectId }, { $set: { state: 'awaiting_human_review' } });
    expect(await authorizeVisualRefinement(input)).toMatchObject({ kind: 'ineligible', decision: { reason: 'awaiting_human_review' } });
    expect(await used(f.projectId)).toBe(0);

    await store.projects.updateOne({ _id: f.projectId }, { $set: { state: 'validating' } });
    expect((await authorizeVisualRefinement(input)).kind).toBe('authorized');
    await store.projects.updateOne({ _id: f.projectId }, { $set: { state: 'awaiting_human_review' } });
    expect(await authorizeVisualRefinement(input)).toMatchObject({ kind: 'ineligible', decision: { reason: 'awaiting_human_review' } });
  });

  it.each(['prepared', 'publishing', 'retry_authorized', 'committed'] as ReleasePublicationStatus[])('an existing %s release publication for the lineage prevents refinement', async (status) => {
    const f = await promotedProject(`proj_vra_release_${status}`);
    await store.releasePublications.insertOne({
      _id: `release-${f.projectId}`,
      projectId: f.projectId,
      status,
      ...(status === 'committed' ? {} : { active: true }),
      releaseAuthorization: { name: 'release-authorization', version: 1 },
      baseCommit: null,
      buildAuthority: { lineageRootBindingId: f.b0._id, canonicalBindingId: f.b0._id, promotionId: f.b0.promotionId! },
    } as never);
    expect(await authorizeVisualRefinement(await f.input())).toMatchObject({ kind: 'ineligible', decision: { reason: 'release_publication_exists' } });
    expect(await used(f.projectId)).toBe(0);
    await store.releasePublications.deleteMany({ projectId: f.projectId });
  });
});
