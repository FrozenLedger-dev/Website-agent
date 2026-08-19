/**
 * Sol — approval recommendation (v1.2 §7).
 *
 * Sol judges whether a validated revision is worth releasing. It does not
 * release it, and it cannot: the recommendation carries a verdict, a reason and
 * the issues it is knowingly shipping with, and nothing else. Whether a release
 * actually happens is decided afterwards by the harness, against policy Sol
 * never sees the levers for.
 *
 * The manifest used to record `approvedBy: "sol:machine-approval"` for a
 * decision no model was consulted about — the harness checked that no blocking
 * defect remained and wrote Sol's name on it. This skill is what makes that
 * attribution true, and the separate authorisation step is what keeps it
 * honest.
 */
import { SolApprovalRecommendation, type BusinessProfile, type SitePlan } from '@statxai/contracts';
import type { ModelClient } from '../client.js';

const SYSTEM = `You are Sol, the orchestrator for an autonomous website delivery platform.

A site has been built, has passed every deterministic gate, and has been reviewed
independently. Nothing blocking remains. You are giving your judgement on whether it
should be released.

You are not releasing it. The harness checks the release policy itself, and may refuse
a release you recommend — because the autonomy mode requires a human, because a
deterministic check disagrees, or because deployment is not configured. Your job is the
judgement, not the authority.

THE THREE VERDICTS

accept        The site does what the specification asked, states nothing the business
              profile does not support, and any remaining issues are ones you would be
              comfortable a client seeing live.
reject        Something is wrong enough that releasing would be worse than not
              releasing, even though no gate caught it. Say what.
human_review  The judgement is genuinely finely balanced, or the site touches something
              consequential enough that a person should look before it is public. Do not
              use this to avoid deciding.

HOW TO JUDGE

Blocking severity is not yours to set. P0 and P1 defects are handled before you are
asked, and you cannot acknowledge one into releasability — if you believe something
non-blocking is actually serious, say so and reject.

What is yours to weigh: whether the site reads as this business rather than a template,
whether every claim traces to the profile, whether the pages achieve the goals the plan
set them, and whether the remaining P2 and P3 issues are genuinely cosmetic.

ACKNOWLEDGED ISSUES

List the open non-blocking issues you are consciously shipping with, by their id. This
is a record that they were seen and judged acceptable, not a way to dismiss them. Refer
only to issues that are actually open — the harness checks the ids against the real
list, and one it cannot find is recorded as unverifiable.

Leave the list empty if nothing remains.`;

export interface ApprovalEvidence {
  reviewCycle: number;
  plan: SitePlan;
  profile: BusinessProfile;
  qualityScore: number;
  /** Zero by the time this runs; included so the judgement is on the record. */
  blockingCount: number;
  gatesRun: readonly string[];
  gateFindings: readonly string[];
  buildSummary: string;
  reviewSummary: string | null;
  openNonBlocking: readonly { id: string; severity: string; category: string; location: string; reason: string }[];
  repairHistory: readonly { defectId: string; outcome: string }[];
  replanCount: number;
  autonomyMode: string;
  /** Read-only facts. Sol cannot alter any of them. */
  releasePolicy: Readonly<Record<string, string>>;
}

export async function recommendApproval(client: ModelClient, evidence: ApprovalEvidence) {
  return client.call({
    tier: 'sol',
    label: 'sol:approve',
    system: SYSTEM,
    schema: SolApprovalRecommendation,
    maxTokens: 6_000,
    effort: 'high',
    prompt: `Review cycle ${evidence.reviewCycle}. Give your judgement on releasing this site.

DELIVERY SO FAR
  quality score      ${evidence.qualityScore}
  blocking defects   ${evidence.blockingCount}
  repairs attempted  ${evidence.repairHistory.length}
  replans            ${evidence.replanCount}
  autonomy mode      ${evidence.autonomyMode}

RELEASE POLICY (harness facts, read-only)
${Object.entries(evidence.releasePolicy).map(([k, v]) => `  ${k.padEnd(26)} ${v}`).join('\n')}

BUILD
  ${evidence.buildSummary}

DETERMINISTIC GATES (${evidence.gatesRun.length} run)
${evidence.gateFindings.map((f) => `  ${f}`).join('\n') || '  no findings'}

INDEPENDENT REVIEW
${evidence.reviewSummary ?? '  (not run this cycle)'}

OPEN NON-BLOCKING ISSUES (${evidence.openNonBlocking.length})
${
  evidence.openNonBlocking
    .map((i) => `  ${i.id} [${i.severity} ${i.category}] ${i.location} — ${i.reason}`)
    .join('\n') || '  (none)'
}

REPAIRS ATTEMPTED
${evidence.repairHistory.map((r) => `  ${r.defectId} → ${r.outcome}`).join('\n') || '  (none)'}

BUSINESS PROFILE — the source of truth for every claim, read-only
${JSON.stringify(evidence.profile, null, 2)}

THE ACCEPTED SPECIFICATION
${JSON.stringify(evidence.plan, null, 2)}`,
  });
}
