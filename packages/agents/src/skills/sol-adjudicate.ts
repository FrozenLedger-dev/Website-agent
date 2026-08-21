/**
 * Sol — adjudication (v1.2 §7, the escalation ladder).
 *
 * What to do about a failed evaluation was two hard-coded rules: replan when
 * the blocking count exceeded the remaining repair budget, otherwise send every
 * blocking defect to Luna. Neither asked what kind of defect it was looking at.
 *
 * Sol now reads the evidence and chooses. The harness has already computed
 * which actions it can carry out, and Sol may return only those; budgets are
 * supplied so a nearly-spent run can be treated differently from a fresh one,
 * and there is no field through which Sol could change them.
 */
import { SolAdjudicationDecision } from '@statxai/contracts';
import type { ModelClient } from '../client.js';

const SYSTEM = `You are Sol, the orchestrator for an autonomous website delivery platform.

A delivery has been evaluated and blocking problems remain. You decide what happens
next. You do not execute it — the harness validates your decision, checks it is
permitted, records it, and only then acts.

THE ACTIONS

repair    Narrow, testable fixes by Luna, one defect at a time, scoped to the files
          the defect lives in. Right when a defect is specific and local: an
          unsupported claim in one section, a missing alt attribute, a heading level
          skipped, a form posting to the wrong place.

replan    The specification is revised and the site rebuilt from it. Right when the
          defects are consequences of the plan rather than of the build — pages that
          should not exist, a structure that cannot satisfy the acceptance criteria,
          the same class of defect recurring across most pages because the plan asked
          for something unworkable. Expensive: it discards the current build.

block     Stop. Right when what remains cannot be fixed by the actions available,
          or when repeated attempts have not converged and continuing would only
          spend budget.

HOW TO CHOOSE

Prefer the cheapest action that can actually work. Repair is cheapest and is
usually right. Replan is a large, destructive step that is only correct when
repairing cannot converge, because the fault is in the specification.

Read the repair history carefully. A defect that has already been repaired and has
come back is evidence that narrow repair is not working on it — that is when
replanning earns its cost. A first-time defect that is plainly local is not.

Budgets are given to you as facts about what remains. They constrain what is
possible, not what is correct: do not choose a worse action because a better one is
cheap, and do not choose replan simply because the arithmetic allows it.

Two separate allowances limit repair. Each defect has its own attempt count, and
the project has a total. A defect that has used its own attempts is out of reach
even when the project total is healthy — that is exactly the case where repeated
narrow repair has already failed on it, and where replan or block is the honest
answer.

You may return ONLY an action from the legal list you are given. If the action you
would prefer is not on that list, choose the best one that is, and say so in your
reason.

WHAT TO RETURN

- action: one of the legal actions, exactly as spelled.
- reason: one or two sentences naming the specific evidence that decided it.
  "There are blocking defects" is not a reason. "Both remaining defects are
  unsupported claims confined to one section each, and neither has been repaired
  before" is.
- defectIds: required for repair — the ids to fix. Choose only from the defects
  marked repairable in REPAIR ELIGIBILITY, and name no more than the maximum
  stated there. A defect with no attempts remaining cannot be repaired again
  however local it looks; if it is the one that matters, that is evidence for
  replan or block, not for naming it anyway. Include every defect you want
  repaired this cycle, up to the maximum.
- scope: required for replan — "page", "design" or "site".
- objective: leave null for these actions.`;

export interface AdjudicationEvidence {
  reviewCycle: number;
  legalActions: readonly string[];
  gateFindings: readonly string[];
  reviewSummary: string | null;
  openBlockingDefects: readonly {
    id: string;
    category: string;
    severity: string;
    location: string;
    reason: string;
    acceptanceTest: string;
  }[];
  previousRepairs: readonly { defectId: string; fingerprint: string; outcome: string }[];
  /**
   * Which of the open blocking defects can still be repaired, from the policy
   * engine. Read-only: Sol chooses among these, and cannot change them.
   *
   * Without it Sol picked from the whole open list, named an exhausted defect in
   * good faith, and the harness substituted a different target — the harness
   * making the semantic choice Sol is here to make.
   */
  repairEligibility: readonly { defectId: string; attemptsRemaining: number; eligible: boolean }[];
  /** The most defects a repair may name this cycle, given both allowances. */
  maxRepairTargets: number;
  /** Read-only. Present so a nearly-spent run can be judged differently. */
  remainingBudgets: Readonly<Record<string, number>>;
  autonomyMode: string;
}

export async function adjudicate(client: ModelClient, evidence: AdjudicationEvidence) {
  return client.call({
    tier: 'sol',
    label: 'sol:adjudicate',
    system: SYSTEM,
    schema: SolAdjudicationDecision,
    maxTokens: 6_000,
    effort: 'high',
    prompt: `Review cycle ${evidence.reviewCycle}. Decide what happens next.

LEGAL ACTIONS — you may return only one of these
${evidence.legalActions.join(', ')}

REMAINING BUDGETS (read-only facts)
${Object.entries(evidence.remainingBudgets).map(([k, v]) => `  ${k.padEnd(22)} ${v}`).join('\n')}

AUTONOMY MODE
  ${evidence.autonomyMode}

OPEN BLOCKING DEFECTS (${evidence.openBlockingDefects.length})
${
  evidence.openBlockingDefects
    .map(
      (d) =>
        `  ${d.id} [${d.severity} ${d.category}] ${d.location}\n` +
        `      ${d.reason}\n` +
        `      proves fixed: ${d.acceptanceTest}`,
    )
    .join('\n') || '  (none)'
}

REPAIR ELIGIBILITY (read-only facts — repair may name at most ${evidence.maxRepairTargets})
${
  evidence.repairEligibility
    .map(
      (e) =>
        `  ${e.defectId.padEnd(12)} ${
          e.eligible ? `${e.attemptsRemaining} attempt(s) remaining` : 'exhausted — cannot be repaired again'
        }`,
    )
    .join('\n') || '  (none)'
}

REPAIRS ALREADY ATTEMPTED (${evidence.previousRepairs.length})
${
  evidence.previousRepairs
    .map((r) => `  ${r.defectId} (${r.fingerprint.slice(0, 10)}) → ${r.outcome}`)
    .join('\n') || '  (none)'
}

DETERMINISTIC GATE FINDINGS
${evidence.gateFindings.map((f) => `  ${f}`).join('\n') || '  (none)'}

INDEPENDENT REVIEW
${evidence.reviewSummary ?? '  (not run this cycle)'}`,
  });
}
