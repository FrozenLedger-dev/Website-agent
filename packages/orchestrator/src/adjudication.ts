/**
 * Adjudicating a failed evaluation.
 *
 * The harness computes what is *possible*; Sol reasons about what is
 * *appropriate*; the harness then authorises and executes. The split matters
 * because the two questions have different right answers: whether a replan is
 * affordable is arithmetic, and whether it is the correct response to eleven
 * blocking defects is judgement.
 *
 * What this replaces was neither. Two hard-coded rules decided everything:
 *
 *   mustFix.length > repairsLeft  →  replan
 *   otherwise                     →  repair every blocking defect with Luna
 *
 * The first is a proxy that fires on arithmetic alone, so a plan with one
 * genuinely structural defect and a nearly-spent budget was replanned while a
 * plan with many trivial ones was not. The second never asked whether a defect
 * was the kind of thing a narrow repair can fix.
 */
import type { AdjudicationAction, SolAdjudicationDecision } from '@statxai/contracts';
import type { Defect } from './defects.js';

/**
 * What the harness knows for certain before Sol is asked anything.
 *
 * Every field is measured, not judged. Budgets appear here and are passed to
 * Sol read-only: knowing two repairs remain should inform the choice, and
 * nothing Sol returns can change the number.
 */
export interface AdjudicationConstraints {
  blockingCount: number;
  repairsLeft: number;
  replansLeft: number;
  reviewRejectionsLeft: number;
  /** Fingerprints already repaired at least once, with their outcome. */
  previousRepairs: { defectId: string; fingerprint: string; outcome: string }[];
  autonomyMode: string;
}

/**
 * Which actions the harness will actually carry out right now.
 *
 * An action is offered only when the harness can both authorise *and* execute
 * it. `terra_specialist` and `visual_refine` are real members of the contract
 * with no executor behind them yet, so they are deliberately never offered —
 * asking Sol to choose something that cannot happen would invite a decision the
 * harness must then refuse.
 *
 * `block` is always legal. Giving up is the one action that never needs budget,
 * and a legal set that could be empty would leave Sol nothing to return.
 */
export function legalAdjudicationActions(c: AdjudicationConstraints): AdjudicationAction[] {
  const legal: AdjudicationAction[] = [];

  /**
   * `reviewRejections` counts revisions rejected by evaluation, not repair
   * cycles, so every action that answers a rejection needs one — repair and
   * replan alike. It previously gated repair only, which meant a replan could
   * run on a rejection the budget had no room for, and the two counters
   * measured different things while sharing a name.
   *
   * With the allowance gone, the site has been rejected as often as the project
   * permits and no amount of remaining repair or replan budget changes that:
   * `block` is all that is left.
   */
  const canAnswerRejection = c.reviewRejectionsLeft > 0;

  if (canAnswerRejection && c.blockingCount > 0 && c.repairsLeft > 0) legal.push('repair');
  if (canAnswerRejection && c.replansLeft > 0) legal.push('replan');
  legal.push('block');

  return legal;
}

/** Severity order for choosing what to fix first. */
const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * The single defect a fallback repairs.
 *
 * When Sol cannot be consulted, or its answer is refused, the harness has no
 * judgement about which defects belong together — only that something should be
 * attempted. Repairing *everything* blocking in that state is a broad semantic
 * choice made by nobody: it spends a repair job per defect on a batch no one
 * reasoned about, and on a run whose adjudication has already failed.
 *
 * So a fallback fixes one blocker and lets the next evaluation decide again.
 * Most severe first, then by id, so the choice is reproducible from the same
 * inputs rather than dependent on gate ordering.
 *
 * This constrains only the fallback. A decision Sol actually made may name as
 * many defects as it judged belong together.
 */
export function firstBlocker(defects: readonly Defect[]): Defect[] {
  const [first] = [...defects].sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
  });
  return first ? [first] : [];
}

/**
 * What the harness does when Sol cannot be consulted or its answer is refused.
 *
 * Deliberately the cheapest legal action rather than the most thorough: a run
 * that has already lost its adjudication should not also spend a replan on a
 * decision nobody made. Repair, then replan, then stop.
 */
export function fallbackAction(legal: readonly AdjudicationAction[]): AdjudicationAction {
  if (legal.includes('repair')) return 'repair';
  if (legal.includes('replan')) return 'replan';
  return 'block';
}

export interface AdjudicationAuthorization {
  action: AdjudicationAction;
  /** Defects the authorised repair will act on. Empty for other actions. */
  targets: Defect[];
  source: 'sol' | 'fallback';
  refusal: string | null;
}

/**
 * Turn a well-formed decision into an authorised action.
 *
 * Two refusals are possible and both fall back rather than failing the run:
 * an action the harness did not offer, and a repair naming defects that are not
 * in the open blocking set — which would otherwise spend the budget on a
 * fingerprint nothing raised.
 */
export function authorizeAdjudication(
  decision: SolAdjudicationDecision,
  legal: readonly AdjudicationAction[],
  blockingDefects: readonly Defect[],
): AdjudicationAuthorization {
  const fallback = (refusal: string): AdjudicationAuthorization => {
    const action = fallbackAction(legal);
    return {
      action,
      targets: action === 'repair' ? firstBlocker(blockingDefects) : [],
      source: 'fallback',
      refusal,
    };
  };

  if (!legal.includes(decision.action)) {
    return fallback(
      `Sol chose "${decision.action}", which the harness did not offer. Legal: ${legal.join(', ')}.`,
    );
  }

  if (decision.action !== 'repair') {
    return { action: decision.action, targets: [], source: 'sol', refusal: null };
  }

  const named = new Set(decision.defectIds ?? []);
  const targets = blockingDefects.filter((d) => named.has(d.id));
  const unknown = [...named].filter((id) => !blockingDefects.some((d) => d.id === id));

  if (targets.length === 0) {
    return fallback(`Sol's repair named no open blocking defect (${[...named].join(', ') || 'none'}).`);
  }

  return {
    action: 'repair',
    targets,
    source: 'sol',
    // A partially-recognised list is honoured for the part that exists, and the
    // discrepancy is recorded rather than silently dropped.
    refusal: unknown.length > 0 ? `Ignored unknown defect ids: ${unknown.join(', ')}.` : null,
  };
}

/** What gets stored as the versioned `adjudication-decision` artifact. */
export interface AdjudicationRecord {
  reviewCycle: number;
  action: AdjudicationAction;
  source: AdjudicationAuthorization['source'];
  refusal: string | null;
  targetDefectIds: string[];
  legalActions: AdjudicationAction[];
  constraints: AdjudicationConstraints;
  /** Sol's own words, kept even when the harness did not follow them. */
  proposed: {
    action: AdjudicationAction;
    reason: string;
    defectIds: string[];
    objective: string | null;
    scope: string | null;
  } | null;
  modelFailure: string | null;
  decidedAt: Date;
}
