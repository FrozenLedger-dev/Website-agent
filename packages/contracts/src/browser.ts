/**
 * Browser render evidence — what a real browser found when it rendered an exact
 * static export.
 *
 * Harness-owned evidence, not a model contract and not a verdict: it says which
 * build was rendered (the subject), how (runtime and viewports), and what each
 * planned route did at each viewport. Nothing here accepts, promotes or
 * releases anything, and nothing here is a screenshot.
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
