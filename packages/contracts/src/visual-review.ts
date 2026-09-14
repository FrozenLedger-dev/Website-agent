/**
 * Multimodal visual quality review — what Terra judged looking at the rendered
 * pixels of one exact screenshot set.
 *
 * Distinct from the historical `visual-review` artifact, which is Terra's
 * textual review of source and exported HTML (P0–P3 defects that can block a
 * release). That artifact keeps its name, meaning and shape. This one is new:
 * `visual-quality-review`, versioned, bound to the exact `screenshot-set` it
 * looked at, and advisory — it scores quality and names priorities for a later
 * refinement; it blocks nothing and changes nothing.
 */
import * as z from 'zod/v4';
import { ArtifactRef } from './primitives.js';
import { BrowserRenderSubject, BrowserViewportName, ScreenshotCaptureReason } from './browser.js';

export const VISUAL_REVIEW_SCHEMA_VERSION = 'statxai-visual-review@1';

/** How review images are derived from durable screenshots. A new rule is a new version. */
export const VISUAL_REVIEW_FRAME_POLICY_VERSION = 'statxai-visual-review-frames@1';

export const VisualQualityDimension = z.enum([
  'composition',
  'typography',
  'spacingRhythm',
  'hierarchy',
  'brandDistinctiveness',
  'assetQuality',
  'conversionClarity',
  'mobileQuality',
]);
export type VisualQualityDimension = z.infer<typeof VisualQualityDimension>;

const Score = z.number().int().min(0).max(100);

export const VisualQualityScores = z.strictObject({
  composition: Score,
  typography: Score,
  spacingRhythm: Score,
  hierarchy: Score,
  brandDistinctiveness: Score,
  assetQuality: Score,
  conversionClarity: Score,
  mobileQuality: Score,
});
export type VisualQualityScores = z.infer<typeof VisualQualityScores>;

/** Template-like patterns the reviewer is asked to look for. Review criteria, not rejection rules. */
export const VisualAntiPattern = z.enum([
  'generic_centered_hero',
  'three_equal_cards',
  'cards_everywhere',
  'repetitive_icon_circles',
  'arbitrary_gradients',
  'unnecessary_pills',
  'all_centered_composition',
  'uniform_spacing',
  'oversized_heading_without_composition',
  'mobile_is_stacked_desktop',
]);
export type VisualAntiPattern = z.infer<typeof VisualAntiPattern>;

/**
 * What the model returns — one strict object, nothing executable. Issues name a
 * route and viewports, a dimension, a severity, the problem and a direction; they
 * never name files, commands or code.
 */
export const VisualQualityAssessment = z.strictObject({
  overallScore: Score,
  scores: VisualQualityScores,
  summary: z.string().min(1).max(1_200),
  routeReviews: z
    .array(
      z.strictObject({
        route: z.string().min(1),
        viewports: z.array(BrowserViewportName).min(1),
        score: Score,
        summary: z.string().min(1).max(800),
      }),
    )
    .max(40),
  strengths: z.array(z.string().min(1).max(300)).max(12),
  issues: z
    .array(
      z.strictObject({
        id: z.string().regex(/^VQ-\d{3}$/),
        route: z.string().min(1),
        viewports: z.array(BrowserViewportName).min(1),
        dimension: VisualQualityDimension,
        severity: z.enum(['major', 'moderate', 'minor']),
        problem: z.string().min(1).max(500),
        direction: z.string().min(1).max(500),
      }),
    )
    .max(40),
  antiPatterns: z
    .array(
      z.strictObject({
        pattern: VisualAntiPattern,
        route: z.string().min(1),
        viewports: z.array(BrowserViewportName).min(1),
      }),
    )
    .max(30),
  refinementPriorities: z
    .array(
      z.strictObject({
        rank: z.number().int().min(1).max(10),
        dimension: VisualQualityDimension,
        /** Absent for a site-wide priority. (The strict provider dialect sends absence as null; it is stripped before parsing.) */
        route: z.string().min(1).optional(),
        direction: z.string().min(1).max(500),
      }),
    )
    .max(10),
});
export type VisualQualityAssessment = z.infer<typeof VisualQualityAssessment>;

/** One review image: a frame of one durable screenshot, identified all the way back to its bytes. */
export const VisualReviewFrame = z.strictObject({
  route: z.string(),
  viewport: BrowserViewportName,
  /** 1-based position among this capture's frames sent, and how many were sent. */
  index: z.number().int().positive(),
  count: z.number().int().positive(),
  offsetY: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** The durable screenshot the frame was cut from. */
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHeight: z.number().int().positive(),
});
export type VisualReviewFrame = z.infer<typeof VisualReviewFrame>;

export const VisualReviewStatus = z.enum([
  /** Terra reviewed the frames below. */
  'reviewed',
  /** The screenshot set had no captured image: nothing was sent, nothing judged. */
  'no_evidence',
  /** A screenshot blob was missing, did not match its hash, or could not be decoded: nothing was sent. */
  'evidence_invalid',
  'refused',
  'provider_failed',
  /** The model answered outside its contract, or about a target it was not shown. */
  'malformed_output',
]);
export type VisualReviewStatus = z.infer<typeof VisualReviewStatus>;

export const VisualQualityReview = z.strictObject({
  schemaVersion: z.literal(VISUAL_REVIEW_SCHEMA_VERSION),
  framePolicyVersion: z.literal(VISUAL_REVIEW_FRAME_POLICY_VERSION),
  /** The exact screenshot set reviewed — never "the latest". */
  screenshotSet: ArtifactRef,
  screenshotPolicyVersion: z.string().min(1),
  subject: BrowserRenderSubject,
  status: VisualReviewStatus,
  coverage: z.strictObject({
    expectedTargets: z.number().int().nonnegative(),
    reviewedTargets: z.number().int().nonnegative(),
    /** Targets with no durable screenshot, and why. Never reviewed. */
    missing: z.array(z.strictObject({ route: z.string(), viewport: BrowserViewportName, reason: ScreenshotCaptureReason })),
    /** Targets with a screenshot that did not fit the review budget. Never reviewed. */
    notReviewed: z.array(z.strictObject({ route: z.string(), viewport: BrowserViewportName })),
    /** Every expected target was captured and reviewed. */
    complete: z.boolean(),
  }),
  frames: z.array(VisualReviewFrame),
  assessment: VisualQualityAssessment.nullable(),
  failure: z.strictObject({ kind: VisualReviewStatus, detail: z.string().max(500) }).nullable(),
  reviewer: z
    .strictObject({
      skill: z.literal('terra-review'),
      tier: z.literal('terra'),
      model: z.string(),
      invocationId: z.string(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type VisualQualityReview = z.infer<typeof VisualQualityReview>;
