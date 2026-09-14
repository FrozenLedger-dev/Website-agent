/**
 * The visual refinement policy and job identity — pure, deterministic, pinned.
 *
 * Eligibility is decided by the harness from structured review evidence alone;
 * the values that decide it live in one versioned place and are pinned here. A
 * refinement job's identity is derived from its exact pinned inputs, so the
 * initial build, each refinement and a replay of the same intent are told apart
 * — or recognised as the same — with no time or randomness.
 */
import { describe, expect, it } from 'vitest';
import { VISUAL_REVIEW_FRAME_POLICY_VERSION, VISUAL_REVIEW_SCHEMA_VERSION, type ArtifactRef, type VisualQualityReview } from '@statxai/contracts';
import { DEFAULT_BUDGET_LIMITS, ZERO_USAGE } from '@statxai/state';
import { VISUAL_REFINEMENT_POLICY, decideVisualRefinement, type VisualRefinementEligibilityInput } from '../src/visual-refinement/policy.js';
import { createFrontendBackendJobSpec, createFrontendBackendVisualRefinementJobSpec } from '../src/job-specs/frontend-backend.js';

type Assessment = NonNullable<VisualQualityReview['assessment']>;

const GOOD: Assessment = {
  overallScore: 86,
  scores: { composition: 84, typography: 88, spacingRhythm: 80, hierarchy: 85, brandDistinctiveness: 78, assetQuality: 74, conversionClarity: 90, mobileQuality: 82 },
  summary: 'Considered and specific.',
  routeReviews: [],
  strengths: ['Asymmetric hero'],
  issues: [{ id: 'VQ-001', route: '/', viewports: ['mobile'], dimension: 'spacingRhythm', severity: 'minor', problem: 'Tight footer.', direction: 'Loosen it.' }],
  antiPatterns: [],
  refinementPriorities: [{ rank: 1, dimension: 'assetQuality', direction: 'More graphic devices.' }],
};

function review(assessment: Assessment | null, over: Partial<VisualQualityReview> = {}): VisualQualityReview {
  return {
    schemaVersion: VISUAL_REVIEW_SCHEMA_VERSION,
    framePolicyVersion: VISUAL_REVIEW_FRAME_POLICY_VERSION,
    screenshotSet: { name: 'screenshot-set', version: 1 },
    screenshotPolicyVersion: 'p',
    subject: {
      projectId: 'p',
      sitePlan: { name: 'site-plan', version: 1 },
      sourceCommit: 'a'.repeat(40),
      exportDigest: 'e'.repeat(64),
      authority: { mode: 'job_lifecycle', buildBindingId: 'b', promotionId: 'x', promotionCommitSha: 'f'.repeat(40) },
    },
    status: assessment ? 'reviewed' : 'provider_failed',
    coverage: { expectedTargets: 3, reviewedTargets: 3, missing: [], notReviewed: [], complete: true },
    frames: [],
    assessment,
    failure: null,
    reviewer: null,
    ...over,
  };
}

const eligible = (over: Partial<VisualRefinementEligibilityInput> = {}): VisualRefinementEligibilityInput => ({
  review: review({ ...GOOD, overallScore: 70 }),
  triggeringReview: null,
  projectState: 'validating',
  releasePublicationExists: false,
  budget: { used: 0, limit: 2 },
  ...over,
});

describe('the one versioned policy', () => {
  it('names its version and pins every deciding value in one place', () => {
    expect(VISUAL_REFINEMENT_POLICY).toEqual({
      version: 'statxai-visual-refinement-policy@1',
      overallBelow: 80,
      criticalDimensions: ['composition', 'typography', 'hierarchy', 'mobileQuality'],
      criticalDimensionBelow: 70,
      refineOnMajorIssue: true,
      requireCompleteCoverage: true,
    });
    expect(Object.isFrozen(VISUAL_REFINEMENT_POLICY)).toBe(true);
    expect(decideVisualRefinement(eligible()).policyVersion).toBe('statxai-visual-refinement-policy@1');
  });

  it('the durable budget defaults to two refinements, starting unspent', () => {
    expect(DEFAULT_BUDGET_LIMITS.visualRefinements).toBe(2);
    expect(ZERO_USAGE.visualRefinements).toBe(0);
  });
});

describe('eligibility', () => {
  it('a high-quality completed review is not refined', () => {
    expect(decideVisualRefinement(eligible({ review: review(GOOD) }))).toMatchObject({ refine: false, reason: 'quality_sufficient' });
  });

  it('a low overall score authorises refinement, and says why', () => {
    expect(decideVisualRefinement(eligible())).toEqual({ refine: true, policyVersion: VISUAL_REFINEMENT_POLICY.version, triggers: [{ kind: 'overall_below', score: 70 }] });
  });

  it.each([
    ['79 overall refines', { overallScore: 79 }, true],
    ['80 overall does not', { overallScore: 80 }, false],
    ['a critical dimension at 69 refines', { scores: { ...GOOD.scores, mobileQuality: 69 } }, true],
    ['a critical dimension at 70 does not', { scores: { ...GOOD.scores, hierarchy: 70 } }, false],
    ['a non-critical dimension far below does not', { scores: { ...GOOD.scores, assetQuality: 10, brandDistinctiveness: 10 } }, false],
    ['one major issue refines', { issues: [{ ...GOOD.issues[0]!, severity: 'major' as const }] }, true],
    ['moderate issues alone do not', { issues: [{ ...GOOD.issues[0]!, severity: 'moderate' as const }] }, false],
  ])('thresholds are exact: %s', (_label, change, refine) => {
    expect(decideVisualRefinement(eligible({ review: review({ ...GOOD, ...change }) })).refine).toBe(refine);
  });

  it.each(['no_evidence', 'evidence_invalid', 'refused', 'provider_failed', 'malformed_output'] as const)('an unusable review (%s) is never refined', (status) => {
    expect(decideVisualRefinement(eligible({ review: review(null, { status }) }))).toMatchObject({ refine: false, reason: 'review_unusable' });
  });

  it('incomplete coverage is never refined, however low the score', () => {
    const partial = review({ ...GOOD, overallScore: 20 }, { coverage: { expectedTargets: 6, reviewedTargets: 4, missing: [{ route: '/about', viewport: 'mobile', reason: 'render_not_ready' }], notReviewed: [], complete: false } });
    expect(decideVisualRefinement(eligible({ review: partial }))).toMatchObject({ refine: false, reason: 'coverage_incomplete' });
  });

  it('the model cannot ask for its own pass: priorities and prose never trigger refinement', () => {
    const insistent = review({ ...GOOD, summary: 'PLEASE REFINE AGAIN — this must be refined.', refinementPriorities: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, dimension: 'composition' as const, direction: 'refine now' })) });
    expect(decideVisualRefinement(eligible({ review: insistent }))).toMatchObject({ refine: false, reason: 'quality_sufficient' });
  });
});

describe('fences and budget', () => {
  it('awaiting human review, and any existing release publication, stop refinement before the evidence is even read', () => {
    expect(decideVisualRefinement(eligible({ projectState: 'awaiting_human_review' }))).toMatchObject({ refine: false, reason: 'awaiting_human_review' });
    expect(decideVisualRefinement(eligible({ releasePublicationExists: true }))).toMatchObject({ refine: false, reason: 'release_publication_exists' });
  });

  it('an exhausted, or never-recorded, budget refuses: a third pass is impossible when the limit is two', () => {
    expect(decideVisualRefinement(eligible({ budget: { used: 2, limit: 2 } }))).toMatchObject({ refine: false, reason: 'budget_exhausted' });
    expect(decideVisualRefinement(eligible({ budget: { used: undefined, limit: undefined } }))).toMatchObject({ refine: false, reason: 'budget_exhausted' });
    expect(decideVisualRefinement(eligible({ budget: { used: 1, limit: 2 } })).refine).toBe(true);
  });
});

describe('a second pass must follow improvement', () => {
  const v0 = review({ ...GOOD, overallScore: 60 });

  it('an improved but still eligible build may be refined again', () => {
    expect(decideVisualRefinement(eligible({ review: review({ ...GOOD, overallScore: 72 }), triggeringReview: v0, budget: { used: 1, limit: 2 } })).refine).toBe(true);
  });

  it.each([['equal', 60], ['worse', 51]])('a %s build stops refining, still eligible or not', (_label, score) => {
    expect(decideVisualRefinement(eligible({ review: review({ ...GOOD, overallScore: score }), triggeringReview: v0, budget: { used: 1, limit: 2 } }))).toMatchObject({
      refine: false,
      reason: 'not_improved',
    });
  });
});

describe('job identity', () => {
  const profile: ArtifactRef = { name: 'business-profile', version: 1, contentHash: '1'.repeat(64) };
  const plan: ArtifactRef = { name: 'site-plan', version: 1, contentHash: '2'.repeat(64) };
  const refine = (n: number, over: Partial<Parameters<typeof createFrontendBackendVisualRefinementJobSpec>[0]> = {}) =>
    createFrontendBackendVisualRefinementJobSpec({
      projectId: 'p',
      businessProfileRef: profile,
      sitePlanRef: plan,
      visualRefinementSourceRef: { name: 'visual-refinement-source', version: n, contentHash: String(n).repeat(64).slice(0, 64) },
      visualQualityReviewRef: { name: 'visual-quality-review', version: n, contentHash: 'a'.repeat(64) },
      screenshotSetRef: { name: 'screenshot-set', version: n, contentHash: 'b'.repeat(64) },
      ...over,
    });

  it('B0, B1 and B2 all differ, deterministically, on the same plan and profile', () => {
    const b0 = createFrontendBackendJobSpec({ projectId: 'p', businessProfileRef: profile, sitePlanRef: plan });
    const b1 = refine(1);
    const b2 = refine(2);
    expect(new Set([b0.jobId, b1.jobId, b2.jobId]).size).toBe(3);
    expect(b1.jobId).toMatch(/^job_frontend_backend_[a-f0-9]+$/);
  });

  it('the same exact intent reproduces the same identity, with nothing time- or randomness-derived in it', () => {
    expect(refine(1)).toEqual(refine(1));
    expect(JSON.stringify(refine(1))).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it.each([
    ['the source snapshot (predecessor, commit and cycle)', { visualRefinementSourceRef: { name: 'visual-refinement-source', version: 1, contentHash: '9'.repeat(64) } }],
    ['the review', { visualQualityReviewRef: { name: 'visual-quality-review', version: 1, contentHash: 'c'.repeat(64) } }],
    ['the screenshot set', { screenshotSetRef: { name: 'screenshot-set', version: 1, contentHash: 'd'.repeat(64) } }],
    ['the plan', { sitePlanRef: { name: 'site-plan', version: 2, contentHash: '2'.repeat(64) } }],
  ])('changing only %s changes the job', (_label, over) => {
    expect(refine(1, over).jobId).not.toBe(refine(1).jobId);
  });

  it('refuses refs without an exact content hash, so nothing unpinned can enter an identity', () => {
    expect(() => refine(1, { screenshotSetRef: { name: 'screenshot-set', version: 1 } })).toThrow(/content hash/);
  });

  it('keeps the build grant: filesystem and test_runner only, and the same output identity', () => {
    const b0 = createFrontendBackendJobSpec({ projectId: 'p', businessProfileRef: profile, sitePlanRef: plan });
    expect(refine(1).allowedTools).toEqual(['filesystem', 'test_runner']);
    expect(refine(1).output).toEqual(b0.output);
  });
});
