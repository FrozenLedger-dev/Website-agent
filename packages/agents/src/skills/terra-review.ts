/**
 * Terra — independent review (v1.2 §7).
 *
 * Deliberately given only the specification and the built artifact — never the
 * builder's reasoning or notes. That context independence is the only kind of
 * independence available when reviewer and builder share a model family, and
 * throwing it away for convenience would leave the subjective quality gate
 * checking the builder's own story rather than its output.
 */
import {
  ReviewOutcomeInput,
  VisualQualityAssessment,
  type BrowserViewportName,
  type BusinessProfile,
  type GeneratedFile,
  type ScreenshotCaptureReason,
  type SitePlan,
} from '@statxai/contracts';
import type { ModelCallOptions, ModelRuntime } from '../runtime.js';

const SYSTEM = `You are Terra acting as an independent reviewer. You did not build this site.

Judge the delivered site against the specification and the business profile. Answer the
questions §7 of the architecture asks: does the site accurately reflect the business, is
the value proposition clear quickly, does each page have a purpose and a primary action,
is the design system applied consistently, are all claims supported by the profile rather
than invented, and would this feel credible to the target audience?

HOW TO REPORT

You cannot return an unbounded "not good enough". Every issue must name what failed, where
it is, and the test that will prove the repair worked.

- "location" is a structural locator naming the page you saw the problem on:
  "index.html#hero", "services.html". For something present on every page — the
  header, the navigation, the footer — say "app/layout.tsx" instead, because that
  is the one file a repair has to change.
- "acceptanceTest" must be objectively checkable by re-reading the file after a fix.
- "id" is sequential: QA-001, QA-002, ...

SEVERITY — apply it honestly, because it decides whether the release is blocked:
- P0: security, broken production path, catastrophic functional failure.
- P1: a stated acceptance criterion fails, a core flow is unusable, or the site states
  something about the business that is materially incorrect or unsupported by the profile.
- P2: a real quality problem, but the site remains usable and correct.
- P3: subjective polish or an optimisation idea. Does not block release.

"blocking" must be true if and only if at least one issue is P0 or P1. Do not mark a
review blocking on the strength of P2 and P3 findings — cosmetic preference is not
allowed to consume the project's repair budget.

Set decision to "accept" only when no P0 or P1 issue is present. qualityScore is 0-100.

Report what is actually wrong. Do not invent issues to appear thorough, and do not
withhold a real P1 to seem agreeable.`;

export interface RepairedDefect {
  id: string;
  reason: string;
  acceptanceTest: string;
}

export async function reviewSite(
  runtime: ModelRuntime,
  profile: BusinessProfile,
  plan: SitePlan,
  files: readonly GeneratedFile[],
  reviewCycle: number,
  /**
   * Defects repaired since the last review.
   *
   * §7 requires that affected checks re-run. A fresh review does not satisfy
   * that on its own: in testing, a P1 invented-claim defect was raised in cycle
   * one, partially repaired, and then simply not re-examined in cycle two — so
   * the site released with the claim still live on two pages. Carrying each
   * repaired defect's acceptance test forward makes re-verification explicit
   * rather than dependent on the reviewer's attention landing twice.
   */
  repaired: readonly RepairedDefect[] = [],
) {
  const rendered = files
    .map((f) => `=== FILE: ${f.path} ===\n${f.contents}`)
    .join('\n\n');

  const verification =
    repaired.length === 0
      ? ''
      : `
MUST RE-VERIFY FIRST — these defects were repaired since the last review.
Run each acceptance test against the delivered files before anything else. If a test
still fails anywhere it applies, re-raise it at its original severity. Do not assume a
repair worked because it was attempted.

${repaired
  .map((d) => `${d.id}\n  Original problem: ${d.reason}\n  Acceptance test:  ${d.acceptanceTest}`)
  .join('\n\n')}
`;

  return runtime.invoke({
    skill: 'terra-review',
    tier: 'terra',
    label: 'terra:review',
    system: SYSTEM,
    schema: ReviewOutcomeInput,
    maxTokens: 16_000,
    effort: 'high',
    prompt: `Review cycle ${reviewCycle}. Evaluate the delivered site.
${verification}

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

ACCEPTANCE CRITERIA
${plan.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

SPECIFICATION
${JSON.stringify(plan.sitemap, null, 2)}

DELIVERED SITE
${rendered}`,
  });
}

const VISUAL_SYSTEM = `You are Terra acting as an independent visual reviewer. You did not build this site.

You are shown screenshots of the rendered website — real pixels from a real browser — at
desktop (1440px wide), tablet (768px) and mobile (390px). Judge what a visitor actually
sees. You are not shown source code and must not speculate about it.

Tall pages arrive as frames one screen tall, labelled with their route, viewport, frame
number and vertical position. When a page had more frames than were sent, the frames are
evenly spaced from its top to its bottom: judge the whole composition from them, and do
not treat the first frame as the whole page.

SCORE each dimension 0-100 (100 = work a design-led studio would publish):
- composition: layout structure, asymmetry, variety of section forms, use of space
- typography: type scale contrast, measure, pairing, rhythm of headings and body
- spacingRhythm: deliberate, varied vertical rhythm rather than identical padding everywhere
- hierarchy: what the eye reads first, second, third on each screen
- brandDistinctiveness: does this look like this specific business, not any business
- assetQuality: quality and fitness of imagery, illustration, iconography and graphic devices
- conversionClarity: is the primary action obvious and reachable on every page
- mobileQuality: is mobile designed for a phone, not merely the desktop stacked vertically
overallScore is your holistic judgement, also 0-100.

LOOK SPECIFICALLY FOR template-like patterns, and report each one you see in antiPatterns:
generic centred hero with two buttons (generic_centered_hero), three equal cards
(three_equal_cards), cards everywhere (cards_everywhere), repetitive icon circles
(repetitive_icon_circles), arbitrary gradients (arbitrary_gradients), unnecessary pills or
badges (unnecessary_pills), everything centred (all_centered_composition), identical spacing
everywhere (uniform_spacing), a huge heading with nothing composed around it
(oversized_heading_without_composition), mobile that is the desktop stacked
(mobile_is_stacked_desktop). These are things to judge, not automatic failures.

REPORTING
- Only review routes and viewports you were shown. Never describe a page or viewport you
  did not see; the targets you were not shown are listed so you know they are missing.
- Each issue names its route, the viewports it appears on, one dimension, a severity
  (major, moderate, minor), the problem as seen, and a direction for improving it.
  Directions describe the visual outcome, never files, code or commands.
- issue ids are sequential: VQ-001, VQ-002, ...
- refinementPriorities are at most 10, ranked 1 (most valuable) upward.
- Correctness is judged elsewhere: do not report broken builds, accessibility violations
  or console errors as visual issues unless you can see their effect on the page.
- Be honest in both directions: do not inflate scores, and do not invent problems.`;

/** One image of the rendered site, identified by the target it shows. */
export interface VisualReviewImage {
  readonly route: string;
  readonly viewport: BrowserViewportName;
  readonly index: number;
  readonly count: number;
  readonly offsetY: number;
  readonly sourceHeight: number;
  readonly png: Uint8Array;
}

export interface VisualReviewInput {
  readonly profile: BusinessProfile;
  readonly plan: SitePlan;
  /** Every image the reviewer sees, in a fixed order. */
  readonly frames: readonly VisualReviewImage[];
  /** Targets with no screenshot, and targets with one that was not sent. */
  readonly missing: readonly { route: string; viewport: BrowserViewportName; reason: ScreenshotCaptureReason }[];
  readonly notReviewed: readonly { route: string; viewport: BrowserViewportName }[];
  /** Concise browser findings per target, for context only. */
  readonly browserFindings: readonly string[];
}

/**
 * Terra's multimodal visual quality review: one invocation, the rendered frames
 * as images, a strict assessment back. No tools, no build output, no files.
 */
export async function reviewVisualQuality(runtime: ModelRuntime, input: VisualReviewInput, options: ModelCallOptions = {}) {
  const shown = [...new Set(input.frames.map((f) => `${f.route} @ ${f.viewport}`))];
  return runtime.invoke({
    skill: 'terra-review',
    tier: 'terra',
    label: 'terra:visual-review',
    system: VISUAL_SYSTEM,
    schema: VisualQualityAssessment,
    maxTokens: 16_000,
    effort: 'high',
    prompt: `Review the rendered website shown in the ${input.frames.length} images that follow.

BUSINESS
${JSON.stringify({ businessName: input.profile.businessName, industry: input.profile.industry, location: input.profile.location, audience: input.profile.audience, tone: input.profile.tone }, null, 2)}

BRAND SYSTEM (what the design intended)
${JSON.stringify(input.plan.brandSystem, null, 2)}

PAGES (route, purpose, primary action)
${input.plan.sitemap.pages.map((p) => `  ${p.route}  ${p.title} — goal: ${p.goal}; primary action: ${p.primaryAction}`).join('\n')}

TARGETS SHOWN (${shown.length})
${shown.map((t) => `  ${t}`).join('\n')}

TARGETS NOT SHOWN — do not review these
${[...input.missing.map((m) => `  ${m.route} @ ${m.viewport} (no screenshot: ${m.reason})`), ...input.notReviewed.map((m) => `  ${m.route} @ ${m.viewport} (not sent: review budget)`)].join('\n') || '  (none)'}

BROWSER FINDINGS (context only; correctness is judged elsewhere)
${input.browserFindings.map((f) => `  ${f}`).join('\n') || '  (none)'}`,
    images: input.frames.map((frame, i) => ({
      label: `IMAGE ${i + 1}: ${frame.route} @ ${frame.viewport} — frame ${frame.index} of ${frame.count}, from y=${frame.offsetY}px of a ${frame.sourceHeight}px page`,
      mediaType: 'image/png' as const,
      data: frame.png,
    })),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}
