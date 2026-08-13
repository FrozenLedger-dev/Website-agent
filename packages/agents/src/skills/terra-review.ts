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
  type BusinessProfile,
  type GeneratedFile,
  type SitePlan,
} from '@statxai/contracts';
import type { ModelClient } from '../client.js';

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
  client: ModelClient,
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

  return client.call({
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
