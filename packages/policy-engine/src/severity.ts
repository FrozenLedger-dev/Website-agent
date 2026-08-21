/**
 * What a severity permits (v1.2 §7, "Severity & Release Policy").
 *
 * `@statxai/contracts` says which severities exist; this says what they allow.
 * The split matters because the first is a data contract shared with the model
 * and the persistence layer, while the second is authority — and authority
 * belongs where it can be found, not scattered through whichever module
 * happened to need it first.
 */
import { blocksRelease, SEVERITY_POLICY, TerminalOutcome, type Severity } from '@statxai/contracts';

/**
 * Re-exported, not redefined.
 *
 * The table itself has to live in contracts because the `ReviewOutcome` schema
 * refines against it and contracts cannot import this package without a cycle.
 * Surfacing it here gives policy consumers one import site for authority
 * without minting a second answer to the same question.
 */
export { SEVERITY_POLICY, blocksRelease };

/** Release is permitted only when no blocking criterion is outstanding (§7). */
export function isReleaseBlocked(issues: readonly { severity: Severity }[]): boolean {
  return issues.some((i) => blocksRelease(i.severity));
}

/**
 * Terminal outcomes Sol may legally choose when a budget is exhausted (§7).
 *
 * The document lists these outcomes and, separately, states that P0/P1 must be
 * fixed before release. The intersection is left implicit there but is forced:
 * with a blocking issue open, "accept the documented non-blocking issues" is
 * not available, and the only lawful terminal outcomes are rollback or Blocked.
 * Encoded here rather than left to prompt guidance.
 */
export function legalTerminalOutcomes(
  issues: readonly { severity: Severity }[],
  options: { humanReviewPermitted: boolean },
): TerminalOutcome[] {
  const all = TerminalOutcome.options.filter(
    (o) => o !== 'request_human_review' || options.humanReviewPermitted,
  );
  if (!isReleaseBlocked(issues)) return all;
  return all.filter((o) => o === 'rollback_to_last_accepted' || o === 'mark_blocked' || o === 'request_human_review');
}

/**
 * §7's terminal escalation, with the constraint the document leaves implicit
 * made explicit: with a P0/P1 still open, accepting the documented non-blocking
 * issues is not among the lawful outcomes.
 *
 * This picks the *best* legal ending, which is why it must not be borrowed for
 * a refusal — it prefers `accept_non_blocking` in exactly the state a refused
 * release is in. `terminalForRefusal` answers that question instead.
 */
export function decideTerminal(
  defects: readonly { severity: Severity }[],
  autonomyMode: string,
): TerminalOutcome {
  const legal = legalTerminalOutcomes(defects, {
    humanReviewPermitted: humanReviewPermitted(autonomyMode),
  });
  if (legal.includes('accept_non_blocking')) return 'accept_non_blocking';
  if (legal.includes('rollback_to_last_accepted')) return 'rollback_to_last_accepted';
  return 'mark_blocked';
}

/**
 * The one place autonomy mode is read as a permission.
 *
 * It was previously spelled out at each call site, so a fourth mode would have
 * had to be remembered in several files at once.
 */
export function humanReviewPermitted(autonomyMode: string): boolean {
  return autonomyMode !== 'full_autonomous';
}
