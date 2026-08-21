/**
 * Routing policy — which execution strategy the harness will permit.
 *
 * Pure. Given the plan, Sol's decision and any resolved developer override, it
 * returns what may run and why. Two things deliberately stay in the
 * orchestrator: reading `BUILD_STRATEGY`, which is configuration collection
 * rather than evaluation, and executing the strategy, including recovery from a
 * truncation that actually happened.
 */
import type { SolRouteDecision, SitePlan } from '@statxai/contracts';

export type Strategy = 'one_shot' | 'decompose';

/** A developer override, honoured only when it names a real strategy. */
export type StrategyOverride = Strategy | null;

/**
 * How a strategy came to be chosen.
 *
 * `truncation-recovery` is deliberately not a routing decision. It is what the
 * harness does when a one-shot build genuinely exceeds the output ceiling at
 * runtime, and it is recorded as its own artifact version so the trail
 * distinguishes "Sol decided to decompose" from "one-shot was tried and did not
 * fit". Those were the same code path when decomposition was entered by
 * throwing a fabricated truncation error, which made the two indistinguishable
 * after the fact.
 */
export type RouteSource = 'sol' | 'developer-override' | 'fallback' | 'truncation-recovery';

export interface RoutingAuthorization {
  strategy: Strategy;
  /** How this strategy came to be chosen — recorded on the artifact. */
  source: RouteSource;
  /** Present when the harness refused or replaced Sol's choice. */
  refusal: string | null;
}

/**
 * Which strategies the harness will permit for this plan.
 *
 * A single-page site cannot be decomposed: decomposition builds an anchor and
 * then the *remaining* pages, so with one route there is nothing left to build
 * and the second phase would be empty.
 */
export function permittedStrategies(plan: SitePlan): Strategy[] {
  return plan.sitemap.pages.length > 1 ? ['one_shot', 'decompose'] : ['one_shot'];
}

/**
 * Turn a well-formed decision into an authorised strategy.
 *
 * Three ways Sol's choice does not survive:
 *
 * - it names a strategy the harness did not offer;
 * - it decomposes into workstreams naming routes the sitemap does not contain,
 *   which would schedule work for pages that do not exist;
 * - it decomposes but names no route other than the homepage, which the anchor
 *   already builds.
 *
 * None of these fail the run. Routing is a preference between two working
 * paths, so a refusal falls back to `one_shot` — the architecture's documented
 * default — and records why, rather than ending a delivery over a strategy.
 */
export function authorizeRoute(
  decision: SolRouteDecision,
  plan: SitePlan,
  override: StrategyOverride = null,
): RoutingAuthorization {
  if (override) {
    return {
      strategy: override,
      source: 'developer-override',
      refusal:
        override === decision.action
          ? null
          : `BUILD_STRATEGY=${override} overrode Sol's choice of ${decision.action}.`,
    };
  }

  const permitted = permittedStrategies(plan);
  if (!permitted.includes(decision.action)) {
    return {
      strategy: 'one_shot',
      source: 'fallback',
      refusal: `Sol chose ${decision.action}, which is not permitted for a ${plan.sitemap.pages.length}-page plan.`,
    };
  }

  if (decision.action === 'decompose') {
    const routes = new Set(plan.sitemap.pages.map((p) => p.route));
    const named = decision.workstreams ?? [];
    const unknown = named.filter((w) => !routes.has(w.route)).map((w) => w.route);

    if (unknown.length > 0) {
      return {
        strategy: 'one_shot',
        source: 'fallback',
        refusal: `Sol's workstreams name routes absent from the sitemap: ${unknown.join(', ')}.`,
      };
    }
  }

  return { strategy: decision.action, source: 'sol', refusal: null };
}

/** What gets stored as the versioned `route-decision` artifact. */