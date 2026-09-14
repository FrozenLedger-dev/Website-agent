/**
 * Canonical draft authority against real durable state.
 *
 * A run's exact promoted canonical build concludes as the project's one
 * unreleased draft in a single transaction — the draft written, the project
 * `draft`, the lineage's active slot released — and from then on the draft, not
 * a run, owns the project: its tip is re-proven structurally from its exact
 * root, Phase 5q reports it as concluded, a fresh generation cannot replace it,
 * a release cannot publish around it, and one exact operation at a time may
 * claim it. The release tip fence is exercised through the real publish phase.
 *
 * Integration: needs the Mongo replica set and a real (temp) Git workspace.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplanSuccessorProvenance, VisualRefinementSuccessorProvenance, type ArtifactRef, type BuildSuccessorProvenance } from '@statxai/contracts';
import { StateStore, type CanonicalDraftDocument, type FrontendBackendBuildBindingDocument } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import type { ReleaseAuthorization } from '@statxai/policy-engine';
import {
  FrontendBackendBuildLineageCorrupt,
  FrontendBackendCanonicalDraftOwnsProject,
  FrontendBackendReleaseBuildNotCurrent,
  deriveActiveLineageTip,
  deriveLineageTipFromRoot,
  finalizeBindingPromoted,
  prepareFrontendBackendBuildBinding,
} from '../src/run-binding/frontend-backend.js';
import { createFrontendBackendJobSpec, createFrontendBackendVisualRefinementJobSpec } from '../src/job-specs/frontend-backend.js';
import { promotionMarker } from '../src/job-promotion/frontend-backend.js';
import {
  CanonicalDraftAuthorityCorrupt,
  CanonicalDraftClaimConflict,
  CanonicalDraftClaimantInvalid,
  CanonicalDraftConclusionRefused,
  assertCanonicalDraftPromotionMarker,
  canonicalDraftId,
  claimCanonicalDraft,
  concludeCanonicalDraft,
  loadCurrentCanonicalDraft,
  releaseCanonicalDraftClaim,
} from '../src/canonical-draft/authority.js';
import {
  ActiveContinuationConcludedDraft,
  ActiveContinuationCorrupt,
  assertNoActiveLineageForLegacyDirect,
  resolvePostPromotionRecovery,
} from '../src/run-recovery/frontend-backend.js';
import { publishRelease, type ReleaseDeploymentGateway } from '../src/phases/publish.js';
import type { RunContext } from '../src/run-context.js';
import { runProject } from '../src/orchestrator.js';

let store: StateStore;
let registry: ArtifactRegistry;
let workspacesRoot: string;
let counter = 0;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-canonical-draft-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
});

const OWN = /^proj_draft_/;

beforeEach(async () => {
  for (const collection of [store.frontendBackendBuildBindings, store.canonicalDrafts, store.promotions, store.releasePublications, store.artifacts]) {
    await collection.deleteMany({ projectId: OWN } as never);
  }
  await store.projects.deleteMany({ _id: OWN } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ref = (name: string, version: number, contentHash?: string): ArtifactRef => ({ name, version, ...(contentHash ? { contentHash } : {}) });
const replan = (version: number): BuildSuccessorProvenance => ReplanSuccessorProvenance.parse({ kind: 'replan', replanDecision: ref('replan-decision', version) });
const visual = (cycle: number) =>
  VisualRefinementSuccessorProvenance.parse({
    kind: 'visual_refinement',
    visualQualityReview: ref('visual-quality-review', cycle, 'a'.repeat(64)),
    screenshotSet: ref('screenshot-set', cycle, 'b'.repeat(64)),
    refinementCycle: cycle,
  });

interface Project {
  readonly projectId: string;
  readonly ws: ProjectWorkspace;
  /** Prepare a build: an initial one, or a successor with its exact reason. */
  prepare(marker: string, lineage?: { predecessorBindingId: string; provenance: BuildSuccessorProvenance }): Promise<FrontendBackendBuildBindingDocument>;
  /** Promote exactly as the lifecycle leaves it: marker commit, committed receipt, finalised binding. */
  promote(binding: FrontendBackendBuildBindingDocument): Promise<FrontendBackendBuildBindingDocument>;
  reload(id: string): Promise<FrontendBackendBuildBindingDocument>;
}

async function project(state: 'building' | 'validating' = 'validating'): Promise<Project> {
  const projectId = `proj_draft_${(counter += 1)}`;
  const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
  await store.projects.insertOne({ _id: projectId, state, autonomyMode: 'full_autonomous', reviewCycle: 0, createdAt: new Date(), updatedAt: new Date() });
  const businessProfileRef = ref('business-profile', 1);
  const sitePlanRef = ref('site-plan', 1);
  let promotions = 0;

  return {
    projectId,
    ws,
    async prepare(marker, lineage) {
      const parsed = VisualRefinementSuccessorProvenance.safeParse(lineage?.provenance);
      const base = parsed.success
        ? createFrontendBackendVisualRefinementJobSpec({
            projectId,
            businessProfileRef,
            sitePlanRef,
            visualRefinementSourceRef: ref('visual-refinement-source', parsed.data.refinementCycle, 'c'.repeat(64)),
            visualQualityReviewRef: parsed.data.visualQualityReview,
            screenshotSetRef: parsed.data.screenshotSet,
          })
        : createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef });
      return prepareFrontendBackendBuildBinding(store, {
        projectId,
        runIntentHash: 'intent',
        businessProfileRef,
        sitePlanRef,
        jobSpec: { ...base, objective: `Build generation ${marker}.` },
        specificationBaseCommit: null,
        ...(lineage ? { lineage } : {}),
      });
    },
    async promote(binding) {
      promotions += 1;
      const promotionId = `promotion-${projectId}-${promotions}`;
      await mkdir(join(ws.root, 'app', 'app'), { recursive: true });
      await writeFile(join(ws.root, 'app', 'app', 'page.tsx'), `export default function Home(){return "${binding._id}"}`, 'utf8');
      const promotionCommitSha = (await ws.commit(`Promote accepted frontend/backend candidate\n\n${promotionMarker(promotionId)}`))!;
      await store.promotions.insertOne({ _id: promotionId, projectId, jobId: binding.jobId, attempt: 1, output: { name: 'x', version: 1 }, baseCommit: null, status: 'committed', commitSha: promotionCommitSha, createdAt: new Date(), updatedAt: new Date() });
      await finalizeBindingPromoted(store, binding._id, { promotionId, promotionCommitSha });
      return (await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))!;
    },
    async reload(id) {
      return (await store.frontendBackendBuildBindings.findOne({ _id: id }))!;
    },
  };
}

/** A project whose one active lineage has exactly one promoted build, B0. */
async function withPromotedRoot(): Promise<{ p: Project; b0: FrontendBackendBuildBindingDocument }> {
  const p = await project();
  const b0 = await p.promote(await p.prepare('0'));
  return { p, b0 };
}

const conclude = (p: Project, build: FrontendBackendBuildBindingDocument, over: Partial<{ promotionId: string | null; promotionCommitSha: string | null }> = {}) =>
  concludeCanonicalDraft({
    store,
    workspace: p.ws,
    projectId: p.projectId,
    canonicalBindingId: build._id,
    promotion: { promotionId: build.promotionId, promotionCommitSha: build.promotionCommitSha, ...over },
  });

const stateOf = async (projectId: string) => (await store.projects.findOne({ _id: projectId }))?.state;
const draftsOf = (projectId: string) => store.canonicalDrafts.find({ projectId }).toArray();
const activeRootOf = (projectId: string) => store.frontendBackendBuildBindings.findOne({ projectId, activeLineage: true });

/** Replace the current draft with one whose authority fields are tampered, re-identified so identity itself still holds. */
async function rewriteDraft(draft: CanonicalDraftDocument, over: Partial<CanonicalDraftDocument>): Promise<CanonicalDraftDocument> {
  const next = { ...draft, ...over };
  const rewritten = { ...next, _id: canonicalDraftId(next) };
  await store.canonicalDrafts.deleteOne({ _id: draft._id });
  await store.canonicalDrafts.insertOne(rewritten);
  return rewritten;
}

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

const X = { kind: 'semantic_edit' as const, operationId: 'semantic-edit-intent-x' };
const Y = { kind: 'semantic_edit' as const, operationId: 'semantic-edit-intent-y' };

// ---------------------------------------------------------------------------
// Conclusion
// ---------------------------------------------------------------------------

describe('draft conclusion', () => {
  it('concludes the promoted active tip as the one available draft, in one step', async () => {
    const { p, b0 } = await withPromotedRoot();

    const { draft, replayed } = await conclude(p, b0);

    expect(replayed).toBe(false);
    expect(draft).toMatchObject({
      _id: canonicalDraftId({ projectId: p.projectId, lineageRootBindingId: b0._id, canonicalBindingId: b0._id, promotionId: b0.promotionId! }),
      projectId: p.projectId,
      lineageRootBindingId: b0._id,
      canonicalBindingId: b0._id,
      promotionId: b0.promotionId,
      promotionCommitSha: b0.promotionCommitSha,
      status: 'available',
      current: true,
    });
    expect('claim' in draft).toBe(false);
    expect(await stateOf(p.projectId)).toBe('draft');
    expect(await activeRootOf(p.projectId)).toBeNull();
    // Released, not rewritten: the root and its history are intact.
    const root = await p.reload(b0._id);
    expect(root).toMatchObject({ status: 'promoted', lineageRootBindingId: b0._id, promotionId: b0.promotionId });
    expect('activeLineage' in root).toBe(false);
    expect(await loadCurrentCanonicalDraft(store, p.projectId)).toEqual(await store.canonicalDrafts.findOne({ _id: draft._id }));
  });

  it('records the exact tip and root of a longer lineage', async () => {
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    const b1 = await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));

    const { draft } = await conclude(p, b1);
    expect(draft).toMatchObject({ lineageRootBindingId: b0._id, canonicalBindingId: b1._id, promotionId: b1.promotionId, promotionCommitSha: b1.promotionCommitSha });
  });

  it('draft identity is deterministic from exact authority, and nothing else', () => {
    const identity = { projectId: 'p', lineageRootBindingId: 'r', canonicalBindingId: 'b', promotionId: 'm' };
    expect(canonicalDraftId(identity)).toBe(canonicalDraftId({ ...identity }));
    expect(canonicalDraftId(identity)).toMatch(/^canonical-draft-[a-f0-9]{64}$/);
    for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
      expect(canonicalDraftId({ ...identity, [key]: 'other' })).not.toBe(canonicalDraftId(identity));
    }
  });

  it('is atomic: a failure after the draft is written leaves the run owning the project, and no draft', async () => {
    const { p, b0 } = await withPromotedRoot();
    const real = store.frontendBackendBuildBindings;
    // The active slot's release is the last write in the transaction; make it fail.
    vi.spyOn(store, 'frontendBackendBuildBindings', 'get').mockReturnValue(
      new Proxy(real, {
        get(target, key, receiver) {
          if (key === 'updateOne') return async () => { throw new Error('injected: release failed'); };
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );

    await expect(conclude(p, b0)).rejects.toThrow('injected: release failed');
    vi.restoreAllMocks();

    expect(await draftsOf(p.projectId)).toEqual([]);
    expect(await stateOf(p.projectId)).toBe('validating');
    expect((await activeRootOf(p.projectId))?._id).toBe(b0._id);
  });

  it('never exposes an ownership gap to a concurrent reader', async () => {
    const { p, b0 } = await withPromotedRoot();
    let observations = 0;
    const observe = async () => {
      // One snapshot read of both owners: exactly one of them, always.
      await store.withTransaction(async (session) => {
        const root = await store.frontendBackendBuildBindings.findOne({ projectId: p.projectId, activeLineage: true }, { session });
        const draft = await store.canonicalDrafts.findOne({ projectId: p.projectId, current: true }, { session });
        const project = await store.projects.findOne({ _id: p.projectId }, { session });
        expect(Boolean(root) !== Boolean(draft)).toBe(true);
        expect(project?.state === 'draft').toBe(Boolean(draft));
        observations += 1;
      });
    };
    await Promise.all([conclude(p, b0), observe(), observe(), observe()]);
    await observe();
    expect(observations).toBe(4);
  });

  it('replaying the exact conclusion returns the same draft and writes nothing', async () => {
    const { p, b0 } = await withPromotedRoot();
    const first = await conclude(p, b0);
    const stored = await store.canonicalDrafts.findOne({ _id: first.draft._id });

    const again = await conclude(p, b0);
    expect(again.replayed).toBe(true);
    expect(again.draft).toEqual(stored);
    expect(await draftsOf(p.projectId)).toHaveLength(1);
    expect(await store.canonicalDrafts.findOne({ _id: first.draft._id })).toEqual(stored);
  });

  it('a mismatched replay fails closed and changes nothing', async () => {
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    const b1 = await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));
    const { draft } = await conclude(p, b1);

    await expect(conclude(p, b1, { promotionCommitSha: b0.promotionCommitSha })).rejects.toBeInstanceOf(CanonicalDraftConclusionRefused);
    await expect(conclude(p, b0)).rejects.toBeInstanceOf(CanonicalDraftConclusionRefused);
    expect(await draftsOf(p.projectId)).toEqual([await store.canonicalDrafts.findOne({ _id: draft._id })]);
  });

  it('refuses a build the active lineage has moved past', async () => {
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));

    await expect(conclude(p, b0)).rejects.toThrow(/advanced/);
    expect(await draftsOf(p.projectId)).toEqual([]);
    expect(await activeRootOf(p.projectId)).not.toBeNull();
  });

  it('refuses a tip that has not promoted', async () => {
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    const b1 = await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) });

    await expect(conclude(p, b1, { promotionId: 'promotion-invented', promotionCommitSha: b0.promotionCommitSha })).rejects.toBeInstanceOf(CanonicalDraftConclusionRefused);
    await expect(conclude(p, b0)).rejects.toBeInstanceOf(CanonicalDraftConclusionRefused);
    expect(await draftsOf(p.projectId)).toEqual([]);
  });

  it.each([
    ['a different promotion id', (b: FrontendBackendBuildBindingDocument) => ({ promotionId: `${b.promotionId}-other` })],
    ['a different promotion commit', () => ({ promotionCommitSha: 'f'.repeat(40) })],
    ['no promotion at all', () => ({ promotionId: null })],
  ])('refuses %s', async (_label, over) => {
    const { p, b0 } = await withPromotedRoot();
    await expect(conclude(p, b0, over(b0))).rejects.toBeInstanceOf(CanonicalDraftConclusionRefused);
    expect(await draftsOf(p.projectId)).toEqual([]);
    expect(await stateOf(p.projectId)).toBe('validating');
  });

  it('refuses when the promotion receipt does not prove the build', async () => {
    const { p, b0 } = await withPromotedRoot();
    await store.promotions.updateOne({ _id: b0.promotionId! }, { $set: { status: 'prepared' } });
    await expect(conclude(p, b0)).rejects.toThrow(/receipt/);
    expect(await draftsOf(p.projectId)).toEqual([]);
  });

  it('refuses when canonical history does not carry the promotion marker', async () => {
    const { p, b0 } = await withPromotedRoot();
    // Binding and receipt agree on a promotion id that Git never recorded.
    const renamed = { ...b0, promotionId: 'promotion-never-committed' };
    await store.promotions.insertOne({ ...(await store.promotions.findOne({ _id: b0.promotionId! }))!, _id: renamed.promotionId });
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $set: { promotionId: renamed.promotionId } });
    await expect(conclude(p, renamed)).rejects.toThrow(/exactly one commit/);
    expect(await draftsOf(p.projectId)).toEqual([]);
  });

  it('refuses when no active lineage owns the project, or the build is another lineage\'s', async () => {
    const { p, b0 } = await withPromotedRoot();
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $unset: { activeLineage: '' } });
    await expect(conclude(p, b0)).rejects.toThrow(/no active build lineage/);

    const other = await withPromotedRoot();
    await expect(concludeCanonicalDraft({ store, workspace: other.p.ws, projectId: other.p.projectId, canonicalBindingId: b0._id, promotion: { promotionId: b0.promotionId, promotionCommitSha: b0.promotionCommitSha } })).rejects.toBeInstanceOf(CanonicalDraftConclusionRefused);
    expect(await draftsOf(p.projectId)).toEqual([]);
    expect(await draftsOf(other.p.projectId)).toEqual([]);
  });

  it.each(['awaiting_human_review', 'releasing', 'released', 'blocked', 'intake_insufficient'] as const)('refuses a project that is %s', async (state) => {
    const { p, b0 } = await withPromotedRoot();
    await store.projects.updateOne({ _id: p.projectId }, { $set: { state } });
    await expect(conclude(p, b0)).rejects.toThrow(new RegExp(`"${state}"`));
    expect(await draftsOf(p.projectId)).toEqual([]);
    expect(await activeRootOf(p.projectId)).not.toBeNull();
  });

  it.each([
    ['an unfinished release of the project', (p: Project) => ({ projectId: p.projectId, active: true as const, status: 'prepared' as const })],
    ['a committed release of this lineage', (p: Project, b0: FrontendBackendBuildBindingDocument) => ({ projectId: p.projectId, status: 'committed' as const, buildAuthority: { lineageRootBindingId: b0._id, canonicalBindingId: b0._id, promotionId: b0.promotionId! } })],
  ])('refuses while %s owns continuation', async (_label, shape) => {
    const { p, b0 } = await withPromotedRoot();
    await store.releasePublications.insertOne({
      _id: `release-${p.projectId}`,
      releaseAuthorization: ref('release-authorization', 1),
      baseCommit: null,
      deploymentTarget: { project: 'x', team: null, environment: 'production' },
      releaseCommitSha: null,
      deploymentId: null,
      deploymentUrl: null,
      attempt: 0,
      attempts: [],
      preparedAt: new Date(),
      committedAt: null,
      updatedAt: new Date(),
      ...shape(p, b0),
    });
    await expect(conclude(p, b0)).rejects.toThrow(/release publication/);
    expect(await draftsOf(p.projectId)).toEqual([]);
    expect(await stateOf(p.projectId)).toBe('validating');
  });
});

// ---------------------------------------------------------------------------
// One current draft
// ---------------------------------------------------------------------------

describe('one current draft per project', () => {
  it('is a durable unique constraint, whatever else differs', async () => {
    const { p, b0 } = await withPromotedRoot();
    const { draft } = await conclude(p, b0);

    const rival = { ...draft, _id: `${draft._id}-rival`, status: 'claimed' as const, claim: X, createdAt: new Date(0), updatedAt: new Date() };
    await expect(store.canonicalDrafts.insertOne(rival)).rejects.toMatchObject({ code: 11000 });
    await expect(store.canonicalDrafts.insertOne({ ...draft, _id: 'canonical-draft-other', canonicalBindingId: 'another-build' })).rejects.toMatchObject({ code: 11000 });

    // Earlier drafts are history, outside the slot.
    const historical: CanonicalDraftDocument = { ...draft, _id: 'canonical-draft-historical' };
    delete historical.current;
    await store.canonicalDrafts.insertOne(historical);
    expect(await draftsOf(p.projectId)).toHaveLength(2);
    expect((await loadCurrentCanonicalDraft(store, p.projectId))?._id).toBe(draft._id);

    const indexes = await store.canonicalDrafts.indexes();
    expect(indexes.find((i) => i.name === 'projectId_1_currentDraft')).toMatchObject({ key: { projectId: 1 }, unique: true, partialFilterExpression: { current: true } });
  });

  it('a concurrent pair of conclusions of the same build converges on one draft', async () => {
    const { p, b0 } = await withPromotedRoot();
    const results = await Promise.all([conclude(p, b0), conclude(p, b0)]);
    expect(new Set(results.map((r) => r.draft._id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await draftsOf(p.projectId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation of an existing draft
// ---------------------------------------------------------------------------

describe('a current draft is re-proven on every read', () => {
  async function concluded() {
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    const b1 = await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));
    const { draft } = await conclude(p, b1);
    return { p, b0, b1, draft };
  }

  it('no draft state and no draft record is simply no draft', async () => {
    const p = await project();
    expect(await loadCurrentCanonicalDraft(store, p.projectId)).toBeNull();
    expect(await loadCurrentCanonicalDraft(store, 'proj_draft_nonexistent')).toBeNull();
  });

  it('rejects a draft record while the project is not a draft', async () => {
    const { p } = await concluded();
    await store.projects.updateOne({ _id: p.projectId }, { $set: { state: 'building' } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/project is "building"/);
  });

  it('rejects draft state with no draft record', async () => {
    const { p } = await concluded();
    await store.canonicalDrafts.updateMany({ projectId: p.projectId }, { $unset: { current: '' } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/no current draft record/);
  });

  it('rejects an active lineage alongside the draft', async () => {
    const { p, b0 } = await concluded();
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $set: { activeLineage: true } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/still active/);
  });

  it('rejects a tampered identity', async () => {
    const { p, draft } = await concluded();
    await store.canonicalDrafts.updateOne({ _id: draft._id }, { $set: { promotionId: 'promotion-other' } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/identity/);
  });

  it('rejects a wrong root', async () => {
    const { p, b1, draft } = await concluded();
    await rewriteDraft(draft, { lineageRootBindingId: b1._id });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
  });

  it('rejects a draft naming a non-tip build', async () => {
    const { p, b0, draft } = await concluded();
    await rewriteDraft(draft, { canonicalBindingId: b0._id, promotionId: b0.promotionId!, promotionCommitSha: b0.promotionCommitSha! });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/ends at/);
  });

  it('rejects a draft whose lineage grew a successor after it concluded', async () => {
    const { p, b1 } = await concluded();
    await p.prepare('2', { predecessorBindingId: b1._id, provenance: replan(2) });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/ends at/);
  });

  it.each([
    ['promotion id', (d: CanonicalDraftDocument) => ({ promotionId: `${d.promotionId}-other` })],
    ['promotion commit', () => ({ promotionCommitSha: 'e'.repeat(40) })],
  ])('rejects a wrong %s', async (_label, over) => {
    const { p, draft } = await concluded();
    await rewriteDraft(draft, over(draft));
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/promoted by/);
  });

  it('rejects a build that is no longer promoted, and a receipt that no longer proves it', async () => {
    const { p, b1 } = await concluded();
    await store.promotions.updateOne({ _id: b1.promotionId! }, { $set: { commitSha: 'e'.repeat(40) } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/receipt/);
    await store.frontendBackendBuildBindings.updateOne({ _id: b1._id }, { $set: { status: 'abandoned' } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/not promoted/);
  });

  it('rejects a release publication appearing alongside the draft', async () => {
    const { p } = await concluded();
    await store.releasePublications.insertOne({ _id: `release-${p.projectId}`, projectId: p.projectId, active: true, status: 'prepared' } as never);
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/owns the project alongside/);
  });

  it('rejects inconsistent claim state', async () => {
    const { p, draft } = await concluded();
    await store.canonicalDrafts.updateOne({ _id: draft._id }, { $set: { status: 'claimed' } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/no valid claimant/);
    await store.canonicalDrafts.updateOne({ _id: draft._id }, { $set: { status: 'available', claim: X } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/records a claim/);
  });

  it('proves the promotion marker in canonical history', async () => {
    const { p, draft } = await concluded();
    await expect(assertCanonicalDraftPromotionMarker(p.ws, draft)).resolves.toBeUndefined();
    await expect(assertCanonicalDraftPromotionMarker(p.ws, { ...draft, promotionCommitSha: 'e'.repeat(40) })).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
    await expect(assertCanonicalDraftPromotionMarker(p.ws, { ...draft, promotionId: 'promotion-unknown' })).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
  });
});

// ---------------------------------------------------------------------------
// Lineage from an exact, inactive root
// ---------------------------------------------------------------------------

describe('structural tip from an exact root', () => {
  it('derives the exact tip of a mixed lineage once the active slot is gone, and the active helper refuses that root', async () => {
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    const b1 = await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));
    const b2 = await p.promote(await p.prepare('2', { predecessorBindingId: b1._id, provenance: visual(1) }));
    await conclude(p, b2);

    const root = await p.reload(b0._id);
    expect((await deriveLineageTipFromRoot(store, root))._id).toBe(b2._id);
    await expect(deriveActiveLineageTip(store, root)).rejects.toThrow(/does not hold the active-lineage slot/);
    expect((await loadCurrentCanonicalDraft(store, p.projectId))?.canonicalBindingId).toBe(b2._id);
  });

  it('rejects a branch', async () => {
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    const b1 = await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));
    await conclude(p, b1);
    await store.frontendBackendBuildBindings.dropIndex('projectId_1_predecessorBindingId_1');
    try {
      await store.frontendBackendBuildBindings.insertOne({ ...b1, _id: `${b1._id}-rival`, updatedAt: new Date() });
      await expect(deriveLineageTipFromRoot(store, await p.reload(b0._id))).rejects.toThrow(/does not branch/);
      await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toThrow(/does not branch/);
    } finally {
      await store.frontendBackendBuildBindings.deleteMany({ projectId: p.projectId });
      await store.ensureIndexes();
    }
  });

  it('rejects a cycle, a foreign root and an unreachable member', async () => {
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    const b1 = await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));
    await conclude(p, b1);
    const root = await p.reload(b0._id);

    await expect(deriveLineageTipFromRoot(store, { ...root, lineageRootBindingId: 'frontend-backend-build-elsewhere' })).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
    await expect(deriveLineageTipFromRoot(store, { ...root, predecessorBindingId: b1._id, replanDecision: ref('replan-decision', 9) })).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);

    const orphan: FrontendBackendBuildBindingDocument = { ...b1, _id: `${b1._id}-orphan`, predecessorBindingId: 'frontend-backend-build-missing', updatedAt: new Date() };
    await store.frontendBackendBuildBindings.insertOne(orphan);
    await expect(deriveLineageTipFromRoot(store, root)).rejects.toThrow(/reachable/);
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
    await store.frontendBackendBuildBindings.deleteOne({ _id: orphan._id });

    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $set: { predecessorBindingId: b1._id, replanDecision: ref('replan-decision', 9) } });
    await expect(loadCurrentCanonicalDraft(store, p.projectId)).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
  });
});

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

describe('claiming a draft', () => {
  async function available() {
    const { p, b0 } = await withPromotedRoot();
    const { draft } = await conclude(p, b0);
    const claim = (claimant: unknown, over: Partial<{ expectedDraftId: string; expectedCanonicalBindingId: string }> = {}) =>
      claimCanonicalDraft({ store, projectId: p.projectId, expectedDraftId: draft._id, expectedCanonicalBindingId: b0._id, claimant: claimant as typeof X, ...over });
    const release = (claimant: typeof X) => releaseCanonicalDraftClaim({ store, projectId: p.projectId, expectedDraftId: draft._id, expectedCanonicalBindingId: b0._id, claimant });
    return { p, b0, draft, claim, release };
  }

  it('an available draft is claimed by exactly the expected draft, build and claimant — and nothing else changes', async () => {
    const { p, b0, draft, claim } = await available();
    const bindingsBefore = await store.frontendBackendBuildBindings.find({ projectId: p.projectId }).toArray();
    const head = await p.ws.currentCommit();

    const claimed = await claim(X);
    expect(claimed.replayed).toBe(false);
    const stored = (await store.canonicalDrafts.findOne({ _id: draft._id }))!;
    expect(stored).toMatchObject({ status: 'claimed', claim: X, current: true, canonicalBindingId: b0._id });
    expect(Object.keys(stored.claim!).sort()).toEqual(['kind', 'operationId']);
    expect(claimed.draft).toMatchObject({ status: 'claimed', claim: X });

    // A claim reserves — it builds, publishes and reactivates nothing.
    expect(await stateOf(p.projectId)).toBe('draft');
    expect(await store.frontendBackendBuildBindings.find({ projectId: p.projectId }).toArray()).toEqual(bindingsBefore);
    expect(await activeRootOf(p.projectId)).toBeNull();
    expect(await store.releasePublications.countDocuments({ projectId: p.projectId })).toBe(0);
    expect(await p.ws.currentCommit()).toBe(head);
    expect((await loadCurrentCanonicalDraft(store, p.projectId))?.claim).toEqual(X);
  });

  it('the same claimant replaying is idempotent', async () => {
    const { draft, claim } = await available();
    await claim(X);
    const stored = await store.canonicalDrafts.findOne({ _id: draft._id });
    const again = await claim(X);
    expect(again.replayed).toBe(true);
    expect(await store.canonicalDrafts.findOne({ _id: draft._id })).toEqual(stored);
  });

  it('a different claimant — even of another kind — is refused, with no age-based takeover', async () => {
    const { draft, claim } = await available();
    await claim(X);
    // However long ago the claim was made, it is still held.
    await store.canonicalDrafts.updateOne({ _id: draft._id }, { $set: { updatedAt: new Date(0), createdAt: new Date(0) } });
    await expect(claim(Y)).rejects.toMatchObject({ reason: 'claimed_by_another' });
    await expect(claim({ kind: 'release', operationId: X.operationId })).rejects.toMatchObject({ reason: 'claimed_by_another' });
    expect((await store.canonicalDrafts.findOne({ _id: draft._id }))?.claim).toEqual(X);
  });

  it('concurrent claimants: exactly one wins', async () => {
    const { draft, claim } = await available();
    const results = await Promise.allSettled([claim(X), claim(Y), claim({ kind: 'release', operationId: 'release-z' })]);
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const lost of results.filter((r) => r.status === 'rejected')) {
      expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(CanonicalDraftClaimConflict);
    }
    const holder = (await store.canonicalDrafts.findOne({ _id: draft._id }))!.claim;
    expect((won[0] as PromiseFulfilledResult<{ draft: CanonicalDraftDocument }>).value.draft.claim).toEqual(holder);
  });

  it('a stale draft id or a stale build is a typed conflict', async () => {
    const { p, b0, draft, claim } = await available();
    await expect(claim(X, { expectedDraftId: `${draft._id}-old` })).rejects.toMatchObject({ reason: 'stale_draft' });
    await expect(claim(X, { expectedCanonicalBindingId: `${b0._id}-old` })).rejects.toMatchObject({ reason: 'stale_tip' });
    expect((await store.canonicalDrafts.findOne({ _id: draft._id }))?.status).toBe('available');

    const none = await project();
    await expect(claimCanonicalDraft({ store, projectId: none.projectId, expectedDraftId: draft._id, expectedCanonicalBindingId: b0._id, claimant: X })).rejects.toMatchObject({ reason: 'no_current_draft' });
    expect(p.projectId).not.toBe(none.projectId);
  });

  it('a corrupt draft cannot be claimed', async () => {
    const { b0, claim } = await available();
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $set: { activeLineage: true } });
    await expect(claim(X)).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
  });

  it.each([
    ['a session riding along', { ...X, sessionId: 'sess_abc' }],
    ['a bearer token riding along', { ...X, token: 'eyJhbGciOi' }],
    ['a customer identity riding along', { ...X, customerUserId: 'cu_1' }],
    ['an unknown kind', { kind: 'customer', operationId: 'x' }],
    ['a free-text operation id', { kind: 'semantic_edit', operationId: 'Bearer abc def' }],
    ['an unbounded operation id', { kind: 'semantic_edit', operationId: 'a'.repeat(201) }],
    ['no operation id', { kind: 'semantic_edit' }],
  ])('refuses a claimant with %s, before reading anything', async (_label, claimant) => {
    const { draft, claim } = await available();
    await expect(claim(claimant)).rejects.toBeInstanceOf(CanonicalDraftClaimantInvalid);
    expect((await store.canonicalDrafts.findOne({ _id: draft._id }))?.status).toBe('available');
  });

  it('only the holder releases its claim; release replays; the draft is then claimable again', async () => {
    const { draft, claim, release } = await available();
    await claim(X);
    await expect(release(Y)).rejects.toMatchObject({ reason: 'claimed_by_another' });

    const released = await release(X);
    expect(released.replayed).toBe(false);
    const stored = (await store.canonicalDrafts.findOne({ _id: draft._id }))!;
    expect(stored.status).toBe('available');
    expect('claim' in stored).toBe(false);
    expect((await release(X)).replayed).toBe(true);

    expect((await claim(Y)).draft.claim).toEqual(Y);
  });
});

// ---------------------------------------------------------------------------
// Phase 5q and run start
// ---------------------------------------------------------------------------

describe('Phase 5q and run start', () => {
  const recover = (projectId: string) => resolvePostPromotionRecovery({ store, registry, workspacesRoot, projectId, runIntentHash: 'intent' });

  it('a valid draft is concluded, not interrupted: reported, with nothing resumed or written', async () => {
    const { p, b0 } = await withPromotedRoot();
    const { draft } = await conclude(p, b0);
    const before = { project: await store.projects.findOne({ _id: p.projectId }), draft: await store.canonicalDrafts.findOne({ _id: draft._id }), head: await p.ws.currentCommit() };

    const error = await recover(p.projectId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActiveContinuationConcludedDraft);
    expect(error).toMatchObject({ draftId: draft._id, canonicalBindingId: b0._id });

    expect(await store.projects.findOne({ _id: p.projectId })).toEqual(before.project);
    expect(await store.canonicalDrafts.findOne({ _id: draft._id })).toEqual(before.draft);
    expect(await p.ws.currentCommit()).toBe(before.head);
    expect(await store.releasePublications.countDocuments({ projectId: p.projectId })).toBe(0);
  });

  it('malformed draft authority fails closed', async () => {
    const { p, b0 } = await withPromotedRoot();
    const { draft } = await conclude(p, b0);

    await store.canonicalDrafts.updateOne({ _id: draft._id }, { $unset: { current: '' } });
    await expect(recover(p.projectId)).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
    await store.canonicalDrafts.updateOne({ _id: draft._id }, { $set: { current: true } });

    await rewriteDraft(draft, { promotionCommitSha: 'e'.repeat(40) });
    await expect(recover(p.projectId)).rejects.toBeInstanceOf(CanonicalDraftAuthorityCorrupt);
  });

  it('a draft whose marker commit is gone from canonical history fails closed', async () => {
    const { p, b0 } = await withPromotedRoot();
    const { draft } = await conclude(p, b0);
    // Same receipt and binding, but a promotion id Git never recorded.
    const renamed = 'promotion-rewritten';
    await store.promotions.insertOne({ ...(await store.promotions.findOne({ _id: draft.promotionId }))!, _id: renamed });
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $set: { promotionId: renamed } });
    await rewriteDraft(draft, { promotionId: renamed });
    await expect(recover(p.projectId)).rejects.toThrow(/exactly one commit/);
  });

  it('an active lineage alongside a current draft is corruption, not recovery', async () => {
    const { p, b0 } = await withPromotedRoot();
    await conclude(p, b0);
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $set: { activeLineage: true } });
    await expect(recover(p.projectId)).rejects.toBeInstanceOf(ActiveContinuationCorrupt);
    // Refused for the draft itself — not merely because the project also says `draft`.
    await store.projects.updateOne({ _id: p.projectId }, { $set: { state: 'validating' } });
    await expect(recover(p.projectId)).rejects.toThrow(/is active while canonical draft/);
  });

  it('a project with neither owner still takes the fresh path', async () => {
    const p = await project();
    expect(await recover(p.projectId)).toBeNull();
    await store.projects.updateOne({ _id: p.projectId }, { $set: { state: 'released' } });
    expect(await recover(p.projectId)).toBeNull();
    await store.projects.updateOne({ _id: p.projectId }, { $set: { state: 'blocked' } });
    expect(await recover(p.projectId)).toBeNull();
    await expect(assertNoActiveLineageForLegacyDirect(store, p.projectId)).resolves.toBeUndefined();
  });

  it('no fresh root is founded while a draft is current, and legacy_direct is refused too', async () => {
    const { p, b0 } = await withPromotedRoot();
    const { draft } = await conclude(p, b0);
    const count = await store.frontendBackendBuildBindings.countDocuments({ projectId: p.projectId });

    await expect(p.prepare('fresh')).rejects.toBeInstanceOf(FrontendBackendCanonicalDraftOwnsProject);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: p.projectId })).toBe(count);
    expect(await activeRootOf(p.projectId)).toBeNull();

    await expect(assertNoActiveLineageForLegacyDirect(store, p.projectId)).rejects.toBeInstanceOf(ActiveContinuationConcludedDraft);
    expect((await loadCurrentCanonicalDraft(store, p.projectId))?._id).toBe(draft._id);
  });

  it.each(['job_lifecycle', 'legacy_direct'] as const)('a real %s run over a draft stops before discovery, planning or any model call', async (mode) => {
    const { p, b0 } = await withPromotedRoot();
    const { draft } = await conclude(p, b0);
    const before = { project: await store.projects.findOne({ _id: p.projectId }), bindings: await store.frontendBackendBuildBindings.find({ projectId: p.projectId }).toArray() };
    const provider = { name: 'unreachable', invoke: vi.fn(async () => { throw new Error('no model may be called'); }) };

    const error = await runProject({
      projectId: p.projectId,
      intake: INTAKE,
      store,
      workspacesRoot,
      frontendBackendExecutionMode: mode,
      validationWorkspacesRoot: workspacesRoot,
      modelProvider: provider as never,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActiveContinuationConcludedDraft);
    expect(provider.invoke).not.toHaveBeenCalled();
    // Discovery would have deleted and recreated the project; nothing was touched.
    expect(await store.projects.findOne({ _id: p.projectId })).toEqual(before.project);
    expect(await store.frontendBackendBuildBindings.find({ projectId: p.projectId }).toArray()).toEqual(before.bindings);
    expect(await store.artifacts.countDocuments({ projectId: p.projectId, name: 'site-plan' })).toBe(0);
    expect((await loadCurrentCanonicalDraft(store, p.projectId))?._id).toBe(draft._id);
  });
});

// ---------------------------------------------------------------------------
// Release tip fence
// ---------------------------------------------------------------------------

describe('release tip fence', () => {
  const AUTHORIZATION = { authorized: true, action: 'release', reason: 'gates passed', policyVersion: 'test-policy@1' } as ReleaseAuthorization;

  function provider() {
    const calls: string[] = [];
    const gateway: ReleaseDeploymentGateway = {
      async deploy(input) {
        calls.push(input.projectId);
        return { deploymentId: `dpl_${calls.length}`, url: `https://${input.projectId}.vercel.app`, rollbackRef: null, fileCount: 1, durationMs: 1, meta: { ...input.meta } };
      },
      async getDeploymentById() {
        throw new Error('unused');
      },
    };
    return { calls, gateway };
  }

  async function releaseFor(p: Project) {
    const releaseAuthorizationRef = await registry.put(p.projectId, 'release-authorization', { authorized: true, action: 'release', reviewCycle: 0 });
    await p.ws.materialiseArtifact('decisions/release-authorization-00.json', { authorized: true });
    const ctx = {
      deps: { store, registry, workspace: p.ws, model: {} as never, say: () => {} },
      facts: { projectId: p.projectId, profile: { businessName: 'Acme' } as never, autonomyMode: 'full_autonomous' as const, budgetLimits: {} as never },
      progress: { qualityScore: 91, gatesCertified: ['build'], approvalModel: 'm', approvalArtifactVersion: 1, approvalDecision: 'accept' as const } as never,
    } as unknown as RunContext;
    return (bindingId: string, gateway: ReleaseDeploymentGateway) => publishRelease(ctx, AUTHORIZATION, { releaseAuthorizationRef, gateway, canonicalBuildBindingId: bindingId });
  }

  it('an active run releases its exact current tip, as before', async () => {
    vi.stubEnv('VERCEL_TOKEN', 'test-token');
    vi.stubEnv('VERCEL_TEAM_ID', undefined);
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    const b1 = await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));
    const { calls, gateway } = provider();

    const result = await (await releaseFor(p))(b1._id, gateway);
    expect(calls).toHaveLength(1);
    expect(result.manifest.deploymentId).toBe('dpl_1');
    const receipt = await store.releasePublications.findOne({ projectId: p.projectId });
    expect(receipt).toMatchObject({ status: 'committed', buildAuthority: { lineageRootBindingId: b0._id, canonicalBindingId: b1._id, promotionId: b1.promotionId } });
    expect(await stateOf(p.projectId)).toBe('released');
    expect(await activeRootOf(p.projectId)).toBeNull();
  });

  it('a build the lineage has moved past cannot be released — refused before any state, receipt or provider call', async () => {
    vi.stubEnv('VERCEL_TOKEN', 'test-token');
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));
    const { calls, gateway } = provider();
    const head = await p.ws.currentCommit();

    await expect((await releaseFor(p))(b0._id, gateway)).rejects.toBeInstanceOf(FrontendBackendReleaseBuildNotCurrent);
    expect(calls).toEqual([]);
    expect(await store.releasePublications.countDocuments({ projectId: p.projectId })).toBe(0);
    expect(await stateOf(p.projectId)).toBe('validating');
    expect(await p.ws.currentCommit()).toBe(head);
    expect(await activeRootOf(p.projectId)).not.toBeNull();
  });

  it('the local-preview path is fenced the same way', async () => {
    vi.stubEnv('VERCEL_TOKEN', undefined);
    const p = await project();
    const b0 = await p.promote(await p.prepare('0'));
    await p.promote(await p.prepare('1', { predecessorBindingId: b0._id, provenance: replan(1) }));
    await expect((await releaseFor(p))(b0._id, provider().gateway)).rejects.toBeInstanceOf(FrontendBackendReleaseBuildNotCurrent);
    expect(await stateOf(p.projectId)).toBe('validating');
    expect(await store.artifacts.countDocuments({ projectId: p.projectId, name: 'deployment-manifest' })).toBe(0);
  });

  it('a concluded draft is not released by naming its build: no run owns it', async () => {
    vi.stubEnv('VERCEL_TOKEN', 'test-token');
    const { p, b0 } = await withPromotedRoot();
    const { draft } = await conclude(p, b0);
    const { calls, gateway } = provider();

    await expect((await releaseFor(p))(b0._id, gateway)).rejects.toThrow(/no active build lineage/);
    expect(calls).toEqual([]);
    expect(await store.releasePublications.countDocuments({ projectId: p.projectId })).toBe(0);
    expect((await loadCurrentCanonicalDraft(store, p.projectId))?._id).toBe(draft._id);
  });
});
