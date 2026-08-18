/**
 * Sol — execution routing (v1.2 §3, "One-Shot First").
 *
 * Whether a site is built in one pass or decomposed into per-page jobs is a
 * judgement about *this* project: how many pages, how much copy each carries,
 * how much of the design has to stay consistent across them. It was an
 * environment variable, read before anything about the project was known, and
 * `decompose` was reached by throwing a fake truncation error so the escalation
 * path would catch it. Nothing recorded why either branch was taken.
 *
 * Sol now decides. The harness still authorises: choosing `decompose` does not
 * make it happen, and a malformed or unauthorised decision falls back to the
 * documented default rather than failing the run.
 */
import { SolRouteDecision, type BusinessProfile, type SitePlan } from '@statxai/contracts';
import type { ModelClient } from '../client.js';

const SYSTEM = `You are Sol, the orchestrator for an autonomous website delivery platform.

You are choosing how the approved specification gets built. You do not write code and
you do not execute the strategy — you choose it, and the harness decides whether that
choice is permitted.

THE TWO STRATEGIES

one_shot   Terra builds the entire site in a single call. Coherent by construction:
           one response writes the layout, the brand tokens and every page, so the
           navigation, spacing and component vocabulary cannot drift between pages.
           The whole site must fit inside one response, including reasoning.

decompose  Terra builds a design anchor first — the shared layout, the brand tokens
           and the homepage — and then every remaining page in parallel against it.
           Each call is small and safe, but later pages are built to match a
           reference rather than written together, so consistency depends on the
           anchor being followed.

HOW TO CHOOSE

Prefer one_shot. It produces the more coherent site and is the architecture's
documented default. Choose decompose when the whole site plausibly will not fit one
response, because a truncated one-shot wastes the entire attempt.

The signal is total output volume, not page count alone. Weigh:
- the number of routes, and the number of sections across all of them
- how much real copy each section needs — service descriptions, FAQs and menus are
  long; a contact page is short
- whether the profile carries many services, each needing its own treatment

As a rough calibration: five ordinary pages of four to six sections fit comfortably.
Eight or more content-heavy pages, or a plan whose sections total far beyond forty,
are the cases where decomposition earns its cost.

WHAT TO RETURN

- action: "one_shot" or "decompose".
- reason: one or two sentences naming the specific thing about THIS plan that
  decided it. "The site is large" is not a reason; "seven routes totalling
  forty-one sections, and the services page alone specifies eight offerings with
  individual descriptions" is.
- confidence: 0 to 1. Be honest — a borderline plan should not report 0.95.
- workstreams: null for one_shot. For decompose, one entry per route that is built
  after the anchor, each with the route and why it is a separate unit. Do not
  include the homepage: it is built with the anchor.`;

export interface RouteContext {
  /** Pages in the plan. */
  pageCount: number;
  /** Sections summed across every page — the better proxy for output volume. */
  sectionCount: number;
  /** Services in the profile, which drive how much copy the site needs. */
  serviceCount: number;
  /**
   * Strategies the harness will actually permit right now.
   *
   * Supplied so Sol is not asked to choose something that cannot happen. A
   * decision naming anything outside this list is refused by the caller.
   */
  permittedStrategies: readonly ('one_shot' | 'decompose')[];
}

export async function routeBuild(
  client: ModelClient,
  profile: BusinessProfile,
  plan: SitePlan,
  context: RouteContext,
) {
  return client.call({
    tier: 'sol',
    label: 'sol:route',
    system: SYSTEM,
    schema: SolRouteDecision,
    maxTokens: 4_000,
    effort: 'medium',
    prompt: `Choose the execution strategy for this approved plan.

PERMITTED STRATEGIES
${context.permittedStrategies.join(', ')}

PROJECT SHAPE
  routes            ${context.pageCount}
  sections in total ${context.sectionCount}
  services          ${context.serviceCount}

ROUTES AND THEIR SECTION COUNTS
${plan.sitemap.pages.map((p) => `  ${p.route.padEnd(18)} ${p.sections.length} sections — ${p.title}`).join('\n')}

BUSINESS PROFILE
${JSON.stringify(profile, null, 2)}

APPROVED PLAN
${JSON.stringify(plan, null, 2)}`,
  });
}
