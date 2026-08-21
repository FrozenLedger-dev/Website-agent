/**
 * Recommending a release, and authorising one.
 *
 * Sol judges; the harness decides. These pin the boundary, because the manifest
 * used to record `approvedBy: "sol:machine-approval"` for a decision no model
 * was consulted about — crediting a model for the harness's own arithmetic and
 * leaving nothing to check the harness against.
 */
import { describe, expect, it } from 'vitest';
import { SolApprovalRecommendation, toStrictModelSchema } from '@statxai/contracts';
import {
  RELEASE_POLICY_VERSION,
  authorizeRelease,
  terminalForRefusal,
  verifyAcknowledged,
  type ReleaseEvidence,
} from '../src/release.js';

const clean = (over: Partial<ReleaseEvidence> = {}): ReleaseEvidence => ({
  blockingDefects: 0,
  buildSucceeded: true,
  gatesPassed: true,
  autonomyMode: 'full_autonomous',
  deploymentConfigured: true,
  ...over,
});

const says = (
  recommendation: 'accept' | 'reject' | 'human_review',
  acknowledgedIssues: string[] = [],
) => SolApprovalRecommendation.parse({ recommendation, reason: 'because', acknowledgedIssues });

/** Nothing open, and the check to prove it. */
const nothingOpen = () => verifyAcknowledged([], []);

describe('a recommendation the harness agrees with', () => {
  it('authorises a release', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean(),
      acknowledgement: nothingOpen(),
    });
    expect(auth).toMatchObject({ authorized: true, action: 'release' });
    expect(auth.policyVersion).toBe(RELEASE_POLICY_VERSION);
  });

  it('authorises even with no deployment target, because that is not a refusal', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ deploymentConfigured: false }),
      acknowledgement: nothingOpen(),
    });
    expect(auth.authorized).toBe(true);
    expect(auth.reason).toContain('no deployment target');
  });
});

describe('an acceptance with nothing to check it against', () => {
  it('fails closed rather than reading absence as "nothing omitted"', () => {
    // `acknowledgement?.unacknowledged ?? []` treated a missing check as an
    // empty one, so a caller that simply forgot it got a release. The delivery
    // loop always supplies one, but an exported policy function has to hold its
    // own invariant rather than trust every caller to remember.
    const auth = authorizeRelease({ recommendation: says('accept'), evidence: clean() });

    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('no acknowledgement check was supplied');
  });

  it('does not require one to refuse a rejection', () => {
    // Only an acceptance ships with anything, so only an acceptance needs the
    // check. A rejection is refused on its own terms.
    const auth = authorizeRelease({ recommendation: says('reject'), evidence: clean() });
    expect(auth.action).toBe('block');
    expect(auth.reason).toContain('recommended rejection');
  });

  it('does not require one to refuse on deterministic grounds', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ blockingDefects: 1 }),
    });
    expect(auth.reason).toContain('not waivable');
  });
});

describe('a recommendation the harness overrules', () => {
  it('refuses acceptance over a blocking defect', () => {
    // Blocking severity is harness policy. A recommendation cannot waive one,
    // and the refusal is not a disagreement with Sol — the deterministic facts
    // are checked before the recommendation is read at all.
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ blockingDefects: 2 }),
    });
    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('not waivable');
  });

  it('refuses acceptance over a failed build', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ buildSucceeded: false }),
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toContain('nothing to release');
  });

  it('refuses acceptance over failing gates', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ gatesPassed: false }),
    });
    expect(auth.authorized).toBe(false);
  });

  it('routes acceptance to a human where the autonomy mode requires one', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ autonomyMode: 'human_in_the_loop' }),
      acknowledgement: nothingOpen(),
    });
    expect(auth).toMatchObject({ authorized: false, action: 'human_review' });
  });
});

describe('a recommendation against releasing', () => {
  it('never releases on a rejection', () => {
    const auth = authorizeRelease({ recommendation: says('reject'), evidence: clean() });
    expect(auth).toMatchObject({ authorized: false, action: 'block' });
  });

  it('never auto-releases when Sol asks for a human', () => {
    const auth = authorizeRelease({
      recommendation: says('human_review'),
      evidence: clean({ autonomyMode: 'supervised_autonomous' }),
    });
    expect(auth).toMatchObject({ authorized: false, action: 'human_review' });
  });

  it('blocks rather than inventing a reviewer under full autonomy', () => {
    // Sol may ask for a person; it may not summon one. Full autonomy has none,
    // so the request is honoured as far as policy allows — by not releasing.
    const auth = authorizeRelease({ recommendation: says('human_review'), evidence: clean() });
    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('full autonomy does not provide');
  });
});

describe('a recommendation that never arrived', () => {
  it('is not an approval', () => {
    // Silence is not consent, and the harness does not write a verdict on
    // Sol's behalf.
    const auth = authorizeRelease({ recommendation: null, evidence: clean() });
    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('No approval recommendation');
  });

  it('defers to a human where the mode has one', () => {
    const auth = authorizeRelease({
      recommendation: null,
      evidence: clean({ autonomyMode: 'supervised_autonomous' }),
    });
    expect(auth).toMatchObject({ authorized: false, action: 'human_review' });
  });

  it('is refused before the deterministic checks even matter', () => {
    const auth = authorizeRelease({
      recommendation: null,
      evidence: clean({ blockingDefects: 1 }),
    });
    expect(auth.authorized).toBe(false);
  });
});

describe('acknowledged issues', () => {
  const open = [{ id: 'QA-004' }, { id: 'GATE-007' }];

  it('separates ids that match something open from ids that do not', () => {
    // An acknowledgement records that an issue was seen and judged acceptable.
    // An id nothing matches is not that, so it is recorded rather than counted.
    const checked = verifyAcknowledged(['QA-004', 'QA-999'], open);
    expect(checked.known).toEqual(['QA-004']);
    expect(checked.unknown).toEqual(['QA-999']);
  });

  it('reports open issues that were never mentioned', () => {
    // Detecting invented ids without detecting omitted ones catches only the
    // careless half: a recommendation silent about three open issues reads
    // identically to one that never looked.
    const checked = verifyAcknowledged(['QA-004'], open);
    expect(checked.unacknowledged).toEqual(['GATE-007']);
  });

  it('reports everything open when nothing was acknowledged', () => {
    expect(verifyAcknowledged([], open).unacknowledged).toEqual(['QA-004', 'GATE-007']);
  });

  it('reports nothing outstanding when the list is complete', () => {
    const checked = verifyAcknowledged(['QA-004', 'GATE-007'], open);
    expect(checked.unacknowledged).toEqual([]);
    expect(checked.unknown).toEqual([]);
  });

  it('accepts an empty acknowledgement when nothing is open', () => {
    expect(verifyAcknowledged([], [])).toEqual({ known: [], unknown: [], unacknowledged: [] });
  });

  it('cannot be used to acknowledge a blocker, because blockers never reach it', () => {
    // Only non-blocking issues are offered for acknowledgement, and blocking
    // severity is checked by the harness before the recommendation is read.
    const auth = authorizeRelease({
      recommendation: says('accept', ['GATE-001']),
      evidence: clean({ blockingDefects: 1 }),
    });
    expect(auth.authorized).toBe(false);
  });
});

describe('what a recommendation cannot express', () => {
  const forbidden =
    /deploy|release|bypass|permission|budget|policy|credential|token|autonomy|authoriz|authoris/i;

  it('carries only a verdict, a reason and acknowledged issues', () => {
    const json = toStrictModelSchema(SolApprovalRecommendation) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      'acknowledgedIssues',
      'reason',
      'recommendation',
    ]);
    for (const key of Object.keys(json.properties ?? {})) {
      expect(forbidden.test(key), key).toBe(false);
    }
  });
});

describe('an acceptance has to account for what is still open', () => {
  const open = [{ id: 'QA-004' }, { id: 'QA-005' }];

  it('refuses an acceptance that ignores open issues', () => {
    // The load-bearing case: `acknowledgedIssues` is the stated basis on which
    // something ships with known defects. Accepting while silent about them is
    // not that judgement — it is the absence of one.
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean(),
      acknowledgement: verifyAcknowledged([], open),
    });

    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('QA-004');
    expect(auth.reason).toContain('QA-005');
  });

  it('refuses a partial acknowledgement', () => {
    const auth = authorizeRelease({
      recommendation: says('accept', ['QA-004']),
      evidence: clean(),
      acknowledgement: verifyAcknowledged(['QA-004'], open),
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toContain('QA-005');
    expect(auth.reason).not.toContain('QA-004');
  });

  it('authorises when every open issue is accounted for', () => {
    const auth = authorizeRelease({
      recommendation: says('accept', ['QA-004', 'QA-005']),
      evidence: clean(),
      acknowledgement: verifyAcknowledged(['QA-004', 'QA-005'], open),
    });
    expect(auth).toMatchObject({ authorized: true, action: 'release' });
  });

  it('authorises when nothing is open to acknowledge', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean(),
      acknowledgement: verifyAcknowledged([], []),
    });
    expect(auth.authorized).toBe(true);
  });

  it('does not apply the check to a rejection', () => {
    // Only an acceptance ships with known defects, so only an acceptance has to
    // account for them.
    const auth = authorizeRelease({
      recommendation: says('reject'),
      evidence: clean(),
      acknowledgement: verifyAcknowledged([], open),
    });
    expect(auth.action).toBe('block');
    expect(auth.reason).toContain('recommended rejection');
  });

  it('still refuses on deterministic grounds before checking completeness', () => {
    // Ordering: a blocking defect is refused for being a blocking defect, not
    // for an unacknowledged P2.
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ blockingDefects: 1 }),
      acknowledgement: verifyAcknowledged([], open),
    });
    expect(auth.reason).toContain('not waivable');
  });
});

describe('the terminal outcome of a denied release', () => {
  /**
   * The contradiction this replaces: the late refusal borrowed `decideTerminal`,
   * which prefers `accept_non_blocking` whenever no P0 or P1 remains — and that
   * branch is reached only when none remains, because blocking defects are
   * cleared before an approval is ever sought. A correct Sol rejection could
   * therefore return `outcome: blocked` beside
   * `terminalDecision: accept_non_blocking`.
   */
  it('reports a Sol rejection as blocked', () => {
    const auth = authorizeRelease({ recommendation: says('reject'), evidence: clean() });
    expect(auth.action).toBe('block');
    expect(terminalForRefusal(auth.action)).toBe('mark_blocked');
  });

  it('reports an approval that could not be obtained as blocked under full autonomy', () => {
    const auth = authorizeRelease({ recommendation: null, evidence: clean() });
    expect(auth.action).toBe('block');
    expect(terminalForRefusal(auth.action)).toBe('mark_blocked');
  });

  it('reports an incomplete acknowledgement as blocked', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean(),
      acknowledgement: verifyAcknowledged([], [{ id: 'QA-004' }]),
    });
    expect(auth.action).toBe('block');
    expect(terminalForRefusal(auth.action)).toBe('mark_blocked');
  });

  it('reports a human-review transition as a request for one', () => {
    const auth = authorizeRelease({
      recommendation: says('human_review'),
      evidence: clean({ autonomyMode: 'supervised_autonomous' }),
    });
    expect(auth.action).toBe('human_review');
    expect(terminalForRefusal(auth.action)).toBe('request_human_review');
  });

  it('treats a missing authorisation as blocked, not as a review request', () => {
    // Null reaches here from every path that never sought approval at all.
    expect(terminalForRefusal(null)).toBe('mark_blocked');
  });

  it('never reports a denied release as an acceptance', () => {
    // The property that matters, across every way a release can be refused.
    const refusals = [
      authorizeRelease({ recommendation: says('reject'), evidence: clean() }),
      authorizeRelease({ recommendation: says('human_review'), evidence: clean() }),
      authorizeRelease({ recommendation: null, evidence: clean() }),
      authorizeRelease({ recommendation: says('accept'), evidence: clean() }),
      authorizeRelease({ recommendation: says('accept'), evidence: clean({ blockingDefects: 1 }) }),
      authorizeRelease({ recommendation: says('accept'), evidence: clean({ gatesPassed: false }) }),
      authorizeRelease({ recommendation: says('accept'), evidence: clean({ buildSucceeded: false }) }),
      authorizeRelease({
        recommendation: says('accept'),
        evidence: clean({ autonomyMode: 'human_in_the_loop' }),
        acknowledgement: verifyAcknowledged([], []),
      }),
      authorizeRelease({
        recommendation: says('accept'),
        evidence: clean(),
        acknowledgement: verifyAcknowledged([], [{ id: 'QA-004' }]),
      }),
    ];

    for (const auth of refusals) {
      expect(auth.authorized, auth.reason).toBe(false);
      expect(terminalForRefusal(auth.action), auth.reason).not.toBe('accept_non_blocking');
      expect(['mark_blocked', 'request_human_review']).toContain(terminalForRefusal(auth.action));
    }
  });
});
