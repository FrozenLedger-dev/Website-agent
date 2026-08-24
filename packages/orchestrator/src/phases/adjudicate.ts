/**
 * Deciding what to do about a failed evaluation.
 *
 * The harness computes what is affordable and executable, Sol reasons about
 * which of those is appropriate, and the harness authorises. Two rules used to
 * do all of it — `mustFix.length > repairsLeft` triggered a replan and
 * everything else went to Luna — and neither asked what kind of defect it was
 * looking at.
 *
 * This phase decides and records. It does not act: spending the budgets and
 * running the authorised action stay in the delivery loop, where the
 * convergence — evaluate, adjudicate, repair or replan, evaluate again — is
 * still readable in one place.
 */
import { adjudicate } from '@statxai/agents';
import {
  authorizeAdjudication,
  fallbackAction,
  firstBlockerId,
  legalAdjudicationActions,
  repairEligibility,
  repairableDefects,
  maxRepairTargets,
  type AdjudicationAuthorization,
  type AdjudicationConstraints,
} from '@statxai/policy-engine';
import type { AdjudicationAction } from '@statxai/contracts';
import { recordedConstraints, type AdjudicationRecord } from '../adjudication.js';
import type { Defect } from '../defects.js';
import type { RunContext } from '../run-context.js';

export interface AdjudicationOutcome {
  authorization: AdjudicationAuthorization;
  /** Sol's own words, kept even when the harness did not follow them. */
  proposed: AdjudicationRecord['proposed'];
  constraints: AdjudicationConstraints;
  legal: AdjudicationAction[];
}

async function recordAdjudication(
  ctx: Pick<RunContext, 'deps' | 'facts'>,
  record: AdjudicationRecord,
): Promise<void> {
  const { deps, facts } = ctx;
  const ref = await deps.registry.put(facts.projectId, 'adjudication-decision', record);
  await deps.registry.accept(facts.projectId, ref);
  await deps.workspace.materialiseArtifact(
    `decisions/adjudication-${String(record.reviewCycle).padStart(2, '0')}.json`,
    record,
  );
}

export async function adjudicateDefects(
  ctx: RunContext,
  mustFix: Defect[],
  evidence: {
    gateRun: { findings: { severity: string; gate: string; location: string; message: string }[] };
    reviewSummary: string | null;
  },
): Promise<AdjudicationOutcome> {
  const { deps, facts, progress } = ctx;

/**
 * §7's escalation ladder, decided by Sol rather than by arithmetic.
 *
 * The harness computes what is affordable and executable; Sol reasons about
 * which of those is appropriate; the harness authorises and acts. Two rules
 * used to do all of it: `mustFix.length > repairsLeft` triggered a replan,
 * and everything else went to Luna. Neither asked what kind of defect it
 * was looking at.
 */
  const currentBudget = (await deps.store.budgets.findOne({ _id: facts.projectId }))!;

  // What each fingerprint has already spent. Policy decides eligibility from
  // this; it cannot read the collection itself, and counting open defects is
  // not the same question — the per-defect allowance outlives a cycle.
  const spentPerDefect = await deps.store.defectBudgets.find({ projectId: facts.projectId }).toArray();
  const repairsUsedByFingerprint = Object.fromEntries(
    spentPerDefect.map((d) => [d.fingerprint, d.repairsUsed]),
  );

  const constraints: AdjudicationConstraints = {
    blockingDefects: mustFix,
    repairsLeft: currentBudget.limits.totalRepairJobs - currentBudget.used.totalRepairJobs,
    repairsPerDefect: currentBudget.limits.repairsPerDefect,
    repairsUsedByFingerprint,
    replansLeft: currentBudget.limits.replans - currentBudget.used.replans,
    reviewRejectionsLeft:
      currentBudget.limits.reviewRejections - currentBudget.used.reviewRejections,
    previousRepairs: progress.repairHistory,
    autonomyMode: facts.autonomyMode,
  };
  const legal = legalAdjudicationActions(constraints);

  let adjudication: AdjudicationAuthorization;
  let proposedAdjudication: AdjudicationRecord['proposed'] = null;
  let adjudicationFailure: string | null = null;

  try {
    const decided = await adjudicate(deps.model, {
      reviewCycle: progress.reviewCycle,
      legalActions: legal,
      gateFindings: evidence.gateRun.findings.map(
        (f) => `${f.severity} ${f.gate} ${f.location} — ${f.message}`,
      ),
      reviewSummary: evidence.reviewSummary,
      openBlockingDefects: mustFix.map((d) => ({
        id: d.id,
        category: d.category,
        severity: d.severity,
        location: d.location,
        reason: d.reason,
        acceptanceTest: d.acceptanceTest,
      })),
      previousRepairs: progress.repairHistory,
      // What policy already knows about repairability, handed to Sol so it
      // chooses among defects the harness can actually act on.
      repairEligibility: repairEligibility(constraints),
      maxRepairTargets: maxRepairTargets(constraints),
      remainingBudgets: {
        totalRepairJobs: constraints.repairsLeft,
        replans: constraints.replansLeft,
        reviewRejections: constraints.reviewRejectionsLeft,
      },
      autonomyMode: facts.autonomyMode,
    });
    deps.track('sol', decided);

    proposedAdjudication = {
      action: decided.value.action,
      reason: decided.value.reason,
      defectIds: decided.value.defectIds ?? [],
      objective: decided.value.objective ?? null,
      scope: decided.value.scope ?? null,
    };
    adjudication = authorizeAdjudication(decided.value, legal, constraints);
  } catch (error) {
    // An adjudication that cannot be obtained must not end a delivery: the
    // harness takes the cheapest legal action and records that Sol was absent.
    adjudicationFailure = error instanceof Error ? error.message : String(error);
    const action = fallbackAction(legal);
    adjudication = {
      action,
      // One blocker, not the whole set: with no adjudication there is no
      // judgement about which defects belong together — and one that can
      // still be charged for, or the cycle would repair nothing.
      targetIds: action === 'repair' ? firstBlockerId(repairableDefects(mustFix, constraints)) : [],
      source: 'fallback',
      refusal: `Sol could not be consulted: ${adjudicationFailure}`,
    };
  }

  await recordAdjudication(ctx, {
    reviewCycle: progress.reviewCycle,
    action: adjudication.action,
    source: adjudication.source,
    refusal: adjudication.refusal,
    targetDefectIds: [...adjudication.targetIds],
    legalActions: legal,
    constraints: recordedConstraints(constraints),
    proposed: proposedAdjudication,
    modelFailure: adjudicationFailure,
    decidedAt: new Date(),
  });

  deps.say({
    phase: 'adjudicate',
    detail:
      adjudication.source === 'sol'
        ? `Sol chose ${adjudication.action}: ${proposedAdjudication?.reason ?? ''}`
        : `${adjudication.action} by fallback — ${adjudication.refusal ?? ''}`,
    level: adjudication.source === 'sol' ? 'ok' : 'warn',
  });



  return { authorization: adjudication, proposed: proposedAdjudication, constraints, legal };
}
