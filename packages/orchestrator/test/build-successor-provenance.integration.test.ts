/**
 * Typed build-successor provenance against real durable state.
 *
 * A successor names its exact predecessor and exactly one typed reason — a
 * replan, or a visual refinement — and historical replan bindings, written
 * before the reason was typed, read exactly as they always did. Every
 * contradictory, missing or malformed shape fails closed. Only the state API is
 * exercised: no production path creates a visual-refinement successor.
 *
 * Integration: needs the Mongo replica set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ReplanSuccessorProvenance,
  VisualRefinementSuccessorProvenance,
  type ArtifactRef,
  type BuildSuccessorProvenance,
} from '@statxai/contracts';
import { StateStore, type FrontendBackendBuildBindingDocument } from '@statxai/state';
import type { ArtifactRegistry } from '@statxai/workspace';
import {
  FrontendBackendBuildBindingCorrupt,
  FrontendBackendBuildLineageConflict,
  FrontendBackendBuildLineageCorrupt,
  FrontendBackendBuildSuccessorProvenanceInvalid,
  deriveActiveLineageTip,
  finalizeBindingPromoted,
  findActiveLineageRoot,
  parseStoredJobSpec,
  prepareFrontendBackendBuildBinding,
  readBuildLineage,
  verifyBindingConsistency,
} from '../src/run-binding/frontend-backend.js';
import { ActiveContinuationCorrupt, resolvePostPromotionRecovery } from '../src/run-recovery/frontend-backend.js';
import { createFrontendBackendJobSpec, createFrontendBackendVisualRefinementJobSpec } from '../src/job-specs/frontend-backend.js';

let store: StateStore;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
});

afterAll(async () => {
  await store?.close();
});

beforeEach(async () => {
  await store.frontendBackendBuildBindings.deleteMany({ projectId: /^proj_succ_/ });
});

const ref = (name: string, version: number, contentHash?: string): ArtifactRef => ({ name, version, ...(contentHash ? { contentHash } : {}) });
const replan = (version: number): BuildSuccessorProvenance => ReplanSuccessorProvenance.parse({ kind: 'replan', replanDecision: ref('replan-decision', version) });
const visual = (cycle: number, review = 1, set = 1): BuildSuccessorProvenance =>
  VisualRefinementSuccessorProvenance.parse({
    kind: 'visual_refinement',
    visualQualityReview: ref('visual-quality-review', review, 'a'.repeat(64)),
    screenshotSet: ref('screenshot-set', set, 'b'.repeat(64)),
    refinementCycle: cycle,
  });

const inputFor = (projectId: string, marker: string, lineage?: { predecessorBindingId: string; provenance: BuildSuccessorProvenance }) => {
  const businessProfileRef = ref('business-profile', 1);
  const sitePlanRef = ref('site-plan', 1);
  // The spec differs per marker, so each generation has its own deterministic identity. A visual
  // refinement successor's spec pins exactly the review and screenshot set its lineage names.
  const parsed = VisualRefinementSuccessorProvenance.safeParse(lineage?.provenance);
  const provenance = parsed.success ? parsed.data : undefined;
  const base =
    provenance
      ? createFrontendBackendVisualRefinementJobSpec({
          projectId,
          businessProfileRef,
          sitePlanRef,
          visualRefinementSourceRef: ref('visual-refinement-source', provenance.refinementCycle, 'c'.repeat(64)),
          visualQualityReviewRef: { ...provenance.visualQualityReview, contentHash: provenance.visualQualityReview.contentHash ?? 'a'.repeat(64) },
          screenshotSetRef: { ...provenance.screenshotSet, contentHash: provenance.screenshotSet.contentHash ?? 'b'.repeat(64) },
        })
      : createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef });
  const jobSpec = { ...base, objective: `Build generation ${marker}.` };
  return {
    projectId,
    runIntentHash: 'intent',
    businessProfileRef,
    sitePlanRef,
    jobSpec,
    specificationBaseCommit: null,
    ...(lineage ? { lineage } : {}),
  };
};
const prepare = (projectId: string, marker: string, lineage?: { predecessorBindingId: string; provenance: BuildSuccessorProvenance }) =>
  prepareFrontendBackendBuildBinding(store, inputFor(projectId, marker, lineage));
const promote = (id: string, n: number) =>
  finalizeBindingPromoted(store, id, { promotionId: `promo-${n}`, promotionCommitSha: String(n).repeat(40).slice(0, 40) });
const reload = async (id: string) => (await store.frontendBackendBuildBindings.findOne({ _id: id }))!;

/** A raw document as some earlier deployment wrote it: no read path is allowed to need a migration. */
async function insertRaw(doc: FrontendBackendBuildBindingDocument): Promise<void> {
  await store.frontendBackendBuildBindings.insertOne(doc);
}

describe('historical bindings read exactly as they always did', () => {
  it('a historical initial binding is an initial build', async () => {
    const b0 = await prepare('proj_succ_legacy_root', '0');
    const raw = await reload(b0._id);
    expect('successorProvenance' in raw).toBe(false);
    expect(readBuildLineage(raw)).toEqual({ kind: 'initial' });
  });

  it('a historical replan successor — predecessor plus replanDecision, nothing else — normalizes to an exact replan', async () => {
    const projectId = 'proj_succ_legacy_replan';
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);
    // Written the way every replan successor was written before reasons were typed.
    const legacy: FrontendBackendBuildBindingDocument = {
      ...(await reload(b0._id)),
      _id: `${b0._id}-legacy-successor`,
      status: 'promoted',
      predecessorBindingId: b0._id,
      replanDecision: { name: 'replan-decision', version: 3, contentHash: 'c'.repeat(64) },
      promotionId: 'promo-legacy',
      promotionCommitSha: 'd'.repeat(40),
      updatedAt: new Date(),
    };
    delete legacy.activeLineage;
    await insertRaw(legacy);

    const stored = await reload(legacy._id);
    expect(readBuildLineage(stored)).toEqual({
      kind: 'successor',
      predecessorBindingId: b0._id,
      provenance: { kind: 'replan', replanDecision: { name: 'replan-decision', version: 3, contentHash: 'c'.repeat(64) } },
    });
    // Nothing was written to read it.
    expect(await reload(legacy._id)).toEqual(stored);
    expect('successorProvenance' in stored).toBe(false);
    // The walk and the consistency proof both accept it, as before.
    expect((await deriveActiveLineageTip(store, (await findActiveLineageRoot(store, projectId))!))._id).toBe(legacy._id);
    expect(() =>
      verifyBindingConsistency(stored, parseStoredJobSpec(stored), { predecessorBindingId: b0._id, provenance: ReplanSuccessorProvenance.parse({ kind: 'replan', replanDecision: ref('replan-decision', 3, 'c'.repeat(64)) }) }, b0._id),
    ).not.toThrow();
  });
});

describe('a new replan successor', () => {
  it('is prepared with a typed reason and persisted in the replan encoding, unchanged', async () => {
    const projectId = 'proj_succ_new_replan';
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);

    const b1 = await prepare(projectId, '1', { predecessorBindingId: b0._id, provenance: replan(1) });
    const raw = await reload(b1._id);

    expect(raw.predecessorBindingId).toBe(b0._id);
    expect(raw.replanDecision).toEqual({ name: 'replan-decision', version: 1 });
    expect('successorProvenance' in raw).toBe(false);
    expect(raw.lineageRootBindingId).toBe(b0._id);
    expect(raw.activeLineage).toBeUndefined();
    expect(readBuildLineage(raw)).toEqual({ kind: 'successor', predecessorBindingId: b0._id, provenance: replan(1) });
  });
});

describe('a visual-refinement successor', () => {
  it('is prepared through the state API with its exact review, screenshot set and cycle, inheriting the root', async () => {
    const projectId = 'proj_succ_visual';
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);

    const b1 = await prepare(projectId, '1', { predecessorBindingId: b0._id, provenance: visual(1, 4, 7) });
    const raw = await reload(b1._id);

    expect(raw.predecessorBindingId).toBe(b0._id);
    expect(raw.successorProvenance).toEqual({
      kind: 'visual_refinement',
      visualQualityReview: { name: 'visual-quality-review', version: 4, contentHash: 'a'.repeat(64) },
      screenshotSet: { name: 'screenshot-set', version: 7, contentHash: 'b'.repeat(64) },
      refinementCycle: 1,
    });
    expect('replanDecision' in raw).toBe(false);
    expect(raw.lineageRootBindingId).toBe(b0._id);
    expect(raw.activeLineage).toBeUndefined();
    const position = readBuildLineage(raw);
    expect(position).toMatchObject({ kind: 'successor', predecessorBindingId: b0._id, provenance: { kind: 'visual_refinement', refinementCycle: 1 } });
  });

  it('converges on exact replay, and fails closed when the same identity is presented with any other reason', async () => {
    const projectId = 'proj_succ_visual_replay';
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);
    const input = inputFor(projectId, '1', { predecessorBindingId: b0._id, provenance: visual(1) });

    const first = await prepareFrontendBackendBuildBinding(store, input);
    expect((await prepareFrontendBackendBuildBinding(store, input))._id).toBe(first._id);

    for (const provenance of [visual(2), visual(1, 2, 1), visual(1, 1, 2), replan(1)]) {
      await expect(prepareFrontendBackendBuildBinding(store, { ...input, lineage: { predecessorBindingId: b0._id, provenance } })).rejects.toBeInstanceOf(
        FrontendBackendBuildBindingCorrupt,
      );
    }
    // Presented as an initial build — including by Phase 5k's resume check — it is refused as a successor.
    const stored = await reload(first._id);
    expect(() => verifyBindingConsistency(stored, parseStoredJobSpec(stored))).toThrow(/visual_refinement successor but was presented as an initial build/);
    expect(await reload(first._id)).toEqual(stored);
  });
});

describe('invalid reasons are refused before anything is written', () => {
  const invalid: [string, unknown][] = [
    ['a visual refinement without its review', { kind: 'visual_refinement', screenshotSet: ref('screenshot-set', 1), refinementCycle: 1 }],
    ['a visual refinement without its screenshot set', { kind: 'visual_refinement', visualQualityReview: ref('visual-quality-review', 1), refinementCycle: 1 }],
    ['a cycle of zero', { kind: 'visual_refinement', visualQualityReview: ref('visual-quality-review', 1), screenshotSet: ref('screenshot-set', 1), refinementCycle: 0 }],
    ['a fractional cycle', { kind: 'visual_refinement', visualQualityReview: ref('visual-quality-review', 1), screenshotSet: ref('screenshot-set', 1), refinementCycle: 1.5 }],
    ['a review ref naming another artifact', { kind: 'visual_refinement', visualQualityReview: ref('visual-review', 1), screenshotSet: ref('screenshot-set', 1), refinementCycle: 1 }],
    ['a screenshot ref naming another artifact', { kind: 'visual_refinement', visualQualityReview: ref('visual-quality-review', 1), screenshotSet: ref('site-plan', 1), refinementCycle: 1 }],
    ['a replan without its decision', { kind: 'replan' }],
    ['a replan decision naming another artifact', { kind: 'replan', replanDecision: ref('site-plan', 1) }],
    ['a reason of no known kind', { kind: 'rebuild', replanDecision: ref('replan-decision', 1) }],
  ];

  it.each(invalid)('%s', async (_label, provenance) => {
    const projectId = 'proj_succ_invalid';
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);

    await expect(prepare(projectId, '1', { predecessorBindingId: b0._id, provenance: provenance as BuildSuccessorProvenance })).rejects.toBeInstanceOf(
      FrontendBackendBuildSuccessorProvenanceInvalid,
    );
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
  });
});

describe('contradictory stored shapes fail closed, and nothing is chosen for them', () => {
  const base = (): FrontendBackendBuildBindingDocument => {
    const spec = createFrontendBackendJobSpec({ projectId: 'proj_succ_shapes', businessProfileRef: ref('business-profile', 1), sitePlanRef: ref('site-plan', 1) });
    return {
      _id: 'shape',
      projectId: 'proj_succ_shapes',
      status: 'promoted',
      runIntentHash: 'intent',
      businessProfile: ref('business-profile', 1),
      sitePlan: ref('site-plan', 1),
      jobSpec: spec,
      jobSpecHash: 'x',
      jobId: spec.jobId,
      specificationBaseCommit: null,
      specificationCommitSha: null,
      promotionId: null,
      promotionCommitSha: null,
      lineageRootBindingId: 'root',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  };
  const visualStored = visual(1) as VisualRefinementSuccessorProvenance;

  it.each([
    ['a predecessor with no reason', { predecessorBindingId: 'root' }],
    ['a replan reason with no predecessor', { replanDecision: ref('replan-decision', 1) }],
    ['a visual reason with no predecessor', { successorProvenance: visualStored }],
    ['a legacy replan decision alongside a typed visual reason', { predecessorBindingId: 'root', replanDecision: ref('replan-decision', 1), successorProvenance: visualStored }],
    ['legacy replan A alongside a typed replan B', { predecessorBindingId: 'root', replanDecision: ref('replan-decision', 1), successorProvenance: { kind: 'replan', replanDecision: ref('replan-decision', 2) } }],
    ['a typed replan in the visual encoding', { predecessorBindingId: 'root', successorProvenance: { kind: 'replan', replanDecision: ref('replan-decision', 1) } }],
    ['a stored visual reason missing its screenshot set', { predecessorBindingId: 'root', successorProvenance: { kind: 'visual_refinement', visualQualityReview: ref('visual-quality-review', 1), refinementCycle: 1 } }],
    ['a stored visual reason with an invalid cycle', { predecessorBindingId: 'root', successorProvenance: { kind: 'visual_refinement', visualQualityReview: ref('visual-quality-review', 1), screenshotSet: ref('screenshot-set', 1), refinementCycle: -1 } }],
    ['a malformed legacy replan decision', { predecessorBindingId: 'root', replanDecision: { name: 'replan-decision' } }],
  ] as const)('%s', (_label, fields) => {
    expect(() => readBuildLineage({ ...base(), ...(fields as Partial<FrontendBackendBuildBindingDocument>) })).toThrow(FrontendBackendBuildBindingCorrupt);
  });
});

describe('one lineage, whatever the reasons', () => {
  it('a predecessor has one successor slot for every reason: a replan successor blocks a visual one, and the reverse', async () => {
    for (const [first, second, projectId] of [[replan(1), visual(1), 'proj_succ_slot_a'], [visual(1), replan(1), 'proj_succ_slot_b']] as const) {
      const b0 = await prepare(projectId, '0');
      await promote(b0._id, 1);
      await prepare(projectId, '1', { predecessorBindingId: b0._id, provenance: first });
      await expect(prepare(projectId, '2', { predecessorBindingId: b0._id, provenance: second })).rejects.toBeInstanceOf(FrontendBackendBuildLineageConflict);
      expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, predecessorBindingId: b0._id })).toBe(1);
    }
  });

  it('root → replan → visual → replan → visual derives one exact tip structurally, every member on the one root', async () => {
    const projectId = 'proj_succ_mixed_chain';
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '1', { predecessorBindingId: b0._id, provenance: replan(1) });
    await promote(b1._id, 2);
    const b2 = await prepare(projectId, '2', { predecessorBindingId: b1._id, provenance: visual(1) });
    await promote(b2._id, 3);
    const b3 = await prepare(projectId, '3', { predecessorBindingId: b2._id, provenance: replan(2) });
    await promote(b3._id, 4);
    const b4 = await prepare(projectId, '4', { predecessorBindingId: b3._id, provenance: visual(2, 2, 2) });

    const root = (await findActiveLineageRoot(store, projectId))!;
    expect(root._id).toBe(b0._id);
    expect((await deriveActiveLineageTip(store, root))._id).toBe(b4._id);
    for (const b of [b1, b2, b3, b4]) expect((await reload(b._id)).lineageRootBindingId).toBe(b0._id);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, activeLineage: true })).toBe(1);
  });

  it('a visual → replan chain derives its tip too', async () => {
    const projectId = 'proj_succ_visual_then_replan';
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '1', { predecessorBindingId: b0._id, provenance: visual(1) });
    await promote(b1._id, 2);
    const b2 = await prepare(projectId, '2', { predecessorBindingId: b1._id, provenance: replan(1) });
    expect((await deriveActiveLineageTip(store, (await findActiveLineageRoot(store, projectId))!))._id).toBe(b2._id);
  });

  it('the walk fails closed on a member with malformed provenance, on a root carrying a reason, and on an unreachable visual member', async () => {
    const projectId = 'proj_succ_walk_corrupt';
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '1', { predecessorBindingId: b0._id, provenance: visual(1) });
    const root = (await findActiveLineageRoot(store, projectId))!;

    await store.frontendBackendBuildBindings.updateOne({ _id: b1._id }, { $set: { replanDecision: ref('replan-decision', 1) } });
    await expect(deriveActiveLineageTip(store, root)).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
    await store.frontendBackendBuildBindings.updateOne({ _id: b1._id }, { $unset: { replanDecision: '' } });

    await expect(deriveActiveLineageTip(store, { ...root, successorProvenance: visual(1) as VisualRefinementSuccessorProvenance })).rejects.toBeInstanceOf(
      FrontendBackendBuildLineageCorrupt,
    );

    const orphan = { ...(await reload(b1._id)), _id: `${b1._id}-orphan`, predecessorBindingId: 'missing-predecessor', jobId: 'job_orphan', status: 'promoted' as const };
    await insertRaw(orphan);
    await expect(deriveActiveLineageTip(store, root)).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
  });
});

describe('Phase 5q reads successor kind from the typed contract', () => {
  /** A promoted chain with its specification commits recorded — enough for recovery's structural proof. */
  async function promotedChain(projectId: string, reason: BuildSuccessorProvenance) {
    const b0 = await prepare(projectId, '0');
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '1', { predecessorBindingId: b0._id, provenance: reason });
    await promote(b1._id, 2);
    await store.frontendBackendBuildBindings.updateMany({ projectId }, { $set: { specificationCommitSha: 'e'.repeat(40) } });
    return { b0, b1 };
  }
  const recover = (projectId: string) =>
    resolvePostPromotionRecovery({ store, registry: {} as ArtifactRegistry, workspacesRoot: '/nonexistent', projectId, runIntentHash: 'intent' });

  it('a promoted visual-refinement tip passes the same structural proof and continues into ordinary recovery', async () => {
    const projectId = 'proj_succ_5q_visual';
    await promotedChain(projectId, visual(1));

    // Owned now: it gets past lineage entirely, exactly as a replan tip does.
    const error = await recover(projectId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActiveContinuationCorrupt);
    expect((error as Error).message).toContain('the project document is missing');
  });

  it('a promoted typed replan tip passes the same proof and continues into ordinary recovery', async () => {
    const projectId = 'proj_succ_5q_replan';
    await promotedChain(projectId, replan(1));

    // It gets past lineage entirely: what stops this fixture is the project document it never had.
    const error = await recover(projectId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActiveContinuationCorrupt);
    expect((error as Error).message).toContain('the project document is missing');
  });
});
