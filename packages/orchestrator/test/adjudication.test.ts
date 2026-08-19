/**
 * Adjudicating a failed evaluation.
 *
 * The harness computes what is possible, Sol reasons about what is appropriate,
 * and the harness authorises. These tests pin the two halves of that boundary:
 * which actions get offered, and what happens to a decision that steps outside
 * the offer.
 */
import { describe, expect, it } from 'vitest';
import { SolAdjudicationDecision, toStrictModelSchema } from '@statxai/contracts';
import {
  authorizeAdjudication,
  fallbackAction,
  firstBlocker,
  legalAdjudicationActions,
  type AdjudicationConstraints,
} from '../src/adjudication.js';
import { fromGateFinding } from '../src/defects.js';

const constraints = (over: Partial<AdjudicationConstraints> = {}): AdjudicationConstraints => ({
  blockingCount: 3,
  repairsLeft: 5,
  replansLeft: 2,
  reviewRejectionsLeft: 3,
  previousRepairs: [],
  autonomyMode: 'full_autonomous',
  ...over,
});

const defect = (id: string, index: number) => ({
  ...fromGateFinding(
    { gate: 'claims', severity: 'P1', location: `p${index}.html`, message: 'm', acceptanceTest: 't' },
    index,
  ),
  id,
});

const OPEN = [defect('GATE-001', 0), defect('GATE-002', 1), defect('GATE-003', 2)];

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
    const auth = authorizeAdjudication(decision({ defectIds: ['GATE-001', 'GATE-003'] }), legal, OPEN);

    expect(auth.source).toBe('sol');
    expect(auth.action).toBe('repair');
    expect(auth.targets.map((d) => d.id)).toEqual(['GATE-001', 'GATE-003']);
    expect(auth.refusal).toBeNull();
  });

  it('follows a replan', () => {
    const auth = authorizeAdjudication(
      decision({ action: 'replan', defectIds: null, scope: 'site' }),
      legal,
      OPEN,
    );
    expect(auth).toMatchObject({ action: 'replan', source: 'sol', targets: [] });
  });

  it('follows a block', () => {
    const auth = authorizeAdjudication(decision({ action: 'block', defectIds: null }), legal, OPEN);
    expect(auth).toMatchObject({ action: 'block', source: 'sol' });
  });

  it('refuses an action the harness did not offer', () => {
    // Well-formed and still not permitted: replanning with no replan budget.
    const withoutReplan = legalAdjudicationActions(constraints({ replansLeft: 0 }));
    const auth = authorizeAdjudication(
      decision({ action: 'replan', defectIds: null, scope: 'site' }),
      withoutReplan,
      OPEN,
    );

    expect(auth.source).toBe('fallback');
    expect(auth.action).toBe('repair');
    expect(auth.refusal).toContain('did not offer');
  });

  it('refuses a repair naming defects nobody raised', () => {
    // Otherwise the budget is spent on a fingerprint that does not exist.
    const auth = authorizeAdjudication(decision({ defectIds: ['GATE-999'] }), legal, OPEN);

    expect(auth.source).toBe('fallback');
    expect(auth.refusal).toContain('named no open blocking defect');
  });

  it('honours the recognised part of a partly-unknown list, and records the rest', () => {
    const auth = authorizeAdjudication(
      decision({ defectIds: ['GATE-002', 'GATE-999'] }),
      legal,
      OPEN,
    );

    expect(auth.source).toBe('sol');
    expect(auth.targets.map((d) => d.id)).toEqual(['GATE-002']);
    expect(auth.refusal).toContain('GATE-999');
  });

  it('falls back to exactly one blocker, not the whole set', () => {
    // Repairing everything in a fallback is a broad semantic choice made by
    // nobody: it spends a repair job per defect on a batch no one reasoned
    // about, on a run whose adjudication has already failed.
    const auth = authorizeAdjudication(decision({ defectIds: ['GATE-999'] }), legal, OPEN);

    expect(auth.source).toBe('fallback');
    expect(auth.targets).toHaveLength(1);
  });

  it('lets a decision Sol actually made name several defects', () => {
    // The single-blocker rule constrains the fallback only.
    const auth = authorizeAdjudication(
      decision({ defectIds: ['GATE-001', 'GATE-002', 'GATE-003'] }),
      legal,
      OPEN,
    );
    expect(auth.source).toBe('sol');
    expect(auth.targets).toHaveLength(3);
  });
});

describe('the fallback when Sol cannot be consulted', () => {
  it('prefers the cheapest legal action', () => {
    // A run that already lost its adjudication should not also spend a replan
    // on a decision nobody made.
    expect(fallbackAction(['repair', 'replan', 'block'])).toBe('repair');
    expect(fallbackAction(['replan', 'block'])).toBe('replan');
    expect(fallbackAction(['block'])).toBe('block');
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
    const auth = authorizeAdjudication(decision(), legalAdjudicationActions(constraints()), OPEN);
    expect(Object.keys(auth).sort()).toEqual(['action', 'refusal', 'source', 'targets']);
  });
});

describe('choosing the one defect a fallback repairs', () => {
  const at = (id: string, severity: 'P0' | 'P1', index: number) => ({
    ...fromGateFinding(
      { gate: 'claims', severity, location: `p${index}.html`, message: 'm', acceptanceTest: 't' },
      index,
    ),
    id,
  });

  it('takes the most severe blocker', () => {
    const picked = firstBlocker([at('B', 'P1', 0), at('A', 'P0', 1)]);
    expect(picked.map((d) => d.id)).toEqual(['A']);
  });

  it('breaks ties by id, so the choice does not depend on gate ordering', () => {
    const forwards = firstBlocker([at('GATE-003', 'P1', 0), at('GATE-001', 'P1', 1)]);
    const backwards = firstBlocker([at('GATE-001', 'P1', 1), at('GATE-003', 'P1', 0)]);

    expect(forwards.map((d) => d.id)).toEqual(['GATE-001']);
    expect(backwards.map((d) => d.id)).toEqual(['GATE-001']);
  });

  it('returns nothing when there is nothing blocking', () => {
    expect(firstBlocker([])).toEqual([]);
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
