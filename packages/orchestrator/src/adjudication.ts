/**
 * The adjudication artifact.
 *
 * The decision itself is `@statxai/policy-engine`'s. What stays here is the
 * persistence shape, which is a harness concern rather than a policy output.
 */
import type { AdjudicationAction } from '@statxai/contracts';
import type { AdjudicationAuthorization, AdjudicationConstraints } from '@statxai/policy-engine';

/**
 * The constraint snapshot as persisted.
 *
 * Policy now reasons over the blocking defects themselves rather than a count,
 * because per-defect repair eligibility cannot be read off one. The artifact
 * keeps only their ids: the defects in full already live on the review outcome
 * for the same cycle, and repeating them here would duplicate the largest part
 * of the run record without adding evidence.
 *
 * `repairsUsedByFingerprint` is kept in full. It is small, and it is the reason
 * an action was or was not offered — which is exactly what an operator reading
 * a refusal afterwards needs to see.
 */
export interface RecordedConstraints extends Omit<AdjudicationConstraints, 'blockingDefects'> {
  blockingDefectIds: string[];
}

/** What gets stored as the versioned `adjudication-decision` artifact. */
export interface AdjudicationRecord {
  reviewCycle: number;
  action: AdjudicationAction;
  source: AdjudicationAuthorization['source'];
  refusal: string | null;
  targetDefectIds: string[];
  legalActions: AdjudicationAction[];
  constraints: RecordedConstraints;
  /** Sol's own words, kept even when the harness did not follow them. */
  proposed: {
    action: AdjudicationAction;
    reason: string;
    defectIds: string[];
    objective: string | null;
    scope: string | null;
  } | null;
  modelFailure: string | null;
  decidedAt: Date;
}

/**
 * Project the live constraints onto the persisted shape.
 *
 * Written as an explicit projection rather than a spread: a spread would carry
 * `blockingDefects` into the artifact whatever the declared type said, and the
 * whole point is that it does not go in.
 */
export function recordedConstraints(c: AdjudicationConstraints): RecordedConstraints {
  return {
    blockingDefectIds: c.blockingDefects.map((d) => d.id),
    repairsLeft: c.repairsLeft,
    repairsPerDefect: c.repairsPerDefect,
    repairsUsedByFingerprint: c.repairsUsedByFingerprint,
    replansLeft: c.replansLeft,
    reviewRejectionsLeft: c.reviewRejectionsLeft,
    previousRepairs: c.previousRepairs,
    autonomyMode: c.autonomyMode,
  };
}
