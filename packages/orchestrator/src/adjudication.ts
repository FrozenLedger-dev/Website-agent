/**
 * The adjudication artifact.
 *
 * The decision itself is `@statxai/policy-engine`'s. What stays here is the
 * persistence shape, which is a harness concern rather than a policy output.
 */
import type { AdjudicationAction } from '@statxai/contracts';
import type { AdjudicationAuthorization, AdjudicationConstraints } from '@statxai/policy-engine';

/** What gets stored as the versioned `adjudication-decision` artifact. */
export interface AdjudicationRecord {
  reviewCycle: number;
  action: AdjudicationAction;
  source: AdjudicationAuthorization['source'];
  refusal: string | null;
  targetDefectIds: string[];
  legalActions: AdjudicationAction[];
  constraints: AdjudicationConstraints;
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
