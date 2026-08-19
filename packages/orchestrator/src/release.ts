/**
 * Authorising a release.
 *
 * Sol recommends; the harness authorises. Keeping them apart is the whole point
 * of this module: the manifest used to record `approvedBy: "sol:machine-approval"`
 * for a decision no model was consulted about, which credited the model for the
 * harness's own arithmetic and left nothing to check the harness against.
 *
 * A recommendation is one input here, and never sufficient on its own. The
 * deterministic evidence and the autonomy policy can each refuse a release Sol
 * asked for, and none of them can be moved by anything Sol returns.
 */
import type { SolApprovalRecommendation } from '@statxai/contracts';

/** The version of these rules, recorded on every authorisation. */
export const RELEASE_POLICY_VERSION = 'harness-release-policy@1';

/**
 * What the harness knows for itself, independent of any model.
 *
 * Every field is measured. If a recommendation and these disagree, these win.
 */
export interface ReleaseEvidence {
  blockingDefects: number;
  buildSucceeded: boolean;
  gatesPassed: boolean;
  autonomyMode: string;
  deploymentConfigured: boolean;
}

export type ReleaseAction = 'release' | 'block' | 'human_review';

export interface ReleaseAuthorization {
  authorized: boolean;
  action: ReleaseAction;
  reason: string;
  policyVersion: string;
}

/**
 * Which acknowledged issue ids correspond to something actually open.
 *
 * An acknowledgement is a record that an issue was seen and judged acceptable.
 * An id nothing matches is not that — it may be a hallucination, a stale
 * reference or a typo — so it is separated out and recorded rather than counted
 * as a considered decision.
 */
export function verifyAcknowledged(
  acknowledged: readonly string[],
  openNonBlocking: readonly { id: string }[],
): { known: string[]; unknown: string[] } {
  const open = new Set(openNonBlocking.map((i) => i.id));
  return {
    known: acknowledged.filter((id) => open.has(id)),
    unknown: acknowledged.filter((id) => !open.has(id)),
  };
}

/**
 * Decide whether a release happens.
 *
 * The order matters. Deterministic facts are checked before the recommendation
 * is consulted at all, so a model saying `accept` over a failing gate cannot
 * reach the release path — the refusal is not a disagreement with Sol, it is
 * the harness declining to ask the question.
 *
 * A missing recommendation is not an approval. When Sol could not be consulted
 * the run stops in full autonomy, and is routed to a human where the autonomy
 * mode has one; the harness never substitutes its own verdict and calls it
 * Sol's.
 */
export function authorizeRelease(input: {
  recommendation: SolApprovalRecommendation | null;
  evidence: ReleaseEvidence;
}): ReleaseAuthorization {
  const { recommendation, evidence } = input;
  const decided = (authorized: boolean, action: ReleaseAction, reason: string) => ({
    authorized,
    action,
    reason,
    policyVersion: RELEASE_POLICY_VERSION,
  });

  // -- Deterministic policy, checked before any recommendation ---------------
  if (!evidence.buildSucceeded) {
    return decided(false, 'block', 'The build did not succeed, so there is nothing to release.');
  }
  if (evidence.blockingDefects > 0) {
    return decided(
      false,
      'block',
      `${evidence.blockingDefects} blocking defect(s) remain; blocking severity is harness policy and is not waivable by a recommendation.`,
    );
  }
  if (!evidence.gatesPassed) {
    return decided(false, 'block', 'The deterministic gates did not pass.');
  }

  // -- The recommendation ---------------------------------------------------
  if (!recommendation) {
    // Silence is not consent. In a mode with a human, the decision goes to
    // them; otherwise the run stops without deploying.
    return evidence.autonomyMode === 'full_autonomous'
      ? decided(false, 'block', 'No approval recommendation was obtained, and full autonomy has nobody to defer to.')
      : decided(false, 'human_review', 'No approval recommendation was obtained; deferring to a human.');
  }

  if (recommendation.recommendation === 'reject') {
    return decided(false, 'block', `Sol recommended rejection: ${recommendation.reason}`);
  }

  if (recommendation.recommendation === 'human_review') {
    /**
     * Sol may ask for a person; it may not summon one. Where the autonomy mode
     * has no human in it, the request is honoured as far as the policy allows —
     * by not releasing — rather than by inventing a review step.
     */
    return evidence.autonomyMode === 'full_autonomous'
      ? decided(
          false,
          'block',
          `Sol asked for human review, which full autonomy does not provide: ${recommendation.reason}`,
        )
      : decided(false, 'human_review', `Sol asked for human review: ${recommendation.reason}`);
  }

  // -- accept ---------------------------------------------------------------
  if (evidence.autonomyMode === 'human_in_the_loop') {
    return decided(
      false,
      'human_review',
      'Sol recommended acceptance, but this autonomy mode requires a human to release.',
    );
  }

  if (!evidence.deploymentConfigured) {
    // Not a refusal of the judgement — there is simply nowhere to publish.
    return decided(true, 'release', 'Sol recommended acceptance and policy permits release; no deployment target is configured.');
  }

  return decided(true, 'release', `Sol recommended acceptance and policy permits release: ${recommendation.reason}`);
}

/** What gets stored as the versioned `approval-recommendation` artifact. */
export interface ApprovalRecord {
  reviewCycle: number;
  sitePlanVersion: number | null;
  testReportVersion: number | null;
  visualReviewVersion: number | null;
  recommendation: 'accept' | 'reject' | 'human_review' | null;
  reason: string | null;
  acknowledgedIssues: string[];
  /** Acknowledged ids that match nothing currently open. */
  unverifiableIssues: string[];
  model: string | null;
  modelFailure: string | null;
  decidedAt: Date;
}

/** What gets stored as the versioned `release-authorization` artifact. */
export interface AuthorizationRecord {
  reviewCycle: number;
  /** The recommendation this considered, by artifact version. */
  recommendationVersion: number | null;
  recommendation: 'accept' | 'reject' | 'human_review' | null;
  evidence: ReleaseEvidence;
  authorized: boolean;
  action: ReleaseAction;
  reason: string;
  policyVersion: string;
  /** Always the harness. A model never appears here. */
  authorizedBy: 'harness-policy';
  authorizedAt: Date;
}
