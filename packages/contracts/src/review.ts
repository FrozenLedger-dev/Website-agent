/**
 * Structured rejection contract, defect fingerprinting, and severity/release
 * policy (v1.2 §7).
 *
 * The governing rule from the document: a reviewer cannot issue an unbounded
 * subjective "not good enough". Every rejection must name a failed criterion,
 * classify severity, locate the defect, and state the test that proves the
 * repair is complete.
 */
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { AgentTier, ArtifactRef, JobId, ProjectId } from './primitives.js';

// ---------------------------------------------------------------------------
// Severity and release policy (v1.2 §7, "Severity & Release Policy")
// ---------------------------------------------------------------------------

export const Severity = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Severity = z.infer<typeof Severity>;

export const SEVERITY_POLICY = Object.freeze({
  P0: { blocksRelease: true, meaning: 'Security, data integrity, broken production path' },
  P1: { blocksRelease: true, meaning: 'Required acceptance criterion fails; core flow unusable' },
  P2: { blocksRelease: false, meaning: 'Quality issue; core website remains usable' },
  P3: { blocksRelease: false, meaning: 'Subjective polish or non-required enhancement' },
} as const satisfies Record<Severity, { blocksRelease: boolean; meaning: string }>);

/** Severities that must be fixed before release. */
export function blocksRelease(severity: Severity): boolean {
  return SEVERITY_POLICY[severity].blocksRelease;
}

// ---------------------------------------------------------------------------
// Defect fingerprint
// ---------------------------------------------------------------------------

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Budget key for "max 2 repair attempts per defect fingerprint" (§7).
 *
 * Derived from `category` and `location` ONLY. `acceptance_test` and `reason`
 * are deliberately excluded even though both describe the defect more
 * precisely, because both are free text authored by the reviewer: a paraphrase
 * between cycles ("CTA overlaps heading at 375px" → "hero button collides with
 * title on mobile") would mint a fresh fingerprint and silently reset the
 * budget. That is an unbounded repair loop wearing a budget's clothes.
 *
 * The cost of this choice is coarseness — two genuinely distinct defects in the
 * same category at the same location share one budget. That is the safe
 * direction to err: the consequence is an early escalation to a Terra
 * specialist, which is a designed path in §7, whereas the consequence of
 * erring the other way is the cost blowout budgets exist to prevent.
 */
export function defectFingerprint(issue: { category: string; location: string }): string {
  const canonical = `${normalise(issue.category)}|${normalise(primaryLocation(issue.location))}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * The one file a location names, whatever else it says.
 *
 * `location` was treated as structured while `reason` was treated as free text,
 * and it is not: a reviewer writes "index.html#hero" one cycle and
 * "index.html#hero, index.html#coverage-contact, contact.html" the next for the
 * same defect. Both hashed differently, so the per-defect budget reset every
 * time and Sol could not see that a defect had recurred at all.
 *
 * Observed on a real delivery: seven blocking issues over four review cycles
 * produced seven distinct fingerprints and no repeats, while the reviewer's own
 * prose said "the previously reported binding defect remains". Nothing bounded
 * the loop except the rejection counter, so the run burned every cycle and
 * blocked with the site undeployed.
 *
 * Reducing to the first file named restores the property the fingerprint was
 * built for: stable identity across paraphrase. It is coarse — every defect of
 * one category on one page shares a budget — but that is the direction the
 * fingerprint was always meant to err, and merged defects are repaired together
 * in a single call anyway.
 */
export function primaryLocation(location: string): string {
  const first = location.split(/[,;]/)[0] ?? location;
  return first.split('#')[0]!.split(' -> ')[0]!.trim() || location.trim();
}

/**
 * Finer-grained identity, including the acceptance test. Used for deduplicating
 * findings *within* a review cycle and for reporting — never as a budget key.
 */
export function defectDetailFingerprint(issue: {
  category: string;
  location: string;
  acceptanceTest: string;
}): string {
  const canonical = `${normalise(issue.category)}|${normalise(issue.location)}|${normalise(issue.acceptanceTest)}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export const IssueCategory = z.enum([
  'responsive',
  'accessibility',
  'content_accuracy',
  'business_accuracy',
  'seo_metadata',
  'design_system',
  'functionality',
  'links',
  'forms',
  'integration',
  'performance',
  'security',
]);
export type IssueCategory = z.infer<typeof IssueCategory>;

export const RecommendedAction = z.enum([
  'targeted_repair',
  'specialist_repair',
  'spec_revision',
  'rebuild',
  'accept_non_blocking',
]);
export type RecommendedAction = z.infer<typeof RecommendedAction>;

/**
 * Proof attached to a finding. §7 requires Sol to reject invalid or duplicate
 * findings before spending a repair cycle — which is impossible to do
 * mechanically if a finding carries nothing checkable.
 */
export const Evidence = z.object({
  kind: z.enum(['screenshot', 'test_output', 'dom_selector', 'http_response', 'log']),
  ref: z.string().min(1),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/** A finding as emitted by the reviewer. Contains no platform-derived fields. */
export const ReviewIssueInput = z.object({
  id: z.string().regex(/^QA-\d{3,}$/, 'expected QA-<number>'),
  category: IssueCategory,
  severity: Severity,
  /** Structural locator, e.g. "homepage.hero". Part of the budget key. */
  location: z.string().min(1),
  reason: z.string().min(1),
  /** The test that proves the repair is complete. */
  acceptanceTest: z.string().min(1),
  recommendedAction: RecommendedAction,
  evidence: z.array(Evidence).default([]),
});
export type ReviewIssueInput = z.infer<typeof ReviewIssueInput>;

/** A finding after the platform has enriched it. */
export const ReviewIssue = ReviewIssueInput.extend({
  /** Budget key. Derived by the platform — never supplied by the model. */
  fingerprint: z.string().min(1),
  detailFingerprint: z.string().min(1),
  /** Set when this repeats a finding already open from an earlier cycle. */
  duplicateOf: z.string().nullable().default(null),
  firstSeenCycle: z.number().int().nonnegative(),
});
export type ReviewIssue = z.infer<typeof ReviewIssue>;

// ---------------------------------------------------------------------------
// Review outcome
// ---------------------------------------------------------------------------

export const ReviewerIdentity = z.object({
  tier: AgentTier,
  /** Concrete model behind the tier, recorded for attribution and replay. */
  model: z.string().min(1),
  /**
   * Version of the skill contract used. Without this a quality regression
   * cannot be attributed to a skill edit, and reviews are not reproducible.
   */
  skillVersion: z.string().min(1),
});
export type ReviewerIdentity = z.infer<typeof ReviewerIdentity>;

const reviewOutcomeShape = {
  decision: z.enum(['accept', 'reject']),
  qualityScore: z.number().int().min(0).max(100),
  blocking: z.boolean(),
  issues: z.array(ReviewIssueInput),
};

/**
 * Consistency rules applied to any review outcome.
 *
 * These are the teeth of §7. `blocking` is derivable from the severities
 * present, so allowing the reviewer to assert it independently would let a
 * P3-only review block a release — precisely the "cosmetic preferences consume
 * the entire approval budget" failure the severity table exists to prevent.
 */
function applyOutcomeRules<T extends z.ZodType<{ decision: 'accept' | 'reject'; blocking: boolean; issues: { severity: Severity }[] }>>(
  schema: T,
) {
  return schema
    .refine((o) => o.decision === 'accept' || o.issues.length > 0, {
      message: 'A rejection must cite at least one issue (§7: no unbounded "not good enough").',
    })
    .refine((o) => o.blocking === o.issues.some((i) => blocksRelease(i.severity)), {
      message: 'blocking must equal whether any issue is P0/P1; it is derived, not asserted.',
    })
    .refine((o) => o.decision === 'reject' || !o.issues.some((i) => blocksRelease(i.severity)), {
      message: 'Cannot accept while a P0/P1 issue is open (§7: must fix, release blocked).',
    });
}

/**
 * Structural half of the reviewer's output contract, without the cross-field
 * rules. JSON Schema cannot express "blocking must equal whether any issue is
 * P0/P1", so this is what gets published to the model, and
 * {@link ReviewOutcomeInput} is what the response is then parsed with. The
 * model is constrained on shape; the platform enforces consistency.
 */
export const ReviewOutcomeInputBase = z.object(reviewOutcomeShape);

/**
 * The model output contract. This is what a reviewer must emit, and what gets
 * enforced at the tool-call layer.
 */
export const ReviewOutcomeInput = applyOutcomeRules(ReviewOutcomeInputBase);
export type ReviewOutcomeInput = z.infer<typeof ReviewOutcomeInput>;

/** The persisted review, enriched with provenance and derived fingerprints. */
export const ReviewOutcomeRecord = applyOutcomeRules(
  z.object({
    ...reviewOutcomeShape,
    issues: z.array(ReviewIssue),
    projectId: ProjectId,
    /** The job whose output was reviewed. */
    subjectJobId: JobId,
    /** Exact artifact versions reviewed, so a verdict is reproducible. */
    subjectArtifacts: z.array(ArtifactRef),
    reviewer: ReviewerIdentity,
    reviewCycle: z.number().int().nonnegative(),
    createdAt: z.date(),
  }),
);
export type ReviewOutcomeRecord = z.infer<typeof ReviewOutcomeRecord>;

// ---------------------------------------------------------------------------
// Release adjudication
// ---------------------------------------------------------------------------

/** Release is permitted only when no blocking criterion is outstanding (§7). */
export function isReleaseBlocked(issues: readonly { severity: Severity }[]): boolean {
  return issues.some((i) => blocksRelease(i.severity));
}

/**
 * Terminal outcomes Sol may legally choose when a budget is exhausted (§7).
 *
 * The document lists these outcomes and, separately, states that P0/P1 must be
 * fixed before release. The intersection is left implicit there but is forced:
 * with a blocking issue open, "accept the documented non-blocking issues" is
 * not available, and the only lawful terminal outcomes are rollback or Blocked.
 * Encoded here rather than left to prompt guidance.
 */
export const TerminalOutcome = z.enum([
  'accept_non_blocking',
  'switch_strategy',
  'controlled_rebuild',
  'reduce_optional_scope',
  'rollback_to_last_accepted',
  'mark_blocked',
  'request_human_review',
]);
export type TerminalOutcome = z.infer<typeof TerminalOutcome>;

export function legalTerminalOutcomes(
  issues: readonly { severity: Severity }[],
  options: { humanReviewPermitted: boolean },
): TerminalOutcome[] {
  const all = TerminalOutcome.options.filter(
    (o) => o !== 'request_human_review' || options.humanReviewPermitted,
  );
  if (!isReleaseBlocked(issues)) return all;
  return all.filter((o) => o === 'rollback_to_last_accepted' || o === 'mark_blocked' || o === 'request_human_review');
}
