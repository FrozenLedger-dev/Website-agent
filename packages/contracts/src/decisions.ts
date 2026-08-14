/**
 * Sol's decision contracts.
 *
 * Sol supplies judgement; the harness supplies authority. Everything Sol can
 * say is declared here, and it is deliberately narrow: there is no field for a
 * budget, a permission, a credential, a deployment target or a gate override.
 * Sol cannot ask for those because the contract gives it no way to express
 * them, which is a stronger guarantee than a prompt asking it not to.
 *
 * Choosing an action is not being allowed to take it. Every decision below is a
 * *proposal*. The policy engine decides whether it is legal, and the harness
 * decides whether it executes.
 *
 * ## Why these are flat objects rather than discriminated unions
 *
 * A `z.discriminatedUnion` renders as a top-level `anyOf`, and strict structured
 * output requires the schema root to be an object. So each decision is one
 * object with an `action` enum and nullable fields for the action-specific data,
 * refined so that the combinations which are actually meaningless get rejected
 * on parse. The model sees a shape it can satisfy; the platform still gets the
 * guarantee a union would have given it.
 */
import * as z from 'zod/v4';
import { SitePlan } from './artifacts.js';

// ---------------------------------------------------------------------------
// Routing: one-shot or decompose
// ---------------------------------------------------------------------------

export const WorkstreamSpec = z.object({
  /** Route this workstream produces, e.g. "/services". */
  route: z.string().min(1),
  reason: z.string().min(1),
});
export type WorkstreamSpec = z.infer<typeof WorkstreamSpec>;

/**
 * §3's "one-shot first, decompose when needed", as a decision rather than a
 * setting.
 *
 * It is currently an environment variable, and `decompose` is forced by throwing
 * a fake truncation error — so the strategy is chosen before anything about the
 * project is known, and the audit trail records nothing about why.
 */
export const SolRouteDecision = z
  .object({
    action: z.enum(['one_shot', 'decompose']),
    reason: z.string().min(1),
    /** How sure Sol is, 0 to 1. Recorded, never used to widen a budget. */
    confidence: z.number(),
    /** Required when decomposing: what each parallel unit builds. */
    workstreams: z.array(WorkstreamSpec).nullable(),
  })
  .refine((d) => d.action !== 'decompose' || (d.workstreams?.length ?? 0) > 0, {
    message: 'A decompose decision must name the workstreams it splits into.',
    path: ['workstreams'],
  })
  .refine((d) => d.confidence >= 0 && d.confidence <= 1, {
    message: 'confidence must be between 0 and 1.',
    path: ['confidence'],
  });
export type SolRouteDecision = z.infer<typeof SolRouteDecision>;

// ---------------------------------------------------------------------------
// Adjudication: what to do about a failed evaluation
// ---------------------------------------------------------------------------

export const AdjudicationAction = z.enum([
  /** Narrow, testable fixes. Luna's scope. */
  'repair',
  /** A defect too structural for a narrow repair; Terra rebuilds the area. */
  'terra_specialist',
  /** Subjective design weakness. Terra refines; Luna is the wrong tool. */
  'visual_refine',
  /** The plan is the defect, not the pages. */
  'replan',
  /** Nothing blocking remains worth acting on. */
  'recommend_approval',
  /** Not releasable and not repairable within what remains. */
  'block',
]);
export type AdjudicationAction = z.infer<typeof AdjudicationAction>;

/**
 * Sol reasoning about evidence, replacing a fixed harness path that always
 * chose Luna and always one defect at a time.
 *
 * Remaining budgets are supplied to Sol as information so it can prefer a cheap
 * action when little is left. They are not supplied as something it can change:
 * there is no field here that spends, grants or extends anything.
 */
export const SolAdjudicationDecision = z
  .object({
    action: AdjudicationAction,
    reason: z.string().min(1),
    /** Required for `repair`: which defects, by id. */
    defectIds: z.array(z.string().min(1)).nullable(),
    /** Required for `terra_specialist` and `visual_refine`: what to achieve. */
    objective: z.string().nullable(),
    /** Required for `replan`: how much of the specification is in question. */
    scope: z.enum(['page', 'design', 'site']).nullable(),
  })
  .superRefine((d, ctx) => {
    const needs = (field: 'defectIds' | 'objective' | 'scope', ok: boolean) => {
      if (ok) return;
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `A "${d.action}" decision requires ${field}.`,
      });
    };

    if (d.action === 'repair') needs('defectIds', (d.defectIds?.length ?? 0) > 0);
    if (d.action === 'terra_specialist' || d.action === 'visual_refine') {
      needs('objective', (d.objective ?? '').trim().length > 0);
    }
    if (d.action === 'replan') needs('scope', d.scope !== null);
  });
export type SolAdjudicationDecision = z.infer<typeof SolAdjudicationDecision>;

// ---------------------------------------------------------------------------
// Replanning
// ---------------------------------------------------------------------------

/**
 * What a replan needs to know, assembled by the harness.
 *
 * The current implementation calls the planner again with the original business
 * profile and nothing else, so the revision cannot possibly learn from the
 * failure that triggered it — it is a fresh guess wearing a second attempt's
 * name. Every field here exists because its absence made that true.
 */
export const SolReplanRequest = z.object({
  previousPlanRef: z.string().min(1),
  reasonForReplan: z.string().min(1),
  scope: z.enum(['page', 'design', 'site']),
  deterministicFailures: z.array(z.string()),
  reviewFindings: z.array(z.string()),
  attemptedRepairs: z.array(z.string()),
  unresolvedDefects: z.array(z.string()),
  /** Informational. A plan may be trimmed to fit; budgets are not negotiable. */
  remainingBudgets: z.record(z.string(), z.number()),
});
export type SolReplanRequest = z.infer<typeof SolReplanRequest>;

export const SolReplanResult = z.object({
  /** What was actually wrong with the previous strategy. */
  diagnosis: z.string().min(1),
  /** What this revision changes, so the diff is reviewable. */
  changes: z.array(z.string().min(1)).min(1),
  /** Accepted facts carried forward untouched. */
  preserved: z.array(z.string()),
  plan: SitePlan,
});
export type SolReplanResult = z.infer<typeof SolReplanResult>;

// ---------------------------------------------------------------------------
// Approval: a recommendation, never an authorisation
// ---------------------------------------------------------------------------

/**
 * Sol's opinion on releasing. Not permission to release.
 *
 * The manifest currently records `approvedBy: "sol:machine-approval"` for a
 * decision no model was consulted about — the harness checked that no blocking
 * defect remained and wrote Sol's name on it. Separating the two means the
 * audit trail can say who judged and who authorised, and they can disagree.
 */
export const SolApprovalRecommendation = z.object({
  recommendation: z.enum(['accept', 'reject', 'human_review']),
  reason: z.string().min(1),
  /** Non-blocking issues Sol is knowingly shipping with. */
  acknowledgedIssues: z.array(z.string()),
});
export type SolApprovalRecommendation = z.infer<typeof SolApprovalRecommendation>;

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

export interface DecisionRejection {
  ok: false;
  reason: string;
}
export type DecisionCheck<T> = { ok: true; decision: T } | DecisionRejection;

/**
 * Reject an action the harness did not offer.
 *
 * A well-formed decision is not the same as a permitted one. Sol is told which
 * actions are legal for the current state; picking anything else — including a
 * perfectly valid action whose budget is gone — is refused here, before the
 * decision reaches project state. This is the contract-level half of the check.
 * The policy engine still decides whether a legal action is authorised now.
 */
export function checkAdjudicationLegal(
  decision: SolAdjudicationDecision,
  legalActions: readonly AdjudicationAction[],
): DecisionCheck<SolAdjudicationDecision> {
  if (!legalActions.includes(decision.action)) {
    return {
      ok: false,
      reason:
        `Sol chose "${decision.action}", which is not legal in this state. ` +
        `Legal actions were: ${legalActions.join(', ') || '(none)'}.`,
    };
  }
  return { ok: true, decision };
}
