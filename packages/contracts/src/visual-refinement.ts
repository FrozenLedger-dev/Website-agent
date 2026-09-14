/**
 * Visual refinement source — the exact canonical source a Terra visual
 * refinement starts from.
 *
 * Harness-written, never model-written. It is read from the canonical Git
 * history at one exact commit (the commit the triggering screenshots rendered),
 * after that commit has been proven to be canonical HEAD and to descend from the
 * exact promotion of the predecessor build. The model receives this snapshot as
 * context; it never reads the canonical workspace itself.
 *
 * Its content hash, carried by the artifact reference, is part of the
 * refinement job's identity — so the predecessor, the commit and the cycle it
 * names are pinned by the job that answers it.
 */
import * as z from 'zod/v4';
import { ArtifactRef } from './primitives.js';

export const VISUAL_REFINEMENT_SOURCE_SCHEMA_VERSION = 'statxai-visual-refinement-source@1';

/** Bounds on a source snapshot. A larger site is not refined: the snapshot is refused, never truncated. */
export const VISUAL_REFINEMENT_SOURCE_LIMITS = Object.freeze({ maxFiles: 80, maxBytes: 400_000 });

export const VisualRefinementSource = z.strictObject({
  schemaVersion: z.literal(VISUAL_REFINEMENT_SOURCE_SCHEMA_VERSION),
  projectId: z.string().min(1),
  /** The exact promoted canonical build being refined. */
  predecessorBindingId: z.string().min(1),
  promotionId: z.string().min(1),
  promotionCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** The exact canonical commit the source was read at — the commit the triggering screenshots rendered. */
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  /** 1 for a lineage's first visual refinement, then 2, … */
  refinementCycle: z.number().int().min(1).max(1_000),
  /** The review and screenshot set that authorised this refinement. */
  visualQualityReview: ArtifactRef,
  screenshotSet: ArtifactRef,
  /** Every model-writable source file tracked at `sourceCommit`, sorted by path. */
  files: z
    .array(z.strictObject({ path: z.string().min(1), contents: z.string() }))
    .max(VISUAL_REFINEMENT_SOURCE_LIMITS.maxFiles),
  /** sha256 over every file's path and contents, in path order. */
  filesDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type VisualRefinementSource = z.infer<typeof VisualRefinementSource>;
