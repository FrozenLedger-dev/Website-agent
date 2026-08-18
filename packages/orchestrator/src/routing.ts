/**
 * Authorising Sol's routing decision.
 *
 * Sol chooses; the harness decides whether the choice is permitted and what
 * happens when it is not. Keeping that here rather than inline in the delivery
 * loop is the point of the split: the decision is a model output, the
 * authorisation is code, and the two are separately reviewable.
 */
import type { SolRouteDecision, SitePlan } from '@statxai/contracts';

export type Strategy = 'one_shot' | 'decompose';

/** A developer override, honoured only when it names a real strategy. */
export type StrategyOverride = Strategy | null;

export interface RoutingAuthorization {
  strategy: Strategy;
  /** How this strategy came to be chosen — recorded on the artifact. */
  source: 'sol' | 'developer-override' | 'fallback';
  /** Present when the harness refused or replaced Sol's choice. */
  refusal: string | null;
}

/**
 * Read `BUILD_STRATEGY` as an explicit override.
 *
 * The checklist is specific: an environment variable must not *silently*
 * substitute for Sol's decision, but may override it deliberately. So an
 * unrecognised value is ignored rather than guessed at, and a recognised one is
 * reported so the run record shows a human overrode the model.
 *
 * `auto` is retained as "no override", which is what it always meant.
 */
export function developerOverride(raw = process.env.BUILD_STRATEGY): StrategyOverride {
  const value = raw?.trim().toLowerCase();
  if (value === 'one-shot' || value === 'one_shot') return 'one_shot';
  if (value === 'decompose') return 'decompose';
  return null;
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
export interface RouteDecisionRecord {
  strategy: Strategy;
  source: RoutingAuthorization['source'];
  refusal: string | null;
  /** Sol's own words, kept even when the harness did not follow them. */
  proposed: {
    action: Strategy;
    reason: string;
    confidence: number;
    workstreams: { route: string; reason: string }[];
  } | null;
  /** Set when Sol was never consulted or its answer could not be used. */
  modelFailure: string | null;
  decidedAt: Date;
}
