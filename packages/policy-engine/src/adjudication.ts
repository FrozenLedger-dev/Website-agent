/**
 * Adjudication policy — which response to a failed evaluation is permitted.
 *
 * Pure. The harness measures the constraints; this decides what may be offered
 * and whether Sol's answer stands.
 *
 * What this replaces was neither measured nor decided in one place. Two
 * hard-coded rules did all of it — `mustFix.length > repairsLeft` triggered a
 * replan, and everything else went to Luna — so a plan with one structural
 * defect and a nearly-spent budget was replanned while a plan with many trivial
 * ones was not, and nothing asked whether a defect was the kind a narrow repair
 * can fix.
 */
import type { AdjudicationAction, Severity } from '@statxai/contracts';

/**
 * A defect, reduced to what policy actually reads.
 *
 * Deliberately not the orchestrator's `Defect`: this package must not depend on
 * the layer it advises. Authorisation returns ids, and the caller resolves them
 * back to its own authoritative objects before executing anything.
 */
export interface PolicyDefect {
  id: string;
  severity: Severity;
  /**
   * The unit the repair budget is charged against.
   *
   * Defects are collapsed by fingerprint before they reach here, so this is
   * one-to-one with `id` for any given evaluation — but the *budget* is keyed
   * on the fingerprint and survives across cycles, which is why policy has to
   * see it rather than counting defects.
   */
  fingerprint: string;
}

/**
 * What the harness knows for certain before Sol is asked anything.
 *
 * Every field is measured, not judged. Budgets appear here and are passed to
 * Sol read-only: knowing two repairs remain should inform the choice, and
 * nothing Sol returns can change the number.
 */
export interface AdjudicationConstraints {
  /** The open blocking defects, not just how many there are. */
  blockingDefects: readonly PolicyDefect[];
  repairsLeft: number;
  /** How many repairs any one fingerprint may receive, from the project budget. */
  repairsPerDefect: number;
  /** Repairs already charged, by fingerprint. A missing key means none. */
  repairsUsedByFingerprint: Readonly<Record<string, number>>;
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
/**
 * The blocking defects a repair could still be charged for.
 *
 * `totalRepairJobs` is a project-wide allowance and `repairsPerDefect` is a
 * per-fingerprint one, and having the first does not imply having the second.
 * A defect that has already used its own allowance cannot be repaired again
 * however much project budget is left, so it must not be counted towards
 * whether `repair` is worth offering, and must not be handed to Luna as a
 * target.
 */
export function repairableDefects(
  defects: readonly PolicyDefect[],
  c: Pick<AdjudicationConstraints, 'repairsPerDefect' | 'repairsUsedByFingerprint'>,
): PolicyDefect[] {
  return defects.filter((d) => (c.repairsUsedByFingerprint[d.fingerprint] ?? 0) < c.repairsPerDefect);
}

export function legalAdjudicationActions(c: AdjudicationConstraints): AdjudicationAction[] {
  const legal: AdjudicationAction[] = [];

  /**
   * `reviewRejections` is how many rejected evaluations may trigger another
   * corrective action. Every action that answers a rejection needs one — repair
   * and replan alike — while `block` ends the run rather than answering it and
   * therefore spends none. It previously gated repair only, which meant a
   * replan could run on a rejection the budget had no room for, and the two
   * counters measured different things while sharing a name.
   *
   * With the allowance gone, the site has been rejected as often as the project
   * permits and no amount of remaining repair or replan budget changes that:
   * `block` is all that is left.
   */
  const canAnswerRejection = c.reviewRejectionsLeft > 0;

  /**
   * Offering `repair` needs a defect that can actually receive one. Counting
   * open blockers instead meant a cycle could be authorised, reach
   * `spendRepairAttempt`, be refused per fingerprint, and apply nothing — with
   * the run having spent a review rejection to learn that.
   */
  const repairable = repairableDefects(c.blockingDefects, c).length;

  if (canAnswerRejection && repairable > 0 && c.repairsLeft > 0) legal.push('repair');
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
export function firstBlockerId(defects: readonly PolicyDefect[]): string[] {
  const [first] = [...defects].sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
  });
  return first ? [first.id] : [];
}

/**
 * What the harness does when Sol cannot be consulted or its answer is refused.
 *
 * The harness may recover operationally. It may not reason semantically in the
 * reasoning model's absence, and replanning is reasoning: it asserts that the
 * specification itself is wrong enough to discard and rebuild. That judgement
 * is Sol's whole purpose here, and a harness that reaches it alone — from a
 * timeout, a malformed response or an illegal action — has substituted its own
 * conclusion for the one it failed to obtain, then spent a rebuild on it.
 *
 * So the fallback is one narrow repair, or nothing. Repairing a single blocker
 * is a bounded operational step whose result the next evaluation judges;
 * `block` stops and leaves the decision to a human. Replanning is reachable
 * only from a replan Sol actually chose and the harness authorised.
 */
export function fallbackAction(legal: readonly AdjudicationAction[]): AdjudicationAction {
  return legal.includes('repair') ? 'repair' : 'block';
}

export interface AdjudicationAuthorization {
  action: AdjudicationAction;
  /** Ids the authorised repair will act on. Empty for other actions. */
  targetIds: string[];
  source: 'sol' | 'fallback';
  refusal: string | null;
}

/**
 * Turn a well-formed decision into an authorised action.
 *
 * Three refusals are possible and all of them fall back rather than failing the
 * run: an action the harness did not offer, a repair naming defects that are
 * not in the open blocking set, and a repair naming only defects whose own
 * fingerprint budget is spent. The last was previously invisible here — the
 * targets were handed over, and `spendRepairAttempt` refused them one at a time
 * afterwards, so a cycle could be authorised and repair nothing.
 *
 * A partly-eligible list is honoured for the part that is eligible, matching
 * how a partly-recognised list is treated: the harness does what it can and
 * records what it would not do.
 */
export function authorizeAdjudication(
  decision: { action: AdjudicationAction; defectIds?: readonly string[] | null | undefined },
  legal: readonly AdjudicationAction[],
  constraints: AdjudicationConstraints,
): AdjudicationAuthorization {
  const blockingDefects = constraints.blockingDefects;
  const repairable = repairableDefects(blockingDefects, constraints);

  const fallback = (refusal: string): AdjudicationAuthorization => {
    const action = fallbackAction(legal);
    return {
      action,
      // The fallback repairs a defect that can still receive one, never merely
      // the most severe.
      targetIds: action === 'repair' ? firstBlockerId(repairable) : [],
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
    return { action: decision.action, targetIds: [], source: 'sol', refusal: null };
  }

  const named = new Set(decision.defectIds ?? []);
  const open = blockingDefects.filter((d) => named.has(d.id));
  const unknown = [...named].filter((id) => !blockingDefects.some((d) => d.id === id));

  if (open.length === 0) {
    return fallback(`Sol's repair named no open blocking defect (${[...named].join(', ') || 'none'}).`);
  }

  const eligible = repairableDefects(open, constraints);
  const exhausted = open.filter((d) => !eligible.some((e) => e.id === d.id)).map((d) => d.id);

  if (eligible.length === 0) {
    return fallback(
      `Sol's repair named only defects whose per-defect budget is spent: ${exhausted.join(', ')}.`,
    );
  }

  const notes: string[] = [];
  if (unknown.length > 0) notes.push(`Ignored unknown defect ids: ${unknown.join(', ')}.`);
  if (exhausted.length > 0) {
    notes.push(`Dropped defects whose per-defect budget is spent: ${exhausted.join(', ')}.`);
  }

  return {
    action: 'repair',
    targetIds: eligible.map((d) => d.id),
    source: 'sol',
    refusal: notes.length > 0 ? notes.join(' ') : null,
  };
}
