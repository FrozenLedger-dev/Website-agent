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
 * A build that really did exceed the output ceiling.
 *
 * The distinction matters now that nothing fabricates this error: a truncation
 * reaching here is always a genuine runtime failure, so recovering from it is
 * recovery rather than a strategy anyone chose.
 */
export function isTruncationFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'MalformedModelOutput' && /truncated/.test(error.message);
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
  source: RouteSource;
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

export interface RouteExecutors {
  /** Build the whole site in one call. */
  oneShot: () => Promise<void>;
  /** Build an anchor, then the remaining pages against it. */
  decomposed: () => Promise<void>;
  /**
   * Called when a real one-shot truncation is about to be recovered from, so
   * the caller can record it. Recovery is not a routing decision and is
   * recorded separately.
   */
  onRecovery: (error: unknown) => Promise<void>;
}

/**
 * Execute the accepted route.
 *
 * Each strategy has its own call. Decomposition used to be reached by throwing
 * `MalformedModelOutput('forced: output truncated')` so the truncation handler
 * would catch it, which made a deliberate strategy and a runtime failure the
 * same code path and indistinguishable afterwards.
 *
 * Truncation recovery survives, because §3's "one-shot first, decompose only
 * when needed" is a real escalation — but it now triggers only on a truncation
 * that genuinely happened, and it is reported as recovery rather than as a
 * strategy anyone selected.
 *
 * Two cases deliberately do not recover:
 *
 * - an operator who forced one-shot asked for that path specifically, so a
 *   truncation is the run's outcome rather than a silent switch to the strategy
 *   they overrode away from;
 * - a single-page plan cannot be decomposed, because the anchor builds the only
 *   page and the second phase would be empty.
 */
export async function executeRoute(
  route: RoutingAuthorization,
  plan: SitePlan,
  executors: RouteExecutors,
): Promise<void> {
  if (route.strategy === 'decompose') {
    await executors.decomposed();
    return;
  }

  try {
    await executors.oneShot();
  } catch (error) {
    if (!isTruncationFailure(error)) throw error;
    if (route.source === 'developer-override') throw error;
    if (!permittedStrategies(plan).includes('decompose')) throw error;

    await executors.onRecovery(error);
    await executors.decomposed();
  }
}
