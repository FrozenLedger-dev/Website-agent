/**
 * Severity policy: what blocks a release, and which endings remain legal.
 *
 * These moved out of `@statxai/contracts` with the extraction. The severity
 * table itself stays there — `ReviewOutcome` refines its own `blocking` field
 * against it, and contracts cannot import this package without a cycle — but
 * the questions asked *of* that table are policy, so they are answered and
 * tested here.
 */
import { describe, expect, it } from 'vitest';
import {
  SEVERITY_POLICY,
  blocksRelease,
  decideTerminal,
  humanReviewPermitted,
  isReleaseBlocked,
  legalTerminalOutcomes,
} from '../src/severity.js';

describe('release adjudication', () => {
  it('blocks on P0 and P1 only', () => {
    expect(isReleaseBlocked([{ severity: 'P0' }])).toBe(true);
    expect(isReleaseBlocked([{ severity: 'P1' }])).toBe(true);
    expect(isReleaseBlocked([{ severity: 'P2' }, { severity: 'P3' }])).toBe(false);
  });

  it('narrows terminal outcomes to rollback or blocked when a P1 is open', () => {
    const outcomes = legalTerminalOutcomes([{ severity: 'P1' }], { humanReviewPermitted: false });
    expect(outcomes).toEqual(['rollback_to_last_accepted', 'mark_blocked']);
    expect(outcomes).not.toContain('accept_non_blocking');
  });

  it('allows accepting documented issues when nothing blocking remains', () => {
    const outcomes = legalTerminalOutcomes([{ severity: 'P2' }], { humanReviewPermitted: false });
    expect(outcomes).toContain('accept_non_blocking');
  });

  it('offers human review only when autonomy policy permits it', () => {
    expect(legalTerminalOutcomes([{ severity: 'P2' }], { humanReviewPermitted: false })).not.toContain(
      'request_human_review',
    );
    expect(legalTerminalOutcomes([{ severity: 'P2' }], { humanReviewPermitted: true })).toContain(
      'request_human_review',
    );
  });
});


describe('the severity table this package re-exports', () => {
  it('is the one contracts refines against, not a second copy', () => {
    // A duplicated table would drift, and the drift would be silent: a review
    // outcome could call an issue non-blocking while policy blocked on it.
    for (const severity of ['P0', 'P1', 'P2', 'P3'] as const) {
      expect(blocksRelease(severity)).toBe(SEVERITY_POLICY[severity].blocksRelease);
      expect(isReleaseBlocked([{ severity }])).toBe(SEVERITY_POLICY[severity].blocksRelease);
    }
  });
});

describe('choosing the best legal ending', () => {
  it('accepts the documented issues when nothing blocking is left', () => {
    expect(decideTerminal([{ severity: 'P2' }], 'full_autonomous')).toBe('accept_non_blocking');
  });

  it('rolls back rather than accepting while a blocker is open', () => {
    // The distinction the whole helper exists for: a P1 is not something to
    // document and ship.
    expect(decideTerminal([{ severity: 'P1' }], 'full_autonomous')).toBe(
      'rollback_to_last_accepted',
    );
    expect(decideTerminal([{ severity: 'P0' }], 'full_autonomous')).toBe(
      'rollback_to_last_accepted',
    );
  });

  it('never returns an outcome the legal set excluded', () => {
    for (const mode of ['full_autonomous', 'supervised_autonomous', 'human_in_the_loop']) {
      for (const open of [[], [{ severity: 'P0' as const }], [{ severity: 'P3' as const }]]) {
        const legal = legalTerminalOutcomes(open, {
          humanReviewPermitted: humanReviewPermitted(mode),
        });
        expect(legal).toContain(decideTerminal(open, mode));
      }
    }
  });
});

describe('autonomy mode as a permission', () => {
  it('permits human review in every mode except full autonomy', () => {
    expect(humanReviewPermitted('full_autonomous')).toBe(false);
    expect(humanReviewPermitted('supervised_autonomous')).toBe(true);
    expect(humanReviewPermitted('human_in_the_loop')).toBe(true);
  });

  it('treats an unrecognised mode as supervised rather than fully autonomous', () => {
    // Failing closed: an unknown mode should widen the operator's options, not
    // silently remove the one that asks a person.
    expect(humanReviewPermitted('something_new')).toBe(true);
  });
});
