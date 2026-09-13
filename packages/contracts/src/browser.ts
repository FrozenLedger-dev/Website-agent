/**
 * Browser render evidence — what a real browser found when it rendered an exact
 * static export.
 *
 * Harness-owned evidence, not a model contract and not a verdict: it says which
 * build was rendered (the subject), how (runtime and viewports), what each
 * planned route did at each viewport, and — as a screenshot set — which exact
 * images were captured of it under which policy. Nothing here accepts, promotes
 * or releases anything.
 */
import * as z from 'zod/v4';
import { ArtifactRef } from './primitives.js';

export const BrowserViewportName = z.enum(['desktop', 'tablet', 'mobile']);
export type BrowserViewportName = z.infer<typeof BrowserViewportName>;

export const BrowserViewport = z.strictObject({
  name: BrowserViewportName,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
  isMobile: z.boolean(),
  hasTouch: z.boolean(),
});
export type BrowserViewport = z.infer<typeof BrowserViewport>;

/**
 * Whose build was rendered, exactly — never "the latest".
 *
 * `exportDigest` identifies the bytes rendered; `sourceCommit` the canonical
 * revision they were built from; `authority` what made that revision canonical.
 * A legacy direct run has no build binding, and says so rather than inventing one.
 */
export const BrowserRenderAuthority = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('legacy_direct') }),
  z.strictObject({
    mode: z.literal('job_lifecycle'),
    buildBindingId: z.string().min(1),
    promotionId: z.string().min(1).nullable(),
    promotionCommitSha: z.string().min(1).nullable(),
  }),
]);
export type BrowserRenderAuthority = z.infer<typeof BrowserRenderAuthority>;

export const BrowserRenderSubject = z.strictObject({
  projectId: z.string().min(1),
  sitePlan: ArtifactRef,
  sourceCommit: z.string().min(1).nullable(),
  /** sha256 over every exported file's path and content, in path order. */
  exportDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authority: BrowserRenderAuthority,
});
export type BrowserRenderSubject = z.infer<typeof BrowserRenderSubject>;

export const BrowserFindingCategory = z.enum([
  'navigation_failed',
  'http_error',
  'runtime_exception',
  'console_error',
  'local_resource_failed',
  'external_request_blocked',
  'unexpected_navigation',
  'readiness_timeout',
]);
export type BrowserFindingCategory = z.infer<typeof BrowserFindingCategory>;

/** Categories that mean the page did not render cleanly. The rest are recorded, not blocking. */
export const BLOCKING_BROWSER_FINDINGS: readonly BrowserFindingCategory[] = [
  'navigation_failed',
  'http_error',
  'runtime_exception',
  'local_resource_failed',
  'unexpected_navigation',
  'readiness_timeout',
];

export const BrowserFinding = z.strictObject({
  category: BrowserFindingCategory,
  route: z.string(),
  viewport: BrowserViewportName,
  detail: z.string(),
});
export type BrowserFinding = z.infer<typeof BrowserFinding>;

export const BrowserRouteRender = z.strictObject({
  route: z.string(),
  viewport: BrowserViewportName,
  status: z.enum(['rendered', 'failed', 'timed_out', 'not_run']),
  httpStatus: z.number().int().nullable(),
  navigationMs: z.number().nonnegative().nullable(),
  readyMs: z.number().nonnegative().nullable(),
  findings: z.array(BrowserFinding),
});
export type BrowserRouteRender = z.infer<typeof BrowserRouteRender>;

export const BrowserRenderReport = z.strictObject({
  subject: BrowserRenderSubject,
  runtime: z.strictObject({ playwright: z.string(), image: z.string() }),
  viewports: z.array(BrowserViewport),
  /** `completed`: every target ran. `timed_out`/`unavailable`: the run itself did not finish or start. */
  status: z.enum(['completed', 'timed_out', 'unavailable']),
  renders: z.array(BrowserRouteRender),
  /** Planned routes beyond the render bound, in plan order — never silently dropped. */
  omittedRoutes: z.array(z.string()),
  /** Every target rendered, and no blocking finding. */
  passed: z.boolean(),
  /** Findings or text were dropped to fit the report bounds. */
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  reason: z.string().nullable(),
});
export type BrowserRenderReport = z.infer<typeof BrowserRenderReport>;

// ---------------------------------------------------------------------------
// Screenshot evidence
// ---------------------------------------------------------------------------

/**
 * The one capture policy every screenshot names. A new policy is a new version:
 * a reviewer comparing two images must know they were made the same way.
 */
export const SCREENSHOT_POLICY_VERSION = 'statxai-screenshot@1';

export const ScreenshotPolicy = z.strictObject({
  version: z.literal(SCREENSHOT_POLICY_VERSION),
  format: z.literal('png'),
  viewports: z.array(BrowserViewport),
  /** The whole page from the top, cropped to the viewport width and to at most `maxCaptureHeight` CSS pixels. */
  fullPage: z.literal(true),
  maxCaptureHeight: z.number().int().positive(),
  maxCaptureBytes: z.number().int().positive(),
  maxSetBytes: z.number().int().positive(),
  reducedMotion: z.literal('reduce'),
  animations: z.literal('disabled'),
  caret: z.literal('hide'),
  scale: z.literal('css'),
});
export type ScreenshotPolicy = z.infer<typeof ScreenshotPolicy>;

/** A durable image: content-addressed bytes, described by exactly what was stored. */
export const ScreenshotImage = z.strictObject({
  blob: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  contentType: z.literal('image/png'),
});
export type ScreenshotImage = z.infer<typeof ScreenshotImage>;

/**
 * Why a target has, or lacks, an image. One rule decides: a target is captured
 * only once its page answered and became ready — so a page that loaded and threw
 * is captured as evidence of what it showed, and one that never loaded is not.
 */
export const ScreenshotCaptureReason = z.enum([
  'captured',
  /** The page never answered successfully or never became ready: there is nothing honest to capture. */
  'render_not_ready',
  /** Rendering was fine; producing the image failed. */
  'capture_failed',
  'capture_too_large',
  'set_limit_reached',
  /** Bytes arrived but were not a valid PNG of the claimed size. */
  'invalid_image',
  /** A valid image could not be written to durable storage. */
  'storage_failed',
  /** The render run ended before this target. */
  'not_run',
]);
export type ScreenshotCaptureReason = z.infer<typeof ScreenshotCaptureReason>;

export const ScreenshotCapture = z.strictObject({
  route: z.string(),
  viewport: BrowserViewport,
  reason: ScreenshotCaptureReason,
  renderStatus: BrowserRouteRender.shape.status,
  /** Finding categories this render produced — the full findings stay in the browser report. */
  findingCategories: z.array(BrowserFindingCategory),
  /** The page's own size in CSS pixels, when it was measured. */
  page: z.strictObject({ width: z.number().int().nonnegative(), height: z.number().int().nonnegative() }).nullable(),
  /** The page is taller than the policy allows; the image is its top `maxCaptureHeight` pixels. */
  truncated: z.boolean(),
  image: ScreenshotImage.nullable(),
  detail: z.string().nullable(),
});
export type ScreenshotCapture = z.infer<typeof ScreenshotCapture>;

/** Every capture one evaluation made of one exact build, with an honest account of what is missing. */
export const ScreenshotSet = z.strictObject({
  subject: BrowserRenderSubject,
  policy: ScreenshotPolicy,
  browser: z.strictObject({
    status: BrowserRenderReport.shape.status,
    passed: z.boolean(),
    runtime: BrowserRenderReport.shape.runtime,
    reason: z.string().nullable(),
  }),
  expectedCaptures: z.number().int().nonnegative(),
  capturedCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  /** Every expected target has a durable image. */
  complete: z.boolean(),
  totalBytes: z.number().int().nonnegative(),
  omittedRoutes: z.array(z.string()),
  captures: z.array(ScreenshotCapture),
});
export type ScreenshotSet = z.infer<typeof ScreenshotSet>;
