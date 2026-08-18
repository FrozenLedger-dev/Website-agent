/**
 * Sol's decision contracts.
 *
 * Two properties are being pinned. First, a malformed or incoherent decision is
 * rejected before it can reach project state. Second — and this is the one that
 * matters architecturally — the contract gives Sol no way to *express* an
 * overreach, so the guarantee does not depend on a prompt asking nicely.
 */
import { describe, expect, it } from 'vitest';
import {
  SolAdjudicationDecision,
  SolApprovalRecommendation,
  SolRouteDecision,
  checkAdjudicationLegal,
  stripNulls,
  toStrictModelSchema,
  type AdjudicationAction,
} from '../src/index.js';

const adjudication = (over: Record<string, unknown> = {}) => ({
  action: 'repair',
  reason: 'Two P1 claims defects remain and both are narrow.',
  defectIds: ['GATE-001'],
  objective: null,
  scope: null,
  ...over,
});

describe('routing decisions', () => {
  it('accepts a one-shot decision', () => {
    const parsed = SolRouteDecision.safeParse({
      action: 'one_shot',
      reason: 'Five pages of ordinary structure; the whole site fits one call.',
      confidence: 0.8,
      workstreams: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects decomposition that names no workstreams', () => {
    // "Decompose" without saying into what is not a plan, and the harness would
    // have nothing to schedule.
    const parsed = SolRouteDecision.safeParse({
      action: 'decompose',
      reason: 'Eight services will not fit one response.',
      confidence: 0.9,
      workstreams: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a confidence outside 0..1', () => {
    const parsed = SolRouteDecision.safeParse({
      action: 'one_shot',
      reason: 'r',
      confidence: 7,
      workstreams: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('adjudication decisions', () => {
  it('accepts a well-formed repair', () => {
    expect(SolAdjudicationDecision.safeParse(adjudication()).success).toBe(true);
  });

  it('rejects a repair naming no defects', () => {
    expect(SolAdjudicationDecision.safeParse(adjudication({ defectIds: [] })).success).toBe(false);
  });

  it('rejects an escalation with no objective', () => {
    const parsed = SolAdjudicationDecision.safeParse(
      adjudication({ action: 'terra_specialist', defectIds: null, objective: null }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a replan with no scope', () => {
    const parsed = SolAdjudicationDecision.safeParse(
      adjudication({ action: 'replan', defectIds: null, scope: null }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects an action that does not exist', () => {
    // A model inventing a verb must not reach project state.
    const parsed = SolAdjudicationDecision.safeParse(adjudication({ action: 'deploy_now' }));
    expect(parsed.success).toBe(false);
  });
});

describe('legality is separate from well-formedness', () => {
  const legal: AdjudicationAction[] = ['repair', 'block'];

  it('admits an action the harness offered', () => {
    const decision = SolAdjudicationDecision.parse(adjudication());
    expect(checkAdjudicationLegal(decision, legal).ok).toBe(true);
  });

  it('refuses a valid action the harness did not offer', () => {
    // Replanning is a real action, but not when the replan budget is gone. A
    // decision can be perfectly well-formed and still not permitted.
    const decision = SolAdjudicationDecision.parse(
      adjudication({ action: 'replan', defectIds: null, scope: 'site' }),
    );
    const checked = checkAdjudicationLegal(decision, legal);

    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain('not legal');
  });

  it('refuses everything when nothing is legal', () => {
    const decision = SolAdjudicationDecision.parse(adjudication());
    expect(checkAdjudicationLegal(decision, []).ok).toBe(false);
  });
});

describe('approval is a recommendation, not an authorisation', () => {
  it('accepts a recommendation with acknowledged issues', () => {
    const parsed = SolApprovalRecommendation.safeParse({
      recommendation: 'accept',
      reason: 'Nothing blocking remains; two P2 metadata issues are cosmetic.',
      acknowledgedIssues: ['QA-004 duplicate title suffix'],
    });
    expect(parsed.success).toBe(true);
  });

  it('has no field that authorises, deploys or targets an environment', () => {
    // The split is structural: Sol can say "accept" and nothing more. Whether a
    // release happens is the harness's decision, recorded separately.
    const shape = Object.keys(SolApprovalRecommendation.shape);
    expect(shape.sort()).toEqual(['acknowledgedIssues', 'reason', 'recommendation']);
  });
});

describe('what Sol structurally cannot ask for', () => {
  const forbidden = /budget|permission|credential|secret|token|deploy|environment|override|approve_release/i;

  it('exposes no budget, permission, credential or deployment field', () => {
    // Prompts asking a model not to overreach are advisory. A schema with no
    // such field is not.
    for (const [name, schema] of [
      ['route', SolRouteDecision],
      ['adjudicate', SolAdjudicationDecision],
      ['approve', SolApprovalRecommendation],
    ] as const) {
      const json = toStrictModelSchema(schema) as { properties?: Record<string, unknown> };
      for (const key of Object.keys(json.properties ?? {})) {
        expect(forbidden.test(key), `${name}.${key}`).toBe(false);
      }
    }
  });

  it('presents an object root, which strict structured output requires', () => {
    // A discriminated union renders as a top-level anyOf and is rejected, so
    // these are flat objects refined after parse rather than unions.
    for (const schema of [SolRouteDecision, SolAdjudicationDecision, SolApprovalRecommendation]) {
      const json = toStrictModelSchema(schema) as { type?: string; additionalProperties?: boolean };
      expect(json.type).toBe('object');
      expect(json.additionalProperties).toBe(false);
    }
  });
});

describe('the round trip a live decision actually takes', () => {
  /**
   * Strict output requires every key present, so an inapplicable field comes
   * back as `null` — and `stripNulls` then deletes it before Zod sees anything.
   * The field therefore arrives as `undefined`, not `null`.
   *
   * Every routing decision on the first live run was rejected for exactly this,
   * while the unit tests above passed because they build the object with an
   * explicit `null`. These parse what the pipeline really hands over.
   */
  const throughPipeline = <T>(value: T): T => stripNulls(value);

  it('accepts a one-shot decision whose null workstreams were stripped', () => {
    const parsed = SolRouteDecision.safeParse(
      throughPipeline({
        action: 'one_shot',
        reason: 'Five ordinary pages fit one response.',
        confidence: 0.82,
        workstreams: null,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('still requires workstreams when decomposing, stripped or not', () => {
    const parsed = SolRouteDecision.safeParse(
      throughPipeline({
        action: 'decompose',
        reason: 'Eight content-heavy routes.',
        confidence: 0.7,
        workstreams: null,
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('accepts a stripped adjudication and still enforces its per-action fields', () => {
    const repair = SolAdjudicationDecision.safeParse(
      throughPipeline({
        action: 'repair',
        reason: 'Two narrow claims defects.',
        defectIds: ['GATE-001'],
        objective: null,
        scope: null,
      }),
    );
    expect(repair.success).toBe(true);

    // `scope` stripped to undefined must not read as "supplied".
    const replan = SolAdjudicationDecision.safeParse(
      throughPipeline({
        action: 'replan',
        reason: 'The plan is the defect.',
        defectIds: null,
        objective: null,
        scope: null,
      }),
    );
    expect(replan.success).toBe(false);
  });
});
