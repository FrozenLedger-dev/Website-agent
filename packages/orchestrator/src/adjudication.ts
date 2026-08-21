/**
 * The adjudication artifact.
 *
 * The decision itself is `@statxai/policy-engine`'s. What stays here is the
 * persistence shape, which is a harness concern rather than a policy output.
 */
import type { AdjudicationAction } from '@statxai/contracts';
import type {
  AdjudicationAuthorization,
  AdjudicationConstraints,
  PolicyDefect,
} from '@statxai/policy-engine';

/**
 * The constraint snapshot as persisted: every input the decision was made from,
 * and nothing else.
 *
 * This kept only the defect ids at first, on the reasoning that the defects in
 * full already lived on the review outcome. That was wrong. `test-report` holds
 * the raw gate findings and `visual-review` holds the raw reviewer value; the
 * *merged* defect — the one policy actually sees, with the fingerprint the
 * repair budget is charged against — is computed by `mergeByFingerprint` and
 * existed only in memory. So an adjudication artifact could not explain its own
 * decision without recomputing the merge from two other artifacts.
 *
 * It now carries the minimal policy input for each blocking defect: id,
 * severity and fingerprint. That is what `legalAdjudicationActions` and
 * `authorizeAdjudication` read, so the record can be replayed through the
 * policy engine and reproduce the decision exactly — which is the whole point
 * of policy being deterministic. A test does precisely that.
 *
 * The verbose fields of a `Defect` — reason, location, acceptance test — are
 * still left out. They are genuinely on the review outcome, and they are not
 * inputs to any policy rule.
 *
 * Nothing *derived* is stored. `repairEligibility` and `maxRepairTargets` are
 * functions of the fields below, so recording them would create a second copy
 * that could disagree with the inputs. The replay test proves they can be
 * recomputed, which is a stronger guarantee than storing them.
 */
export interface RecordedConstraints extends Omit<AdjudicationConstraints, 'blockingDefects'> {
  blockingDefects: PolicyDefect[];
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
 * Written as an explicit projection rather than a spread. The orchestrator
 * passes its own `Defect`, which is structurally wider than `PolicyDefect`, so
 * a spread would carry the reviewer's prose into every adjudication artifact
 * whatever the declared type said.
 */
export function recordedConstraints(c: AdjudicationConstraints): RecordedConstraints {
  return {
    blockingDefects: c.blockingDefects.map((d) => ({
      id: d.id,
      severity: d.severity,
      fingerprint: d.fingerprint,
    })),
    repairsLeft: c.repairsLeft,
    repairsPerDefect: c.repairsPerDefect,
    repairsUsedByFingerprint: c.repairsUsedByFingerprint,
    replansLeft: c.replansLeft,
    reviewRejectionsLeft: c.reviewRejectionsLeft,
    previousRepairs: c.previousRepairs,
    autonomyMode: c.autonomyMode,
  };
}
