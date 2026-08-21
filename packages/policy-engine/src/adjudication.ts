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
 * Most severe first, then by id.
 *
 * Used wherever the harness has to choose *which* defects to act on without a
 * judgement to go by — the fallback, and trimming an over-large repair to what
 * the budget can pay for. Ties break on id so the choice is reproducible from
 * the same inputs rather than dependent on gate ordering.
 */
const bySeverityThenId = (a: PolicyDefect, b: PolicyDefect): number => {
  const bySeverity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
};

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
  const [first] = [...defects].sort(bySeverityThenId);
  return first ? [first.id] : [];
}

/**
 * How many repairs may be authorised this cycle.
 *
 * `spendRepairAttempt` charges one `totalRepairJobs` unit **per target**, so a
 * repair naming three defects needs three units and not one. Authorising more
 * than the project allowance can pay for produces an artifact that names
 * targets the harness already knew it could not charge for — the same
 * "authorisation ≠ executable set" gap the per-fingerprint fix closed, on the
 * other budget.
 */
export function repairCapacity(
  c: Pick<AdjudicationConstraints, 'repairsLeft'>,
): number {
  return Math.max(0, c.repairsLeft);
}

/**
 * What Sol is told about repairability, per defect.
 *
 * Policy already knows which defects can still be charged for. Without handing
 * that to the model, Sol picks from the whole open blocking list, names an
 * exhausted defect in good faith, and the harness quietly substitutes a
 * different one — which is the harness making the semantic choice Sol exists to
 * make. These are read-only facts: there is no field here Sol can send back.
 */
export interface RepairEligibility {
  defectId: string;
  attemptsRemaining: number;
  eligible: boolean;
}

export function repairEligibility(c: AdjudicationConstraints): RepairEligibility[] {
  return c.blockingDefects.map((d) => {
    const used = c.repairsUsedByFingerprint[d.fingerprint] ?? 0;
    const attemptsRemaining = Math.max(0, c.repairsPerDefect - used);
    return { defectId: d.id, attemptsRemaining, eligible: attemptsRemaining > 0 };
  });
}

/**
 * The most defects a repair may name this cycle, given both allowances.
 *
 * Naming more than this cannot be executed as decided, so it is the number Sol
 * is given rather than one of the two budgets on its own.
 */
export function maxRepairTargets(c: AdjudicationConstraints): number {
  return Math.min(repairCapacity(c), repairableDefects(c.blockingDefects, c).length);
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
 * Refusals fall back rather than failing the run. A decision does not survive
 * intact when it names an action the harness did not offer, names defects that
 * are not in the open blocking set, names only defects whose own fingerprint
 * budget is spent, or names more defects than the project allowance can pay
 * for.
 *
 * The last two were previously invisible here: the targets were handed over and
 * `spendRepairAttempt` refused them afterwards, one at a time, inside the
 * transaction. Both budgets are charged per target — `repairsPerDefect` against
 * the fingerprint and `totalRepairJobs` once for each defect named — so an
 * authorisation that ignores either one describes work the harness already knew
 * it could not do.
 *
 * A partly-payable list is honoured for the part that is payable, matching how
 * a partly-recognised list is treated: the harness does what it can and records
 * what it would not do. The transaction stays authoritative in case state has
 * drifted since these facts were read.
 */
export function authorizeAdjudication(
  decision: { action: AdjudicationAction; defectIds?: readonly string[] | null | undefined },
  legal: readonly AdjudicationAction[],
  constraints: AdjudicationConstraints,
): AdjudicationAuthorization {
  const blockingDefects = constraints.blockingDefects;
  const repairable = repairableDefects(blockingDefects, constraints);

  const capacity = repairCapacity(constraints);

  const fallback = (refusal: string): AdjudicationAuthorization => {
    const action = fallbackAction(legal);
    // One repair, and only if both allowances can pay for it. The fallback
    // repairs a defect that can still receive one, never merely the most
    // severe.
    const canRepair = action === 'repair' && capacity >= 1;
    return {
      action: action === 'repair' && !canRepair ? 'block' : action,
      targetIds: canRepair ? firstBlockerId(repairable) : [],
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

  /**
   * Trim to what the project allowance can pay for, most severe first.
   *
   * `spendRepairAttempt` charges one `totalRepairJobs` unit per target, so a
   * three-defect repair with one unit left executed the first and had the other
   * two refused inside the transaction — while the artifact recorded all three
   * as authorised.
   */
  const payable = [...eligible].sort(bySeverityThenId).slice(0, capacity);
  const overCapacity = eligible.filter((d) => !payable.includes(d)).map((d) => d.id);

  if (payable.length === 0) {
    return fallback(
      `Sol's repair named ${eligible.length} defect(s) and the project repair allowance is ${capacity}.`,
    );
  }

  const notes: string[] = [];
  if (unknown.length > 0) notes.push(`Ignored unknown defect ids: ${unknown.join(', ')}.`);
  if (exhausted.length > 0) {
    notes.push(`Dropped defects whose per-defect budget is spent: ${exhausted.join(', ')}.`);
  }
  if (overCapacity.length > 0) {
    notes.push(
      `Dropped for want of project repair allowance (${capacity} left): ${overCapacity.join(', ')}.`,
    );
  }

  return {
    action: 'repair',
    targetIds: payable.map((d) => d.id),
    source: 'sol',
    refusal: notes.length > 0 ? notes.join(' ') : null,
  };
}
