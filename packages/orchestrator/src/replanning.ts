/**
 * Authorising and recording a specification revision.
 *
 * Sol supplies the reasoning for how a failed plan should change. The harness
 * decides whether the revision is usable, records what actually changed, and
 * persists the history — so a reader can reconstruct why version two of a plan
 * differs from version one without taking the model's word for it.
 */
import type { ReplanChange, SitePlan } from '@statxai/contracts';

export type ReplanScope = 'page' | 'design' | 'site';

/**
 * What actually changed between two plans, computed rather than reported.
 *
 * Sol says what it changed; this says what it changed. They should agree, and
 * when they do not the artifact carries both so the discrepancy is visible.
 */
export interface PlanDelta {
  routesAdded: string[];
  routesRemoved: string[];
  routesRevised: string[];
  brandChanged: boolean;
  acceptanceCriteriaChanged: boolean;
  strategyChanged: boolean;
  valuePropositionChanged: boolean;
}

const canonical = (value: unknown): string => JSON.stringify(value ?? null);

export function planDelta(previous: SitePlan, revised: SitePlan): PlanDelta {
  const before = new Map(previous.sitemap.pages.map((p) => [p.route, p]));
  const after = new Map(revised.sitemap.pages.map((p) => [p.route, p]));

  const routesAdded = [...after.keys()].filter((r) => !before.has(r)).sort();
  const routesRemoved = [...before.keys()].filter((r) => !after.has(r)).sort();
  const routesRevised = [...after.keys()]
    .filter((r) => before.has(r) && canonical(before.get(r)) !== canonical(after.get(r)))
    .sort();

  return {
    routesAdded,
    routesRemoved,
    routesRevised,
    brandChanged: canonical(previous.brandSystem) !== canonical(revised.brandSystem),
    acceptanceCriteriaChanged:
      canonical(previous.acceptanceCriteria) !== canonical(revised.acceptanceCriteria),
    strategyChanged: previous.strategy !== revised.strategy,
    valuePropositionChanged: previous.valueProposition !== revised.valueProposition,
  };
}

/**
 * True when the revision changed nothing the harness can detect.
 *
 * Sol reporting changes it did not make is not a reason to rebuild: the build
 * would reproduce the site that just failed, spend the cycle, and arrive at the
 * same defects. The discrepancy between the reported changes and the measured
 * delta is recorded, because a model claiming work it did not do is worth
 * seeing.
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
 * Where a revision exceeded the scope that was asked for.
 *
 * Only objectively checkable overreach is reported. Whether a page's *content*
 * changed more than it needed to is a judgement, and a wrong answer would
 * either block a good revision or wave through a bad one, so it is left to
 * later policy work. What is measurable is structural: which routes exist,
 * whether the brand system moved, and whether the site's strategy or value
 * proposition was rewritten.
 *
 * These are enforced. A `page` scope that quietly rewrites the site's strategy
 * is not a narrower revision that went slightly wide — it is a different
 * decision from the one adjudication authorised, and executing it would let the
 * scope mean nothing.
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

/** What gets stored as the versioned `replan-decision` artifact. */
export interface ReplanRecord {
  reviewCycle: number;
  /** The plan this revised, by artifact version. */
  previousPlanVersion: number | null;
  /** The adjudication that asked for it, by artifact version. */
  adjudicationVersion: number | null;
  adjudicationReason: string;
  scope: ReplanScope;
  failureDiagnosis: string | null;
  changes: ReplanChange[];
  preservedAreas: string[];
  /** Computed by the harness, not reported by Sol. */
  delta: PlanDelta | null;
  scopeViolations: string[];
  /** Set when the harness refused the revision, with the reason. */
  rejected: string | null;
  model: string | null;
  modelFailure: string | null;
  decidedAt: Date;
}
