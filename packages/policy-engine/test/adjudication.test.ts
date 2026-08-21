/**
 * Adjudicating a failed evaluation.
 *
 * The harness computes what is possible, Sol reasons about what is appropriate,
 * and the harness authorises. These tests pin the two halves of that boundary:
 * which actions get offered, and what happens to a decision that steps outside
 * the offer.
 */
import { describe, expect, it } from 'vitest';
import {
  SolAdjudicationDecision,
  toStrictModelSchema,
  type AdjudicationAction,
} from '@statxai/contracts';
import {
  authorizeAdjudication,
  fallbackAction,
  firstBlockerId,
  legalAdjudicationActions,
  maxRepairTargets,
  repairCapacity,
  repairEligibility,
  repairableDefects,
  type AdjudicationConstraints,
  type PolicyDefect,
} from '../src/adjudication.js';

const constraints = (over: Partial<AdjudicationConstraints> = {}): AdjudicationConstraints => ({
  blockingDefects: OPEN,
  repairsLeft: 5,
  repairsPerDefect: 2,
  repairsUsedByFingerprint: {},
  replansLeft: 2,
  reviewRejectionsLeft: 3,
  previousRepairs: [],
  autonomyMode: 'full_autonomous',
  ...over,
});

/**
 * Defects are collapsed by fingerprint before policy sees them, so a distinct
 * id implies a distinct fingerprint unless a test deliberately says otherwise.
 */
const defect = (
  id: string,
  severity: PolicyDefect['severity'] = 'P1',
  fingerprint = `fp:${id}`,
): PolicyDefect => ({ id, severity, fingerprint });

const OPEN = [defect('GATE-001'), defect('GATE-002'), defect('GATE-003')];

const decision = (over: Record<string, unknown> = {}) =>
  SolAdjudicationDecision.parse({
    action: 'repair',
    reason: 'Both remaining defects are local and neither has been repaired before.',
    defectIds: ['GATE-001'],
    objective: null,
    scope: null,
    ...over,
  });

describe('which actions the harness offers', () => {
  it('offers repair, replan and block when everything has budget', () => {
    expect(legalAdjudicationActions(constraints())).toEqual(['repair', 'replan', 'block']);
  });

  it('withdraws repair when no repair job remains', () => {
    expect(legalAdjudicationActions(constraints({ repairsLeft: 0 }))).toEqual(['replan', 'block']);
  });

  it('withdraws every answering action when no rejection remains', () => {
    // A rejection is spent by whatever answers it, so exhausting the allowance
    // ends the loop regardless of what repair or replan budget is left.
    expect(legalAdjudicationActions(constraints({ reviewRejectionsLeft: 0 }))).toEqual(['block']);
  });

  it('withdraws replan when the replan budget is gone', () => {
    expect(legalAdjudicationActions(constraints({ replansLeft: 0 }))).toEqual(['repair', 'block']);
  });

  it('always offers block, so the legal set is never empty', () => {
    // Giving up needs no budget, and Sol must always have something to return.
    const spent = constraints({ repairsLeft: 0, replansLeft: 0, reviewRejectionsLeft: 0 });
    expect(legalAdjudicationActions(spent)).toEqual(['block']);
  });

  it('never offers an action the harness cannot execute', () => {
    // `terra_specialist` and `visual_refine` are in the contract but have no
    // executor yet. Offering them would invite a decision that must be refused.
    const all = legalAdjudicationActions(constraints());
    expect(all).not.toContain('terra_specialist');
    expect(all).not.toContain('visual_refine');
    expect(all).not.toContain('recommend_approval');
  });
});

describe('authorising Sol', () => {
  const legal = legalAdjudicationActions(constraints());

  it('follows a repair naming open defects, and scopes to exactly those', () => {
    const auth = authorizeAdjudication(decision({ defectIds: ['GATE-001', 'GATE-003'] }), legal, constraints());

    expect(auth.source).toBe('sol');
    expect(auth.action).toBe('repair');
    expect(auth.targetIds).toEqual(['GATE-001', 'GATE-003']);
    expect(auth.refusal).toBeNull();
  });

  it('follows a replan', () => {
    const auth = authorizeAdjudication(
      decision({ action: 'replan', defectIds: null, scope: 'site' }),
      legal, constraints());
    expect(auth).toMatchObject({ action: 'replan', source: 'sol', targetIds: [] });
  });

  it('follows a block', () => {
    const auth = authorizeAdjudication(decision({ action: 'block', defectIds: null }), legal, constraints());
    expect(auth).toMatchObject({ action: 'block', source: 'sol' });
  });

  it('refuses an action the harness did not offer', () => {
    // Well-formed and still not permitted: replanning with no replan budget.
    const withoutReplan = legalAdjudicationActions(constraints({ replansLeft: 0 }));
    const auth = authorizeAdjudication(
      decision({ action: 'replan', defectIds: null, scope: 'site' }),
      withoutReplan, constraints());

    expect(auth.source).toBe('fallback');
    expect(auth.action).toBe('repair');
    expect(auth.refusal).toContain('did not offer');
  });

  it('refuses a repair naming defects nobody raised', () => {
    // Otherwise the budget is spent on a fingerprint that does not exist.
    const auth = authorizeAdjudication(decision({ defectIds: ['GATE-999'] }), legal, constraints());

    expect(auth.source).toBe('fallback');
    expect(auth.refusal).toContain('named no open blocking defect');
  });

  it('honours the recognised part of a partly-unknown list, and records the rest', () => {
    const auth = authorizeAdjudication(
      decision({ defectIds: ['GATE-002', 'GATE-999'] }),
      legal, constraints());

    expect(auth.source).toBe('sol');
    expect(auth.targetIds).toEqual(['GATE-002']);
    expect(auth.refusal).toContain('GATE-999');
  });

  it('falls back to exactly one blocker, not the whole set', () => {
    // Repairing everything in a fallback is a broad semantic choice made by
    // nobody: it spends a repair job per defect on a batch no one reasoned
    // about, on a run whose adjudication has already failed.
    const auth = authorizeAdjudication(decision({ defectIds: ['GATE-999'] }), legal, constraints());

    expect(auth.source).toBe('fallback');
    expect(auth.targetIds).toHaveLength(1);
  });

  it('lets a decision Sol actually made name several defects', () => {
    // The single-blocker rule constrains the fallback only.
    const auth = authorizeAdjudication(
      decision({ defectIds: ['GATE-001', 'GATE-002', 'GATE-003'] }),
      legal, constraints());
    expect(auth.source).toBe('sol');
    expect(auth.targetIds).toHaveLength(3);
  });
});

describe('the fallback when Sol cannot be consulted', () => {
  /**
   * The harness may recover operationally; it may not reason semantically in
   * the reasoning model's absence. Replanning asserts that the specification is
   * wrong enough to discard and rebuild, which is the judgement Sol exists to
   * make — so a timeout, a malformed response or an illegal action must never
   * reach it.
   */
  it('repairs when repair is available', () => {
    expect(fallbackAction(['repair', 'replan', 'block'])).toBe('repair');
  });

  it('blocks rather than replanning when repair is unavailable', () => {
    // The case this function used to get wrong: it returned `replan`, so the
    // harness concluded the specification was at fault and spent a rebuild on
    // a decision nobody made.
    expect(fallbackAction(['replan', 'block'])).toBe('block');
  });

  it('blocks when nothing else is legal', () => {
    expect(fallbackAction(['block'])).toBe('block');
  });

  it('never returns replan for any legal set', () => {
    const sets: AdjudicationAction[][] = [
      ['repair', 'replan', 'block'],
      ['replan', 'block'],
      ['repair', 'block'],
      ['block'],
      [],
    ];
    for (const set of sets) expect(fallbackAction(set), set.join('|')).not.toBe('replan');
  });
});

describe('a lost adjudication cannot trigger a rebuild', () => {
  const sol = (over: Record<string, unknown> = {}) =>
    SolAdjudicationDecision.parse({
      action: 'replan',
      reason: 'The specification is the problem.',
      defectIds: null,
      objective: null,
      scope: 'site',
      ...over,
    });

  it('Sol unavailable, repair legal → one narrow repair', () => {
    // Modelled the way the orchestrator does it: no decision to authorise, so
    // the harness takes the fallback action directly.
    const legal = legalAdjudicationActions(constraints());
    const action = fallbackAction(legal);

    expect(action).toBe('repair');
    expect(firstBlockerId(OPEN)).toHaveLength(1);
  });

  it('Sol unavailable, only replan and block legal → block', () => {
    const legal = legalAdjudicationActions(constraints({ repairsLeft: 0 }));
    expect(legal).toEqual(['replan', 'block']);
    expect(fallbackAction(legal)).toBe('block');
  });

  it('illegal Sol decision, only replan and block legal → block', () => {
    // Sol asks for something the harness did not offer while replan is the only
    // other action with budget. The refusal must not become a rebuild.
    const legal = legalAdjudicationActions(constraints({ repairsLeft: 0 }));
    const auth = authorizeAdjudication(sol({ action: 'repair', defectIds: ['GATE-001'], scope: null }), legal, constraints());

    expect(auth.source).toBe('fallback');
    expect(auth.action).toBe('block');
    expect(auth.targetIds).toEqual([]);
  });

  it('a replan Sol actually chose still runs', () => {
    // The restriction is on the fallback, not on replanning itself.
    const legal = legalAdjudicationActions(constraints());
    const auth = authorizeAdjudication(sol(), legal, constraints());

    expect(auth).toMatchObject({ action: 'replan', source: 'sol', refusal: null });
  });
});

describe('what adjudication cannot do', () => {
  it('carries no field that spends, grants or releases', () => {
    // Budgets reach Sol as read-only facts. The contract offers no way back.
    const json = toStrictModelSchema(SolAdjudicationDecision) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      'action',
      'defectIds',
      'objective',
      'reason',
      'scope',
    ]);
  });

  it('leaves budget spending to the harness', () => {
    // The authorisation names an action and its targets. Nothing about it
    // mutates a counter; that happens transactionally in the orchestrator.
    const auth = authorizeAdjudication(decision(), legalAdjudicationActions(constraints()), constraints());
    expect(Object.keys(auth).sort()).toEqual(['action', 'refusal', 'source', 'targetIds']);
  });
});

describe('choosing the one defect a fallback repairs', () => {
  const at = (id: string, severity: 'P0' | 'P1'): PolicyDefect => defect(id, severity);

  it('takes the most severe blocker', () => {
    const picked = firstBlockerId([at('B', 'P1'), at('A', 'P0')]);
    expect(picked).toEqual(['A']);
  });

  it('breaks ties by id, so the choice does not depend on gate ordering', () => {
    const forwards = firstBlockerId([at('GATE-003', 'P1'), at('GATE-001', 'P1')]);
    const backwards = firstBlockerId([at('GATE-001', 'P1'), at('GATE-003', 'P1')]);

    expect(forwards).toEqual(['GATE-001']);
    expect(backwards).toEqual(['GATE-001']);
  });

  it('returns nothing when there is nothing blocking', () => {
    expect(firstBlockerId([])).toEqual([]);
  });
});

describe('a rejection is a rejection, whatever answers it', () => {
  /**
   * `reviewRejections` counts revisions rejected by evaluation. It used to gate
   * repair only, so a replan ran on a rejection the budget had no room for and
   * a run that replanned twice reported the same rejection count as one never
   * rejected at all.
   */
  it('withdraws both repair and replan when the allowance is gone', () => {
    const spent = legalAdjudicationActions(
      constraints({ reviewRejectionsLeft: 0, repairsLeft: 8, replansLeft: 2 }),
    );
    expect(spent).toEqual(['block']);
  });

  it('offers both while the allowance remains', () => {
    expect(legalAdjudicationActions(constraints({ reviewRejectionsLeft: 1 }))).toEqual([
      'repair',
      'replan',
      'block',
    ]);
  });

  it('still withdraws an action whose own budget is gone', () => {
    // The rejection allowance is necessary, not sufficient.
    expect(
      legalAdjudicationActions(constraints({ reviewRejectionsLeft: 2, replansLeft: 0 })),
    ).toEqual(['repair', 'block']);
    expect(
      legalAdjudicationActions(constraints({ reviewRejectionsLeft: 2, repairsLeft: 0 })),
    ).toEqual(['replan', 'block']);
  });
});

describe('per-defect repair eligibility', () => {
  /**
   * `totalRepairJobs` is a project-wide allowance; `repairsPerDefect` is a
   * per-fingerprint one that outlives a cycle. Having the first does not imply
   * having the second, and policy used to reason only about the first — so it
   * offered `repair`, Sol chose it, and `spendRepairAttempt` then refused each
   * target in turn. The cycle spent a review rejection to repair nothing.
   */
  const spent = (fingerprints: string[]) =>
    Object.fromEntries(fingerprints.map((f) => [f, 2]));

  describe('which defects can still be charged for', () => {
    it('counts a fingerprint nobody has repaired as eligible', () => {
      // A missing key means none used, not "unknown, assume spent".
      expect(
        repairableDefects(OPEN, { repairsPerDefect: 2, repairsUsedByFingerprint: {} }),
      ).toHaveLength(3);
    });

    it('excludes a fingerprint that has reached the limit', () => {
      const eligible = repairableDefects(OPEN, {
        repairsPerDefect: 2,
        repairsUsedByFingerprint: { 'fp:GATE-002': 2 },
      });
      expect(eligible.map((d) => d.id)).toEqual(['GATE-001', 'GATE-003']);
    });

    it('treats the limit as exclusive, matching the guarded increment', () => {
      // `spendRepairAttempt` matches on `repairsUsed < repairsPerDefect`, so
      // one below the limit is still spendable and exactly at it is not.
      const at = (used: number) =>
        repairableDefects([defect('A')], {
          repairsPerDefect: 2,
          repairsUsedByFingerprint: { 'fp:A': used },
        }).length;

      expect(at(0)).toBe(1);
      expect(at(1)).toBe(1);
      expect(at(2)).toBe(0);
      expect(at(3)).toBe(0);
    });

    it('keys on the fingerprint, not the id', () => {
      // The budget survives a reviewer rephrasing the defect into a new id.
      const renamed = defect('GATE-999', 'P1', 'fp:GATE-001');
      expect(
        repairableDefects([renamed], {
          repairsPerDefect: 2,
          repairsUsedByFingerprint: { 'fp:GATE-001': 2 },
        }),
      ).toEqual([]);
    });
  });

  describe('what gets offered', () => {
    it('withdraws repair when every blocker has spent its own allowance', () => {
      // The defect this commit fixes. Project budget remains, so the old rule
      // offered repair here and nothing could be charged for.
      const c = constraints({
        repairsLeft: 5,
        repairsUsedByFingerprint: spent(['fp:GATE-001', 'fp:GATE-002', 'fp:GATE-003']),
      });

      expect(c.repairsLeft).toBeGreaterThan(0);
      expect(legalAdjudicationActions(c)).toEqual(['replan', 'block']);
    });

    it('still offers repair while one blocker can be charged for', () => {
      const c = constraints({
        repairsUsedByFingerprint: spent(['fp:GATE-001', 'fp:GATE-003']),
      });
      expect(legalAdjudicationActions(c)).toContain('repair');
    });

    it('withdraws repair when the project allowance is gone, whatever the defects have left', () => {
      // The other direction, unchanged: both allowances have to hold.
      const c = constraints({ repairsLeft: 0, repairsUsedByFingerprint: {} });
      expect(legalAdjudicationActions(c)).not.toContain('repair');
    });

    it('withdraws repair when nothing is blocking, as before', () => {
      expect(legalAdjudicationActions(constraints({ blockingDefects: [] }))).toEqual([
        'replan',
        'block',
      ]);
    });
  });

  describe('what gets authorised', () => {
    it('drops an exhausted target, keeps the rest, and says which it dropped', () => {
      const c = constraints({ repairsUsedByFingerprint: spent(['fp:GATE-002']) });
      const auth = authorizeAdjudication(
        decision({ defectIds: ['GATE-001', 'GATE-002'] }),
        legalAdjudicationActions(c),
        c,
      );

      expect(auth.source).toBe('sol');
      expect(auth.targetIds).toEqual(['GATE-001']);
      expect(auth.refusal).toContain('GATE-002');
    });

    it('falls back when Sol names only defects whose allowance is spent', () => {
      // Previously these were handed to Luna and refused one at a time inside
      // the transaction, after the cycle had already been committed to.
      const c = constraints({ repairsUsedByFingerprint: spent(['fp:GATE-002']) });
      const auth = authorizeAdjudication(
        decision({ defectIds: ['GATE-002'] }),
        legalAdjudicationActions(c),
        c,
      );

      expect(auth.source).toBe('fallback');
      expect(auth.refusal).toContain('per-defect budget is spent');
      expect(auth.targetIds).not.toContain('GATE-002');
    });

    it('never authorises a target that cannot be charged for', () => {
      // The property behind the cases above, over every subset of exhaustion.
      const ids = ['GATE-001', 'GATE-002', 'GATE-003'];
      for (let mask = 0; mask < 8; mask += 1) {
        const exhausted = ids.filter((_, i) => (mask >> i) & 1);
        const c = constraints({ repairsUsedByFingerprint: spent(exhausted.map((id) => `fp:${id}`)) });
        const auth = authorizeAdjudication(
          decision({ defectIds: ids }),
          legalAdjudicationActions(c),
          c,
        );

        for (const id of auth.targetIds) {
          expect(exhausted, `authorised ${id} with mask ${mask}`).not.toContain(id);
        }
      }
    });

    it('falls back to a blocker that can be repaired, not merely the most severe', () => {
      // The fallback takes the most severe blocker. If that one is exhausted it
      // has to take the next, or a refused adjudication spends a cycle doing
      // nothing — the same failure, reached from the recovery path.
      const worst = defect('A', 'P0');
      const rest = defect('B', 'P1');
      const c = constraints({
        blockingDefects: [worst, rest],
        repairsUsedByFingerprint: spent(['fp:A']),
      });
      const auth = authorizeAdjudication(
        decision({ defectIds: ['GATE-999'] }),
        legalAdjudicationActions(c),
        c,
      );

      expect(auth.source).toBe('fallback');
      expect(auth.action).toBe('repair');
      expect(auth.targetIds).toEqual(['B']);
    });

    it('blocks rather than repairing nothing when no blocker is eligible', () => {
      const c = constraints({
        repairsUsedByFingerprint: spent(['fp:GATE-001', 'fp:GATE-002', 'fp:GATE-003']),
      });
      const auth = authorizeAdjudication(
        decision({ defectIds: ['GATE-001'] }),
        legalAdjudicationActions(c),
        c,
      );

      expect(auth.action).toBe('block');
      expect(auth.targetIds).toEqual([]);
    });
  });
});

describe('the project repair allowance caps how many defects one repair may name', () => {
  /**
   * `spendRepairAttempt` charges one `totalRepairJobs` unit **per target**, so a
   * repair naming three defects needs three units. Policy checked that repair
   * was affordable at all, never that the *named set* was, so with one unit left
   * all three were authorised: the first executed, the other two were refused
   * inside the transaction, and the artifact still recorded three targets the
   * harness knew it could not charge for.
   *
   * Same class as the per-fingerprint gap, on the other budget.
   */
  it('reports capacity as the project allowance, floored at zero', () => {
    expect(repairCapacity({ repairsLeft: 3 })).toBe(3);
    expect(repairCapacity({ repairsLeft: 0 })).toBe(0);
    expect(repairCapacity({ repairsLeft: -1 })).toBe(0);
  });

  it('takes the smaller of the two allowances as the cycle maximum', () => {
    // Three eligible defects and one unit left is a maximum of one, not three.
    expect(maxRepairTargets(constraints({ repairsLeft: 1 }))).toBe(1);

    // Five units left and three eligible defects is three, not five.
    expect(maxRepairTargets(constraints({ repairsLeft: 5 }))).toBe(3);

    // Per-defect exhaustion narrows it further.
    expect(
      maxRepairTargets(
        constraints({ repairsLeft: 5, repairsUsedByFingerprint: { 'fp:GATE-001': 2, 'fp:GATE-002': 2 } }),
      ),
    ).toBe(1);
  });

  it('authorises only as many targets as the allowance can pay for', () => {
    const c = constraints({ repairsLeft: 1 });
    const auth = authorizeAdjudication(
      decision({ defectIds: ['GATE-001', 'GATE-002', 'GATE-003'] }),
      legalAdjudicationActions(c),
      c,
    );

    expect(auth.source).toBe('sol');
    expect(auth.targetIds).toHaveLength(1);
    expect(auth.refusal).toContain('project repair allowance');
    expect(auth.refusal).toContain('GATE-002');
    expect(auth.refusal).toContain('GATE-003');
  });

  it('keeps the most severe of the named defects, then breaks ties by id', () => {
    // The harness has no judgement about which of Sol's targets matter most, so
    // it uses the one ordering it can defend and reproduce: severity first, and
    // among equal severities the id — not the order Sol happened to list them.
    const c = constraints({
      blockingDefects: [defect('b-second', 'P1'), defect('a-worst', 'P0'), defect('c-third', 'P1')],
      repairsLeft: 2,
    });
    const auth = authorizeAdjudication(
      decision({ defectIds: ['c-third', 'b-second', 'a-worst'] }),
      legalAdjudicationActions(c),
      c,
    );

    expect(auth.targetIds).toEqual(['a-worst', 'b-second']);
  });

  it('is stable regardless of the order Sol listed them in', () => {
    const c = constraints({
      blockingDefects: [defect('LOW', 'P1'), defect('HIGH', 'P0')],
      repairsLeft: 1,
    });
    const forwards = authorizeAdjudication(
      decision({ defectIds: ['LOW', 'HIGH'] }),
      legalAdjudicationActions(c),
      c,
    );
    const backwards = authorizeAdjudication(
      decision({ defectIds: ['HIGH', 'LOW'] }),
      legalAdjudicationActions(c),
      c,
    );

    expect(forwards.targetIds).toEqual(['HIGH']);
    expect(backwards.targetIds).toEqual(['HIGH']);
  });

  it('never authorises more targets than the allowance, for any combination', () => {
    // The property the cases above are instances of.
    const ids = ['GATE-001', 'GATE-002', 'GATE-003'];
    for (const repairsLeft of [0, 1, 2, 3, 4]) {
      const c = constraints({ repairsLeft });
      const auth = authorizeAdjudication(
        decision({ defectIds: ids }),
        legalAdjudicationActions(c),
        c,
      );
      expect(auth.targetIds.length, `repairsLeft=${repairsLeft}`).toBeLessThanOrEqual(repairsLeft);
    }
  });

  it('does not narrow a repair the allowance can already cover', () => {
    const c = constraints({ repairsLeft: 5 });
    const auth = authorizeAdjudication(
      decision({ defectIds: ['GATE-001', 'GATE-002', 'GATE-003'] }),
      legalAdjudicationActions(c),
      c,
    );

    expect(auth.targetIds).toHaveLength(3);
    expect(auth.refusal).toBeNull();
  });
});

describe('the eligibility facts Sol is given', () => {
  it('reports attempts remaining per open blocking defect', () => {
    const facts = repairEligibility(
      constraints({ repairsUsedByFingerprint: { 'fp:GATE-001': 1, 'fp:GATE-002': 2 } }),
    );

    expect(facts).toEqual([
      { defectId: 'GATE-001', attemptsRemaining: 1, eligible: true },
      { defectId: 'GATE-002', attemptsRemaining: 0, eligible: false },
      { defectId: 'GATE-003', attemptsRemaining: 2, eligible: true },
    ]);
  });

  it('never reports a negative remainder', () => {
    // A limit lowered mid-project must read as "exhausted", not as a negative.
    const facts = repairEligibility(
      constraints({ repairsPerDefect: 1, repairsUsedByFingerprint: { 'fp:GATE-001': 3 } }),
    );
    expect(facts[0]).toEqual({ defectId: 'GATE-001', attemptsRemaining: 0, eligible: false });
  });

  it('agrees with what the harness will actually authorise', () => {
    // The point of showing Sol these facts is that acting on them succeeds. If
    // the two ever disagreed, Sol would be reasoning from a fiction.
    const c = constraints({ repairsUsedByFingerprint: { 'fp:GATE-002': 2 } });
    const eligibleIds = repairEligibility(c).filter((e) => e.eligible).map((e) => e.defectId);

    const auth = authorizeAdjudication(
      decision({ defectIds: eligibleIds }),
      legalAdjudicationActions(c),
      c,
    );

    expect(auth.source).toBe('sol');
    expect(auth.targetIds).toEqual(eligibleIds);
    expect(auth.refusal).toBeNull();
    expect(eligibleIds).toHaveLength(maxRepairTargets(c));
  });
});
