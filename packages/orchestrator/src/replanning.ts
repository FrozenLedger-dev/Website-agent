/**
 * Measuring what a revision changed, and recording the decision about it.
 *
 * The measurement is here because it reads two plans and produces facts; the
 * authority over those facts is `@statxai/policy-engine`'s. Sol says what it
 * changed, this says what it changed, and the artifact carries both so a
 * discrepancy is visible rather than trusted away.
 */
import type { ReplanChange, SitePlan } from '@statxai/contracts';
import type { PlanDelta, ReplanScope } from '@statxai/policy-engine';

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
