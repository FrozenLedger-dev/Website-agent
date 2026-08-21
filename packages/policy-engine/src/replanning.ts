/**
 * Replan policy — whether a revision may be activated.
 *
 * Pure. The harness measures what changed between two plans; this decides
 * whether that change was permitted. The split matters because the two are
 * different kinds of statement: `routesAdded: ['/pricing']` is a fact, and
 * "a page-scoped revision may not add routes" is authority.
 */
import type { PlanDelta } from './types.js';

export type ReplanScope = 'page' | 'design' | 'site';

export interface ReplanAuthorization {
  authorized: boolean;
  /** Every objectively detectable overreach, not just the first. */
  violations: string[];
  /** Why it was refused, or null when it stands. */
  reason: string | null;
}

/**
 * Where a revision exceeded the scope that was asked for.
 *
 * Only objectively checkable overreach is reported. Whether a page's *content*
 * changed more than it needed to is a judgement, and a wrong answer would
 * either block a good revision or wave through a bad one, so it is left to
 * later policy work. What is measurable is structural: which routes exist,
 * whether the brand system moved, and whether the site's strategy, value
 * proposition or acceptance criteria were rewritten.
 */
export function scopeViolations(scope: ReplanScope, delta: PlanDelta): string[] {
  if (scope === 'site') return [];

  const violations: string[] = [];

  // Neither `page` nor `design` covers which pages exist.
  if (delta.routesAdded.length > 0 || delta.routesRemoved.length > 0) {
    violations.push(
      `Scope "${scope}" does not cover adding or removing routes, but the revision ` +
        `added [${delta.routesAdded.join(', ') || 'none'}] and removed ` +
        `[${delta.routesRemoved.join(', ') || 'none'}].`,
    );
  }

  // Nor the site's overall positioning.
  if (delta.strategyChanged) {
    violations.push(`Scope "${scope}" does not cover the site strategy, but it changed.`);
  }
  if (delta.valuePropositionChanged) {
    violations.push(`Scope "${scope}" does not cover the value proposition, but it changed.`);
  }

  // `design` exists to revise the brand system; `page` does not.
  if (scope === 'page' && delta.brandChanged) {
    violations.push('Scope "page" does not cover the brand system, but it changed.');
  }

  /**
   * Acceptance criteria are project-level state: every rejection has to cite
   * one, so rewriting them changes what the whole site is measured against. A
   * page-scoped revision moving them would quietly redefine the bar for pages
   * it was never authorised to touch.
   *
   * `design` keeps them for now — a design revision can legitimately restate a
   * criterion about composition — and that stays under review.
   */
  if (scope === 'page' && delta.acceptanceCriteriaChanged) {
    violations.push('Scope "page" does not cover the acceptance criteria, but they changed.');
  }

  return violations;
}

/**
 * True when the revision changed nothing the harness can detect.
 *
 * Sol reporting changes it did not make is not a reason to rebuild: the build
 * would reproduce the site that just failed, spend the cycle, and arrive at the
 * same defects.
 */
export function isEmptyDelta(delta: PlanDelta): boolean {
  return (
    delta.routesAdded.length === 0 &&
    delta.routesRemoved.length === 0 &&
    delta.routesRevised.length === 0 &&
    !delta.brandChanged &&
    !delta.acceptanceCriteriaChanged &&
    !delta.strategyChanged &&
    !delta.valuePropositionChanged
  );
}

/**
 * Whether a measured revision may become the accepted plan.
 *
 * Two objective refusals. A scope violation is not a narrow revision that went
 * slightly wide: it is a different decision from the one adjudication
 * authorised, and executing it would let the requested scope mean nothing. An
 * empty delta means Sol reported changes the plan does not contain.
 *
 * Both refusals still leave the decision worth persisting — that is the
 * caller's business — but neither may be activated.
 */
export function authorizeReplanRevision(input: {
  scope: ReplanScope;
  delta: PlanDelta;
  /** Only used to describe a no-op accurately. */
  reportedChangeCount: number;
}): ReplanAuthorization {
  const violations = scopeViolations(input.scope, input.delta);

  if (violations.length > 0) {
    return {
      authorized: false,
      violations,
      reason: `Revision exceeded the "${input.scope}" scope it was authorised for.`,
    };
  }

  if (isEmptyDelta(input.delta)) {
    return {
      authorized: false,
      violations: [],
      reason:
        `Sol reported ${input.reportedChangeCount} change(s), but the revised plan is ` +
        'identical to the one that failed.',
    };
  }

  return { authorized: true, violations: [], reason: null };
}
