/**
 * Producing the specification, and revising one that failed.
 *
 * Both write through {@link persistPlan}, so a revision appends a version
 * rather than overwriting: the plan that failed stays readable next to the one
 * that replaced it, which is what makes the trail — plan v1 → evidence →
 * adjudication → replan decision → plan v2 — reconstructable afterwards.
 */
import { HOME_ROUTE, type ArtifactRef, type SitePlan } from '@statxai/contracts';
import { planSite, replanSite } from '@statxai/agents';
import { authorizeReplanRevision, type ReplanScope } from '@statxai/policy-engine';
import { planDelta, type ReplanRecord } from '../replanning.js';
import type { Defect } from '../defects.js';
import type { FixedContext, RunContext } from '../run-context.js';

/** The parsed plan, and the exact ref it was just persisted under — see {@link persistPlan}. */
export interface ProducedPlan {
  readonly plan: SitePlan;
  readonly sitePlanRef: ArtifactRef;
}

export async function producePlan(ctx: FixedContext, attempt: number): Promise<ProducedPlan> {
  const { deps, facts } = ctx;
  deps.say({
    phase: 'plan',
    detail: attempt === 0 ? 'Sol is producing the specification' : 'Sol is revising the specification',
  });
  const planned = await planSite(deps.model, facts.profile);
  deps.track('sol', planned);
  const produced = planned.value;

  deps.say({
    phase: 'plan',
    detail: `${produced.sitemap.pages.length} pages, ${produced.acceptanceCriteria.length} acceptance criteria (${planned.model}, ${(planned.ms / 1000).toFixed(1)}s)`,
    level: 'ok',
  });

  const sitePlanRef = await persistPlan(ctx, produced);
  return { plan: produced, sitePlanRef };
}

/**
 * Store a plan as the next version of `site-plan`.
 *
 * Shared by the initial plan and by every revision, so a replan appends to
 * the history rather than overwriting it: the plan that failed stays readable
 * next to the one that replaced it, which is what makes the audit trail —
 * plan v1 → evidence → adjudication → replan decision → plan v2 —
 * reconstructable.
 */
export async function persistPlan(ctx: FixedContext, produced: SitePlan): Promise<ArtifactRef> {
  const { deps, facts } = ctx;
  const ref = await deps.registry.put(facts.projectId, 'site-plan', produced);
  await deps.registry.accept(facts.projectId, ref);
  await deps.workspace.materialiseArtifact('design/brand-system.json', produced.brandSystem);
  await deps.workspace.materialiseArtifact('specs/sitemap.json', produced.sitemap);
  for (const page of produced.sitemap.pages) {
    const slug = page.route === HOME_ROUTE ? 'home' : page.route.replace(/^\//, '').replace(/\//g, '_');
    await deps.workspace.materialiseArtifact(`specs/pages/${slug}.json`, page);
  }
  return ref;
}

/**
 * Revise the failed specification, or return null.
 *
 * Everything the revision needs is passed as a structured runtime value —
 * the plan object itself, the open defects, the gate findings, the repair
 * outcomes — rather than reconstructed from progress prose after the fact.
 *
 * Returns null when Sol cannot be consulted or its answer does not satisfy
 * its contract. The caller stops rather than regenerating: falling back to
 * the planner would reinstate the defect this replaces.
 */
export async function revisePlan(
  ctx: RunContext,
  context: {
    scope: ReplanScope;
    adjudicationReason: string;
    unresolvedDefects: readonly Defect[];
    gateFindings: readonly string[];
    reviewSummary: string | null;
  },
): Promise<ProducedPlan | null> {
  const { deps, facts, progress } = ctx;
  const budget = (await deps.store.budgets.findOne({ _id: facts.projectId }))!;

  // Versions are read before the new ones are written, so the record points
  // at what this revision actually came from.
  const previousPlanDoc = await deps.store.artifacts.findOne(
    { projectId: facts.projectId, name: 'site-plan' },
    { sort: { version: -1 } },
  );
  const adjudicationDoc = await deps.store.artifacts.findOne(
    { projectId: facts.projectId, name: 'adjudication-decision' },
    { sort: { version: -1 } },
  );

  deps.say({
    phase: 'replan',
    detail: `Sol is revising the specification (scope ${context.scope}, ${context.unresolvedDefects.length} unresolved)`,
  });

  const record: ReplanRecord = {
    reviewCycle: progress.reviewCycle,
    previousPlanVersion: previousPlanDoc?.version ?? null,
    adjudicationVersion: adjudicationDoc?.version ?? null,
    adjudicationReason: context.adjudicationReason,
    scope: context.scope,
    failureDiagnosis: null,
    changes: [],
    preservedAreas: [],
    delta: null,
    scopeViolations: [],
    rejected: null,
    model: null,
    modelFailure: null,
    decidedAt: new Date(),
  };

  let revisedPlan: SitePlan | null = null;

  try {
    const replanned = await replanSite(deps.model, {
      profile: facts.profile,
      reviewCycle: progress.reviewCycle,
      previousPlan: progress.plan,
      adjudicationReason: context.adjudicationReason,
      scope: context.scope,
      unresolvedDefects: context.unresolvedDefects.map((d) => ({
        id: d.id,
        category: d.category,
        severity: d.severity,
        location: d.location,
        reason: d.reason,
      })),
      gateFindings: [...context.gateFindings],
      reviewSummary: context.reviewSummary,
      repairHistory: [...progress.repairHistory],
      remainingBudgets: {
        totalRepairJobs: budget.limits.totalRepairJobs - budget.used.totalRepairJobs,
        replans: budget.limits.replans - budget.used.replans,
        reviewRejections: budget.limits.reviewRejections - budget.used.reviewRejections,
      },
    });
    deps.track('sol', replanned);

    revisedPlan = replanned.value.revisedPlan;
    record.model = replanned.model;
    record.failureDiagnosis = replanned.value.failureDiagnosis;
    record.changes = replanned.value.changes;
    record.preservedAreas = replanned.value.preservedAreas;
    record.delta = planDelta(progress.plan, revisedPlan);
  } catch (error) {
    record.modelFailure = error instanceof Error ? error.message : String(error);
  }

  /**
   * Two objective reasons to refuse a revision that parsed cleanly.
   *
   * A scope violation is not a narrow revision that went slightly wide: it is
   * a different decision from the one adjudication authorised, and executing
   * it would let the requested scope mean nothing.
   *
   * An empty delta means Sol reported changes the plan does not contain.
   * Rebuilding from it would reproduce the site that just failed, spend the
   * cycle, and arrive at the same defects.
   *
   * Either way the decision is still persisted — a refused revision is part
   * of the history — but the plan is not activated, the site is not cleared,
   * and Sol is not called again.
   */
  if (revisedPlan && record.delta) {
    const permitted = authorizeReplanRevision({
      scope: context.scope,
      delta: record.delta,
      reportedChangeCount: record.changes.length,
    });
    record.scopeViolations = permitted.violations;
    if (!permitted.authorized) {
      record.rejected = permitted.reason;
      revisedPlan = null;
    }
  }

  const ref = await deps.registry.put(facts.projectId, 'replan-decision', record);
  await deps.registry.accept(facts.projectId, ref);
  await deps.workspace.materialiseArtifact(
    `decisions/replan-${String(progress.reviewCycle).padStart(2, '0')}.json`,
    record,
  );

  if (record.modelFailure) {
    deps.say({
      phase: 'replan',
      detail: `Sol could not revise the specification: ${record.modelFailure}`,
      level: 'fail',
    });
    return null;
  }

  if (record.rejected) {
    for (const violation of record.scopeViolations) {
      deps.say({ phase: 'replan', detail: `Scope exceeded — ${violation}`, level: 'fail' });
    }
    deps.say({ phase: 'replan', detail: `Revision refused: ${record.rejected}`, level: 'fail' });
    return null;
  }

  // A new version of site-plan, never an overwrite: the plan that failed
  // stays readable next to the one that replaced it. Reached only by a
  // revision the harness accepted.
  const sitePlanRef = await persistPlan(ctx, revisedPlan!);

  const d = record.delta!;
  deps.say({
    phase: 'replan',
    detail:
      `${record.changes.length} change(s): ` +
      `+${d.routesAdded.length}/-${d.routesRemoved.length}/~${d.routesRevised.length} routes` +
      `${d.brandChanged ? ', brand revised' : ''} — ${record.failureDiagnosis}`,
    level: 'ok',
  });

  return { plan: revisedPlan!, sitePlanRef };
}
