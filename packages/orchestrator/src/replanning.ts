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
  };
}

/**
 * Where a revision exceeded the scope that was asked for.
 *
 * Only objectively checkable overreach is reported: whether routes appeared or
 * disappeared, and whether the brand system moved. Whether a page's *content*
 * changed more than it needed to is a judgement, and a wrong answer would
 * either block a good revision or wave through a bad one, so it is left to
 * later policy work.
 *
 * These are recorded, not enforced. A revision that overreaches is still a
 * revision produced from the evidence, and discarding it would send an
 * otherwise-usable plan to `block` on a heuristic — a worse outcome than
 * shipping the delta into the audit trail where it can be read.
 */
export function scopeViolations(scope: ReplanScope, delta: PlanDelta): string[] {
  const violations: string[] = [];
  const structural = delta.routesAdded.length > 0 || delta.routesRemoved.length > 0;

  if (scope === 'page' || scope === 'design') {
    if (structural) {
      violations.push(
        `Scope "${scope}" does not cover adding or removing routes, but the revision ` +
          `added [${delta.routesAdded.join(', ') || 'none'}] and removed ` +
          `[${delta.routesRemoved.join(', ') || 'none'}].`,
      );
    }
  }

  if (scope === 'page' && delta.brandChanged) {
    violations.push('Scope "page" does not cover the brand system, but it changed.');
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
  model: string | null;
  modelFailure: string | null;
  decidedAt: Date;
}
