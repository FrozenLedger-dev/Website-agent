/**
 * Semantic edit source — the exact canonical source a Terra semantic edit
 * starts from, and the exact semantic delta it must implement.
 *
 * Harness-written, never model-written. The source is read from canonical Git
 * history at one exact commit, after that commit has been proven to be
 * canonical HEAD and to descend from the exact promotion of the build the
 * claimed canonical draft owns. The two model versions and the one patch that
 * turned the first into the second are pinned alongside it, so the model is
 * told exactly what changed and exactly what did not.
 *
 * Its content hash, carried by the artifact reference, is part of the edit
 * job's identity. Nothing here names a person, a session or a credential.
 */
import * as z from 'zod/v4';
import { ArtifactRef } from './primitives.js';
import { EDITABLE_SITE_MODEL_ARTIFACT, SemanticPatch } from './editable-site-model.js';
import { VISUAL_REFINEMENT_SOURCE_LIMITS } from './visual-refinement.js';

export const SEMANTIC_EDIT_SOURCE_SCHEMA_VERSION = 'statxai-semantic-edit-source@1';

/**
 * Bounds on a source snapshot — the same bounds as a visual refinement, because
 * it is the same model receiving the same exact source. A larger site is not
 * edited: the snapshot is refused, never truncated.
 */
export const SEMANTIC_EDIT_SOURCE_LIMITS = VISUAL_REFINEMENT_SOURCE_LIMITS;

const ExactModelRef = ArtifactRef.extend({ name: z.literal(EDITABLE_SITE_MODEL_ARTIFACT), contentHash: z.string().regex(/^[a-f0-9]{64}$/) });
const Sha = z.string().regex(/^[a-f0-9]{40}$/);

export const SemanticEditSource = z.strictObject({
  schemaVersion: z.literal(SEMANTIC_EDIT_SOURCE_SCHEMA_VERSION),
  projectId: z.string().min(1),
  /** The durable intent this edit answers. */
  intentId: z.string().min(1),
  /** The exact canonical draft that was claimed, and the exact build it owns. */
  sourceDraftId: z.string().min(1),
  predecessorBindingId: z.string().min(1),
  promotionId: z.string().min(1),
  promotionCommitSha: Sha,
  /** The exact canonical commit the source was read at. */
  sourceCommit: Sha,
  /** The model the predecessor build carries, and the model this edit must implement. */
  baseEditableSiteModel: ExactModelRef,
  editableSiteModel: ExactModelRef,
  /** The one bounded patch that turned the base into the result. */
  patch: SemanticPatch,
  /** Every model-writable source file tracked at `sourceCommit`, sorted by path. */
  files: z
    .array(z.strictObject({ path: z.string().min(1), contents: z.string() }))
    .max(SEMANTIC_EDIT_SOURCE_LIMITS.maxFiles),
  /** sha256 over every file's path and contents, in path order. */
  filesDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SemanticEditSource = z.infer<typeof SemanticEditSource>;
