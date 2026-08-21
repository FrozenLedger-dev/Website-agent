/**
 * Collecting the routing override, and executing the authorised strategy.
 *
 * The decision is `@statxai/policy-engine`'s. What remains here is what a pure
 * decision layer must not do: read the environment, and run a build.
 */
import type { SitePlan } from '@statxai/contracts';
import {
  permittedStrategies,
  type RouteSource,
  type RoutingAuthorization,
  type Strategy,
} from '@statxai/policy-engine';

/** A developer override, honoured only when it names a real strategy. */
export type StrategyOverride = Strategy | null;

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
