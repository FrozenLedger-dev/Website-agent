/**
 * Sol — specification revision (v1.2 §7, the third rung of the ladder).
 *
 * When adjudication concludes the plan is the defect, the plan has to change in
 * response to what failed. The implementation this replaces called the planner
 * again with the business profile and nothing else, so the revision could not
 * know what broke, which repairs had already been tried, or which parts of the
 * site were working. That is regeneration, not replanning: a second guess drawn
 * from the same inputs as the first, likely to reproduce the same fault.
 *
 * This skill deliberately does not call `planSite`. Planning from intake and
 * revising a plan against evidence are different tasks with different inputs,
 * and routing one through the other is what produced the defect.
 */
import { SolReplanResult, type BusinessProfile, type SolReplanRequest } from '@statxai/contracts';
import type { ModelClient } from '../client.js';

const SYSTEM = `You are Sol, the orchestrator for an autonomous website delivery platform.

A site was planned, built and evaluated, and the evaluation concluded that the
specification itself is at fault. You are revising that specification against the
evidence of how it failed.

This is a revision, not a fresh start. You have the plan that failed and the reasons
it failed. Change what the evidence implicates and leave the rest alone — a rewrite
that happens to be different is not a fix, and discards work that was passing.

THE BUSINESS PROFILE IS YOURS TO READ, NOT TO CHANGE

You are given it because it is the client's own account of their business and the only
source of factual truth: every claim the site makes must trace back to it. It stays
owned by the platform, and nothing you return can revise it.

This matters most for the defect you are most likely to see. When the site claims
something the profile does not support — a guarantee, a response time, an
around-the-clock service — the fix is to stop the site claiming it. It is never to
assume the business offers it. If a page cannot achieve its goal without a fact the
profile lacks, change the page's goal.

SCOPE

The adjudication requested a scope. Respect it.

  page    Revise the affected page or pages. Leave the brand system and the rest of
          the sitemap alone unless consistency genuinely requires otherwise.
  design  Revise the brand system, the composition and the page specifications that
          depend on them. Leave the site's strategy and its set of routes alone.
  site    The whole specification is open, including which pages exist.

A narrow scope is not an invitation to rewrite everything quietly. The harness
records what actually changed and compares it against what was requested.

WHAT TO RETURN

- failureDiagnosis: what was actually wrong with the previous plan, in terms of the
  evidence. Not "the plan had problems" — name the thing that could not work, and
  why the defects follow from it.
- changes: one entry per revision, each naming the area, the change and the specific
  evidence it answers. A change nothing in the evidence motivates should not be made.
- preservedAreas: what you deliberately left alone, so the diff reads as intentional.
- revisedPlan: the complete specification, including the parts you did not change.
  It is validated and stored as the next version, so it must stand on its own.`;

export interface ReplanEvidence extends SolReplanRequest {
  profile: BusinessProfile;
}

export async function replanSite(client: ModelClient, evidence: ReplanEvidence) {
  return client.call({
    tier: 'sol',
    label: 'sol:replan',
    system: SYSTEM,
    schema: SolReplanResult,
    maxTokens: 24_000,
    effort: 'high',
    prompt: `Revise this specification. Review cycle ${evidence.reviewCycle}.

WHY A REPLAN WAS REQUESTED
  scope: ${evidence.scope}
  ${evidence.adjudicationReason}

REMAINING BUDGETS (read-only facts)
${Object.entries(evidence.remainingBudgets).map(([k, v]) => `  ${k.padEnd(22)} ${v}`).join('\n')}

UNRESOLVED BLOCKING DEFECTS (${evidence.unresolvedDefects.length})
${
  evidence.unresolvedDefects
    .map((d) => `  ${d.id} [${d.severity} ${d.category}] ${d.location}\n      ${d.reason}`)
    .join('\n') || '  (none)'
}

REPAIRS ALREADY ATTEMPTED (${evidence.repairHistory.length})
${
  evidence.repairHistory
    .map((r) => `  ${r.defectId} (${r.fingerprint.slice(0, 10)}) → ${r.outcome}`)
    .join('\n') || '  (none)'
}
${
  evidence.repairHistory.length > 0
    ? '\nA defect that survived a repair is evidence that narrow repair may be insufficient\nfor it. Whether the cause lies in the specification or in how the build interpreted\nit is for you to judge from the evidence — a failed repair alone does not settle it.\n'
    : ''
}
DETERMINISTIC GATE FINDINGS
${evidence.gateFindings.map((f) => `  ${f}`).join('\n') || '  (none)'}

INDEPENDENT REVIEW
${evidence.reviewSummary ?? '  (not run this cycle)'}

BUSINESS PROFILE — the source of truth, unchanged and not yours to revise
${JSON.stringify(evidence.profile, null, 2)}

THE PLAN THAT FAILED — revise this
${JSON.stringify(evidence.previousPlan, null, 2)}`,
  });
}
