/**
 * Semantic-edit build successors against real durable state.
 *
 * A successor may exist because an exact editable-site-model revision needs
 * implementing: it names the exact model its predecessor carries and the exact
 * model it must carry, shares the one successor slot with replans and visual
 * refinements, inherits the lineage root, is read through the one lineage
 * reader, and is recognised by Phase 5q as sound lineage whose continuation it
 * does not own yet. Nothing here creates one in production: the state API only.
 *
 * Integration: needs the Mongo replica set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ReplanSuccessorProvenance,
  SemanticEditSuccessorProvenance,
  VisualRefinementSuccessorProvenance,
  type ArtifactRef,
  type BuildSuccessorProvenance,
} from '@statxai/contracts';
import type { SemanticEditSuccessorProvenance as SemanticEditShape } from '@statxai/contracts';
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
  await store.frontendBackendBuildBindings.deleteMany({ projectId: /^proj_sem_/ });
});

const hex = (n: number) => n.toString(16).padStart(64, '0');
const model = (version: number): ArtifactRef => ({ name: 'editable-site-model', version, contentHash: hex(version) });
const replan = (version: number): BuildSuccessorProvenance => ReplanSuccessorProvenance.parse({ kind: 'replan', replanDecision: { name: 'replan-decision', version } });
const visual = (cycle: number): BuildSuccessorProvenance =>
  VisualRefinementSuccessorProvenance.parse({
    kind: 'visual_refinement',
    visualQualityReview: { name: 'visual-quality-review', version: cycle, contentHash: 'a'.repeat(64) },
    screenshotSet: { name: 'screenshot-set', version: cycle, contentHash: 'b'.repeat(64) },
    refinementCycle: cycle,
  });
const edit = (base: number, result: number): BuildSuccessorProvenance =>
  SemanticEditSuccessorProvenance.parse({ kind: 'semantic_edit', baseEditableSiteModel: model(base), editableSiteModel: model(result) });

type Lineage = { predecessorBindingId: string; provenance: BuildSuccessorProvenance };

/** A generation that carries editable-site-model version `modelVersion` — the spec shape its reason calls for. */
function inputFor(projectId: string, marker: string, modelVersion: number, lineage?: Lineage) {
  const businessProfileRef: ArtifactRef = { name: 'business-profile', version: 1 };
  const sitePlanRef: ArtifactRef = { name: 'site-plan', version: 1 };
  const provenance = lineage?.provenance;
  const base =
    provenance?.kind === 'visual_refinement'
      ? createFrontendBackendVisualRefinementJobSpec({
          projectId,
          businessProfileRef,
          sitePlanRef,
          visualRefinementSourceRef: { name: 'visual-refinement-source', version: provenance.refinementCycle, contentHash: 'c'.repeat(64) },
          visualQualityReviewRef: provenance.visualQualityReview as ArtifactRef,
          screenshotSetRef: provenance.screenshotSet as ArtifactRef,
          editableSiteModelRef: model(modelVersion),
        })
      : createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef, editableSiteModelRef: model(modelVersion) });
  return {
    projectId,
    runIntentHash: 'intent',
    businessProfileRef,
    sitePlanRef,
    jobSpec: { ...base, objective: `Build generation ${marker}.` },
    specificationBaseCommit: null,
    ...(lineage ? { lineage } : {}),
  };
}
const prepare = (projectId: string, marker: string, modelVersion: number, lineage?: Lineage) =>
  prepareFrontendBackendBuildBinding(store, inputFor(projectId, marker, modelVersion, lineage));
const promote = (id: string, n: number) => finalizeBindingPromoted(store, id, { promotionId: `promo-${n}`, promotionCommitSha: String(n).repeat(40).slice(0, 40) });
const reload = async (id: string) => (await store.frontendBackendBuildBindings.findOne({ _id: id }))!;
const tipOf = async (projectId: string) => deriveActiveLineageTip(store, (await findActiveLineageRoot(store, projectId))!);

describe('preparing a semantic-edit successor', () => {
  it('records the exact predecessor and both exact models, inherits the root, takes no lineage slot, and reads back as semantic_edit', async () => {
    const projectId = 'proj_sem_prepare';
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);

    const b1 = await prepare(projectId, '1', 2, { predecessorBindingId: b0._id, provenance: edit(1, 2) });
    const raw = await reload(b1._id);

    expect(raw.predecessorBindingId).toBe(b0._id);
    expect(raw.successorProvenance).toEqual({ kind: 'semantic_edit', baseEditableSiteModel: model(1), editableSiteModel: model(2) });
    expect(raw).not.toHaveProperty('replanDecision');
    expect(raw.lineageRootBindingId).toBe(b0._id);
    expect(raw.activeLineage).toBeUndefined();
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, activeLineage: true })).toBe(1);

    const position = readBuildLineage(raw);
    expect(position).toEqual({ kind: 'successor', predecessorBindingId: b0._id, provenance: edit(1, 2) });
    expect(position.kind === 'successor' && position.provenance.kind).toBe('semantic_edit');
  });

  it('exact replay converges; any other model, kind or presentation as an initial build fails closed', async () => {
    const projectId = 'proj_sem_consistency';
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);
    const input = inputFor(projectId, '1', 2, { predecessorBindingId: b0._id, provenance: edit(1, 2) });
    const first = await prepareFrontendBackendBuildBinding(store, input);
    expect((await prepareFrontendBackendBuildBinding(store, input))._id).toBe(first._id);

    const stored = await reload(first._id);
    const spec = parseStoredJobSpec(stored);
    expect(() => verifyBindingConsistency(stored, spec, { predecessorBindingId: b0._id, provenance: edit(1, 2) }, b0._id)).not.toThrow();
    for (const provenance of [
      edit(1, 3),
      SemanticEditSuccessorProvenance.parse({ kind: 'semantic_edit', baseEditableSiteModel: model(1), editableSiteModel: { ...model(2), contentHash: 'f'.repeat(64) } }),
      SemanticEditSuccessorProvenance.parse({ kind: 'semantic_edit', baseEditableSiteModel: { ...model(1), contentHash: 'e'.repeat(64) }, editableSiteModel: model(2) }),
      replan(1),
      visual(1),
    ]) {
      expect(() => verifyBindingConsistency(stored, spec, { predecessorBindingId: b0._id, provenance }, b0._id)).toThrow(FrontendBackendBuildBindingCorrupt);
    }
    expect(() => verifyBindingConsistency(stored, spec)).toThrow(/semantic_edit successor but was presented as an initial build/);
  });

  it('binds both models to builds: the base must be exactly what the predecessor carries, and the spec must pin exactly the result', async () => {
    const projectId = 'proj_sem_binding';
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);

    await expect(prepare(projectId, '1', 3, { predecessorBindingId: b0._id, provenance: edit(2, 3) })).rejects.toBeInstanceOf(FrontendBackendBuildSuccessorProvenanceInvalid);
    await expect(prepare(projectId, '1', 5, { predecessorBindingId: b0._id, provenance: edit(1, 2) })).rejects.toBeInstanceOf(FrontendBackendBuildSuccessorProvenanceInvalid);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);

    // A stored spec that no longer pins the implemented model is corrupt, never repaired.
    const b1 = await prepare(projectId, '1', 2, { predecessorBindingId: b0._id, provenance: edit(1, 2) });
    const stored = await reload(b1._id);
    const tampered = { ...stored.jobSpec, inputs: { ...stored.jobSpec.inputs, editableSiteModel: model(9) } };
    expect(() => verifyBindingConsistency(stored, tampered, { predecessorBindingId: b0._id, provenance: edit(1, 2) }, b0._id)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it.each([
    ['a missing result model', { kind: 'semantic_edit', baseEditableSiteModel: model(1) }],
    ['a wrong artifact name', { kind: 'semantic_edit', baseEditableSiteModel: model(1), editableSiteModel: { ...model(2), name: 'site-plan' } }],
    ['an unhashed ref', { kind: 'semantic_edit', baseEditableSiteModel: model(1), editableSiteModel: { name: 'editable-site-model', version: 2 } }],
    ['an unknown kind', { kind: 'customer_edit', baseEditableSiteModel: model(1), editableSiteModel: model(2) }],
  ])('refuses %s before anything is written', async (_label, provenance) => {
    const projectId = 'proj_sem_invalid';
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);
    await expect(prepare(projectId, '1', 2, { predecessorBindingId: b0._id, provenance: provenance as BuildSuccessorProvenance })).rejects.toBeInstanceOf(FrontendBackendBuildSuccessorProvenanceInvalid);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
  });
});

describe('historical and existing reasons are unchanged', () => {
  it('an initial root, a historical replan (replanDecision only) and a typed visual refinement read exactly as before', async () => {
    const projectId = 'proj_sem_legacy';
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);
    expect(readBuildLineage(await reload(b0._id))).toEqual({ kind: 'initial' });

    const legacy: FrontendBackendBuildBindingDocument = { ...(await reload(b0._id)), _id: `${b0._id}-legacy`, predecessorBindingId: b0._id, replanDecision: { name: 'replan-decision', version: 4 }, updatedAt: new Date() };
    delete legacy.activeLineage;
    expect(readBuildLineage(legacy)).toEqual({ kind: 'successor', predecessorBindingId: b0._id, provenance: { kind: 'replan', replanDecision: { name: 'replan-decision', version: 4 } } });

    const v = await prepare(`${projectId}_v`, '0', 1);
    await promote(v._id, 1);
    const v1 = await prepare(`${projectId}_v`, '1', 1, { predecessorBindingId: v._id, provenance: visual(1) });
    expect(readBuildLineage(await reload(v1._id))).toEqual({ kind: 'successor', predecessorBindingId: v._id, provenance: visual(1) });
    expect((await reload(v1._id)).successorProvenance).toEqual(visual(1));
  });
});

describe('contradictory stored shapes fail closed', () => {
  const base = (over: Partial<FrontendBackendBuildBindingDocument>): FrontendBackendBuildBindingDocument => {
    const spec = createFrontendBackendJobSpec({ projectId: 'proj_sem_shapes', businessProfileRef: { name: 'business-profile', version: 1 }, sitePlanRef: { name: 'site-plan', version: 1 }, editableSiteModelRef: model(2) });
    return {
      _id: 'shape', projectId: 'proj_sem_shapes', status: 'promoted', runIntentHash: 'intent', businessProfile: { name: 'business-profile', version: 1 }, sitePlan: { name: 'site-plan', version: 1 },
      jobSpec: spec, jobSpecHash: 'x', jobId: spec.jobId, specificationBaseCommit: null, specificationCommitSha: null, promotionId: null, promotionCommitSha: null,
      lineageRootBindingId: 'root', createdAt: new Date(), updatedAt: new Date(), ...over,
    };
  };
  const editStored = edit(1, 2) as SemanticEditShape;

  it.each([
    ['semantic-edit provenance without a predecessor (a root carrying it)', { successorProvenance: editStored }],
    ['a legacy replanDecision beside semantic-edit provenance', { predecessorBindingId: 'root', replanDecision: { name: 'replan-decision', version: 1 }, successorProvenance: editStored }],
    ['a stored semantic edit naming the wrong artifact', { predecessorBindingId: 'root', successorProvenance: { kind: 'semantic_edit', baseEditableSiteModel: model(1), editableSiteModel: { ...model(2), name: 'screenshot-set' } } as never }],
    ['a stored semantic edit with a malformed hash', { predecessorBindingId: 'root', successorProvenance: { kind: 'semantic_edit', baseEditableSiteModel: { ...model(1), contentHash: 'zz' }, editableSiteModel: model(2) } as never }],
    ['a stored semantic edit missing its base', { predecessorBindingId: 'root', successorProvenance: { kind: 'semantic_edit', editableSiteModel: model(2) } as never }],
    ['an unknown stored kind', { predecessorBindingId: 'root', successorProvenance: { kind: 'customer_edit', baseEditableSiteModel: model(1), editableSiteModel: model(2) } as never }],
  ])('%s', (_label, over) => {
    expect(() => readBuildLineage(base(over))).toThrow(FrontendBackendBuildBindingCorrupt);
  });
});

describe('one successor slot, whatever the reason', () => {
  it.each([
    ['a replan blocks a semantic edit', replan(1), edit(1, 2)],
    ['a visual refinement blocks a semantic edit', visual(1), edit(1, 2)],
    ['a semantic edit blocks a replan', edit(1, 2), replan(1)],
    ['a semantic edit blocks a visual refinement', edit(1, 2), visual(1)],
  ])('%s from the same predecessor', async (_label, first, second) => {
    const projectId = `proj_sem_slot_${first.kind}_${second.kind}`;
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);
    await prepare(projectId, 'first', first.kind === 'semantic_edit' ? 2 : 1, { predecessorBindingId: b0._id, provenance: first });
    const refused = await prepare(projectId, 'second', second.kind === 'semantic_edit' ? 2 : 1, { predecessorBindingId: b0._id, provenance: second }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FrontendBackendBuildLineageConflict);
    // The diagnostic names the exact existing successor, whatever its reason.
    const existing = await store.frontendBackendBuildBindings.findOne({ projectId, predecessorBindingId: b0._id });
    expect((refused as FrontendBackendBuildLineageConflict).message).toContain(existing!._id);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, predecessorBindingId: b0._id })).toBe(1);
  });
});

describe('mixed lineages', () => {
  it('root → replan → visual refinement → semantic edit → replan derives one exact tip, every member on the one root', async () => {
    const projectId = 'proj_sem_mixed';
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '1', 2, { predecessorBindingId: b0._id, provenance: replan(1) });
    await promote(b1._id, 2);
    const b2 = await prepare(projectId, '2', 2, { predecessorBindingId: b1._id, provenance: visual(1) });
    await promote(b2._id, 3);
    const b3 = await prepare(projectId, '3', 3, { predecessorBindingId: b2._id, provenance: edit(2, 3) });
    await promote(b3._id, 4);
    expect((await tipOf(projectId))._id).toBe(b3._id);
    const b4 = await prepare(projectId, '4', 4, { predecessorBindingId: b3._id, provenance: replan(2) });

    expect((await tipOf(projectId))._id).toBe(b4._id);
    for (const b of [b1, b2, b3, b4]) expect((await reload(b._id)).lineageRootBindingId).toBe(b0._id);
  });

  it('the walk still refuses a branch, a cycle, a foreign root and an unreachable semantic edit — and never a well-formed one', async () => {
    const projectId = 'proj_sem_walk';
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '1', 2, { predecessorBindingId: b0._id, provenance: edit(1, 2) });
    await promote(b1._id, 2);
    const root = (await findActiveLineageRoot(store, projectId))!;
    expect((await deriveActiveLineageTip(store, root))._id).toBe(b1._id);

    const raw = await reload(b1._id);
    const clone = (over: Partial<FrontendBackendBuildBindingDocument>) => store.frontendBackendBuildBindings.insertOne({ ...raw, jobId: `job_${Math.random().toString(16).slice(2)}`, status: 'promoted', ...over });

    // Unreachable: claims the root, but its predecessor is not in the chain.
    await clone({ _id: `${b1._id}-orphan`, predecessorBindingId: 'nowhere' });
    await expect(deriveActiveLineageTip(store, root)).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
    await store.frontendBackendBuildBindings.deleteOne({ _id: `${b1._id}-orphan` });

    // Foreign root on a semantic-edit successor.
    await store.frontendBackendBuildBindings.updateOne({ _id: b1._id }, { $set: { lineageRootBindingId: 'someone-else' } });
    await expect(deriveActiveLineageTip(store, root)).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
    await store.frontendBackendBuildBindings.updateOne({ _id: b1._id }, { $set: { lineageRootBindingId: b0._id } });

    // A cycle back to the root.
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $set: { predecessorBindingId: b1._id, successorProvenance: edit(2, 3) as never } });
    await expect(deriveActiveLineageTip(store, root)).rejects.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $unset: { predecessorBindingId: '', successorProvenance: '' } });

    expect((await deriveActiveLineageTip(store, root))._id).toBe(b1._id);
  });

  it('a branch is impossible at the index, whatever the reasons', async () => {
    const projectId = 'proj_sem_branch';
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '1', 2, { predecessorBindingId: b0._id, provenance: edit(1, 2) });
    await promote(b1._id, 2);
    // A second, promoted successor of B0 with a different reason, written straight past the API.
    const raw: Partial<FrontendBackendBuildBindingDocument> = { ...(await reload(b1._id)) };
    delete raw.successorProvenance;
    await expect(store.frontendBackendBuildBindings.insertOne({ ...raw, _id: `${b1._id}-branch`, jobId: 'job_branch', replanDecision: { name: 'replan-decision', version: 1 } } as FrontendBackendBuildBindingDocument)).rejects.toMatchObject({ code: 11000 });
  });
});

describe('Phase 5q', () => {
  async function promotedChain(projectId: string, reason: BuildSuccessorProvenance, modelVersion: number) {
    const b0 = await prepare(projectId, '0', 1);
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, '1', modelVersion, { predecessorBindingId: b0._id, provenance: reason });
    await promote(b1._id, 2);
    await store.frontendBackendBuildBindings.updateMany({ projectId }, { $set: { specificationCommitSha: 'e'.repeat(40) } });
    return b1;
  }
  const recover = (projectId: string) => resolvePostPromotionRecovery({ store, registry: {} as ArtifactRegistry, workspacesRoot: '/nonexistent', projectId, runIntentHash: 'intent', completionTarget: 'release' }).catch((e: unknown) => e);

  it('a promoted semantic-edit tip with no draft handed to its edit is proven structurally, then fails closed — never continued as another kind', async () => {
    const b1 = await promotedChain('proj_sem_5q_edit', edit(1, 2), 2);
    const error = await recover('proj_sem_5q_edit');
    expect(error).toBeInstanceOf(ActiveContinuationCorrupt);
    expect(error).not.toBeInstanceOf(FrontendBackendBuildLineageCorrupt);
    expect((error as Error).message).toContain(`semantic edit build "${b1._id}" is the active tip, but no canonical draft is handed to its edit`);
  });

  it.each([
    ['replan', replan(1), 1],
    ['visual refinement', visual(1), 1],
  ] as const)('a promoted %s tip is still owned: it passes lineage and continues into ordinary recovery', async (label, reason, modelVersion) => {
    const projectId = `proj_sem_5q_${label.replace(' ', '_')}`;
    await promotedChain(projectId, reason, modelVersion);
    const error = await recover(projectId);
    expect(error).toBeInstanceOf(ActiveContinuationCorrupt);
    expect((error as Error).message).toContain('the project document is missing');
  });
});
