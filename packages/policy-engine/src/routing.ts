/**
 * Routing policy — which execution strategy the harness will permit.
 *
 * Pure. Given the plan, Sol's decision and any resolved developer override, it
 * returns what may run and why. Two things deliberately stay in the
 * orchestrator: reading `BUILD_STRATEGY`, which is configuration collection
 * rather than evaluation, and executing the strategy, including recovery from a
 * truncation that actually happened.
 */
import { HOME_ROUTE, type SolRouteDecision, type SitePlan } from '@statxai/contracts';

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
 * Two ways Sol's choice does not survive: it names a strategy the harness did
 * not offer, or it decomposes into a workstream set that does not describe the
 * work decomposition would actually do — see {@link workstreamFaults}.
 *
 * Neither fails the run. Routing is a preference between two working paths, so
 * a refusal falls back to `one_shot` — the architecture's documented default —
 * and records why, rather than ending a delivery over a strategy.
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
    const faults = workstreamFaults(decision.workstreams ?? [], plan);
    if (faults.length > 0) {
      return {
        strategy: 'one_shot',
        source: 'fallback',
        refusal: `Sol's workstreams do not describe the decomposition: ${faults.join(' ')}`,
      };
    }
  }

  return { strategy: decision.action, source: 'sol', refusal: null };
}

/** What gets stored as the versioned `route-decision` artifact. */

/**
 * Whether a decomposition's workstreams describe the work it would actually do.
 *
 * `executeDecomposed` builds the anchor — layout plus the homepage — and then
 * every *remaining* sitemap page. So the workstream set has exactly one correct
 * value: the sitemap routes minus the homepage, each named once.
 *
 * Only unknown routes used to be checked, which let four other shapes through:
 * omitting a route that would be built anyway, including `/` which the anchor
 * already covers, naming the same route twice, and naming one route on a
 * five-page site. None broke a build, because execution reads the sitemap and
 * ignores the workstreams entirely — the cost was that the `route-decision`
 * artifact recorded a plan the delivery did not follow, which is exactly the
 * evidence an audit trail exists to preserve.
 *
 * Returns one sentence per fault, so a refusal says what was wrong rather than
 * that something was.
 */
export function workstreamFaults(
  workstreams: readonly { route: string }[],
  plan: SitePlan,
): string[] {
  const sitemap = new Set(plan.sitemap.pages.map((p) => p.route));
  const expected = [...sitemap].filter((route) => route !== HOME_ROUTE);
  const named = workstreams.map((w) => w.route);

  const faults: string[] = [];

  const unknown = named.filter((route) => !sitemap.has(route));
  if (unknown.length > 0) faults.push(`routes absent from the sitemap: ${unknown.join(', ')}.`);

  if (named.includes(HOME_ROUTE)) {
    faults.push(`the homepage is built by the anchor and must not be a workstream.`);
  }

  // `Set.add` returns the set, not whether it inserted, so this is a `has`
  // check rather than the terser filter it looks like it wants to be.
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const route of named) {
    if (seen.has(route) && !duplicated.includes(route)) duplicated.push(route);
    seen.add(route);
  }
  if (duplicated.length > 0) faults.push(`routes named more than once: ${duplicated.join(', ')}.`);

  const missing = expected.filter((route) => !named.includes(route));
  if (missing.length > 0) {
    faults.push(`routes the decomposition would build but did not name: ${missing.join(', ')}.`);
  }

  return faults;
}
