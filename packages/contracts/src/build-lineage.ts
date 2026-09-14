/**
 * Why a frontend/backend build succeeds the one before it.
 *
 * A build binding is either a lineage's initial build — no predecessor, no
 * reason — or a successor: an exact predecessor plus exactly one typed reason.
 * The reason is what makes a successor honest. A replan successor answers an
 * exact replan decision; a visual-refinement successor answers an exact visual
 * quality review of an exact screenshot set. Neither may pose as the other.
 *
 * This is identity, not behaviour: nothing here decides whether a refinement
 * is allowed, how many there may be, or what a refinement changes.
 */
import * as z from 'zod/v4';
import { ArtifactRef } from './primitives.js';

/** An `ArtifactRef` that names exactly the artifact it must be. */
function refNamed<Name extends string>(name: Name) {
  return ArtifactRef.extend({ name: z.literal(name) });
}

export const ReplanSuccessorProvenance = z.strictObject({
  kind: z.literal('replan'),
  /** The exact `replan-decision` that authorised replacing the predecessor. */
  replanDecision: refNamed('replan-decision'),
});
export type ReplanSuccessorProvenance = z.infer<typeof ReplanSuccessorProvenance>;

export const VisualRefinementSuccessorProvenance = z.strictObject({
  kind: z.literal('visual_refinement'),
  /** The exact multimodal review whose findings the successor answers. */
  visualQualityReview: refNamed('visual-quality-review'),
  /** The exact screenshot set that review judged. */
  screenshotSet: refNamed('screenshot-set'),
  /** 1 for a lineage's first visual refinement, then 2, … — identity only; how many are allowed is budget policy, not this. */
  refinementCycle: z.number().int().min(1).max(1_000),
});
export type VisualRefinementSuccessorProvenance = z.infer<typeof VisualRefinementSuccessorProvenance>;

/** An exact editable-site-model version: its name, version and content hash, all three. */
const ExactEditableSiteModelRef = refNamed('editable-site-model').extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) });

/**
 * A successor that implements an exact editable-site-model revision.
 *
 * Build identity only — not a copy of the edit. `baseEditableSiteModel` is the
 * exact model the predecessor build carries; `editableSiteModel` is the exact
 * model this build must carry. Which patches lead from one to the other is the
 * models' own immutable provenance, and who asked for the edit belongs to the
 * edit's own record, never to build lineage.
 */
export const SemanticEditSuccessorProvenance = z
  .strictObject({
    kind: z.literal('semantic_edit'),
    baseEditableSiteModel: ExactEditableSiteModelRef,
    editableSiteModel: ExactEditableSiteModelRef,
  })
  .refine((value) => value.baseEditableSiteModel.version !== value.editableSiteModel.version, {
    message: 'a semantic edit implements a different model version than its base',
  });
export type SemanticEditSuccessorProvenance = z.infer<typeof SemanticEditSuccessorProvenance>;

export const BuildSuccessorProvenance = z.discriminatedUnion('kind', [ReplanSuccessorProvenance, VisualRefinementSuccessorProvenance, SemanticEditSuccessorProvenance]);
export type BuildSuccessorProvenance = z.infer<typeof BuildSuccessorProvenance>;
