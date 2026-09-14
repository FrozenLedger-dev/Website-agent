/**
 * Whether the canonical build should be visually refined — the harness's
 * decision, never the model's.
 *
 * One pure, versioned policy over structured evidence only: the exact
 * `visual-quality-review` of the build's rendered screenshots, the review that
 * triggered the build (when it is itself a refinement), the durable budget, the
 * project state and whether a release already owns the lineage. Nothing here
 * reads prose, asks a model, or looks anything up.
 */
import type { ProjectState } from '@statxai/state';
import type { VisualQualityDimension, VisualQualityReview } from '@statxai/contracts';

/**
 * The one visual refinement policy. Every value that decides eligibility is
 * here, and a change to any of them is a new version.
 *
 * Scores are the reviewer's 0-100 scale, on which 100 is work a design-led
 * studio would publish. Below 80 overall is visibly short of that bar. The four
 * critical dimensions are the ones a refinement of the same plan can actually
 * move — composition, typography, hierarchy and the phone layout — and below 70
 * on any of them is a weakness a visitor sees immediately. A `major` issue is
 * the reviewer's own highest severity.
 */
export const VISUAL_REFINEMENT_POLICY = Object.freeze({
  version: 'statxai-visual-refinement-policy@1',
  overallBelow: 80,
  criticalDimensions: Object.freeze(['composition', 'typography', 'hierarchy', 'mobileQuality'] as const satisfies readonly VisualQualityDimension[]),
  criticalDimensionBelow: 70,
  refineOnMajorIssue: true,
  /** Automated refinement only from a review that captured and judged every expected target. */
  requireCompleteCoverage: true,
});

export type VisualRefinementIneligible =
  | 'awaiting_human_review'
  | 'release_publication_exists'
  | 'review_unusable'
  | 'coverage_incomplete'
  | 'quality_sufficient'
  | 'not_improved'
  | 'budget_exhausted'
  /** The exact source is larger than a refinement may be given. Decided by the authorisation, never truncated. */
  | 'source_too_large';

export type VisualRefinementTrigger =
  | { readonly kind: 'overall_below'; readonly score: number }
  | { readonly kind: 'dimension_below'; readonly dimension: VisualQualityDimension; readonly score: number }
  | { readonly kind: 'major_issue'; readonly issueId: string };

export type VisualRefinementDecision =
  | { readonly refine: true; readonly policyVersion: string; readonly triggers: readonly VisualRefinementTrigger[] }
  | { readonly refine: false; readonly policyVersion: string; readonly reason: VisualRefinementIneligible; readonly detail: string };

export interface VisualRefinementEligibilityInput {
  /** The exact review of the canonical build's exact screenshots. */
  readonly review: VisualQualityReview;
  /**
   * When the canonical build is itself a visual refinement: the exact review
   * that triggered it. A further pass is allowed only when this build scored
   * strictly higher overall — refinement that did not improve stops.
   */
  readonly triggeringReview: VisualQualityReview | null;
  readonly projectState: ProjectState;
  /** Whether any release publication, in any status, already exists for the lineage. */
  readonly releasePublicationExists: boolean;
  /** The durable budget as stored. Absent values are a budget that predates visual refinement: nothing remains. */
  readonly budget: { readonly used: number | undefined; readonly limit: number | undefined };
}

export function decideVisualRefinement(input: VisualRefinementEligibilityInput): VisualRefinementDecision {
  const policy = VISUAL_REFINEMENT_POLICY;
  const no = (reason: VisualRefinementIneligible, detail: string): VisualRefinementDecision => ({ refine: false, policyVersion: policy.version, reason, detail });

  // Fences first: nothing about the evidence matters while a person or a release owns the project.
  if (input.projectState === 'awaiting_human_review') return no('awaiting_human_review', 'the project is awaiting human review');
  if (input.releasePublicationExists) return no('release_publication_exists', 'a release publication already owns this lineage');

  const { review } = input;
  if (review.status !== 'reviewed' || !review.assessment) return no('review_unusable', `the visual review is ${review.status}`);
  if (policy.requireCompleteCoverage && !review.coverage.complete) {
    return no('coverage_incomplete', `the visual review judged ${review.coverage.reviewedTargets}/${review.coverage.expectedTargets} targets`);
  }

  const { used, limit } = input.budget;
  if (used === undefined || limit === undefined || used >= limit) {
    return no('budget_exhausted', `visual refinements used ${used ?? '(none recorded)'} of ${limit ?? '(no limit recorded)'}`);
  }

  const assessment = review.assessment;
  const triggers: VisualRefinementTrigger[] = [];
  if (assessment.overallScore < policy.overallBelow) triggers.push({ kind: 'overall_below', score: assessment.overallScore });
  for (const dimension of policy.criticalDimensions) {
    const score = assessment.scores[dimension];
    if (score < policy.criticalDimensionBelow) triggers.push({ kind: 'dimension_below', dimension, score });
  }
  if (policy.refineOnMajorIssue) {
    for (const issue of assessment.issues) if (issue.severity === 'major') triggers.push({ kind: 'major_issue', issueId: issue.id });
  }
  if (triggers.length === 0) return no('quality_sufficient', `overall ${assessment.overallScore} meets the policy`);

  if (input.triggeringReview) {
    const before = input.triggeringReview.assessment?.overallScore;
    if (before === undefined || !(assessment.overallScore > before)) {
      return no('not_improved', `overall ${assessment.overallScore} is not above the ${before ?? '(unscored)'} that triggered the previous refinement`);
    }
  }

  return { refine: true, policyVersion: policy.version, triggers };
}
