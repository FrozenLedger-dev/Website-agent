/**
 * Revising a failed specification.
 *
 * The behaviour being pinned is that a replan *learns from the failure*. The
 * implementation this replaces called the planner again with the business
 * profile and nothing else, so the revision was a second guess drawn from the
 * same inputs as the first — regeneration wearing a replan's name.
 */
import { describe, expect, it } from 'vitest';
import {
  SolReplanRequest,
  SolReplanResult,
  toStrictModelSchema,
  type SitePlan,
} from '@statxai/contracts';
import { isEmptyDelta, scopeViolations } from '@statxai/policy-engine';
import { planDelta } from '../src/replanning.js';

const page = (route: string, heading = 'H', layout = 'split-hero') => ({
  route,
  title: route,
  metaDescription: 'd',
  goal: 'g',
  primaryAction: 'a',
  sections: [{ id: 's', heading, purpose: 'p', layout, contentBindings: ['services'] }],
});

const plan = (routes: string[], over: Record<string, unknown> = {}): SitePlan =>
  ({
    strategy: 's',
    valueProposition: 'v',
    brandSystem: {
      palette: { background: '#fff', surface: '#fff', text: '#000', muted: '#888', accent: '#f00', accentText: '#fff', border: '#ccc' },
      typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
      artDirection: 'a',
      radius: 'square',
      rationale: 'r',
    },
    sitemap: { pages: routes.map((r) => page(r)) },
    acceptanceCriteria: ['a', 'b', 'c'],
    ...over,
  }) as unknown as SitePlan;

const FOUR = ['/', '/services', '/about', '/contact'];

describe('what actually changed', () => {
  it('reports an unchanged plan as unchanged', () => {
    const delta = planDelta(plan(FOUR), plan(FOUR));
    expect(delta).toEqual({
      routesAdded: [],
      routesRemoved: [],
      routesRevised: [],
      brandChanged: false,
      acceptanceCriteriaChanged: false,
      strategyChanged: false,
      valuePropositionChanged: false,
    });
  });

  it('reports routes added and removed', () => {
    const delta = planDelta(plan(FOUR), plan(['/', '/services', '/pricing']));
    expect(delta.routesAdded).toEqual(['/pricing']);
    expect(delta.routesRemoved).toEqual(['/about', '/contact']);
  });

  it('reports a route whose specification changed', () => {
    const revised = plan(FOUR);
    revised.sitemap.pages[1]!.sections[0]!.heading = 'Rewritten';

    const delta = planDelta(plan(FOUR), revised);
    expect(delta.routesRevised).toEqual(['/services']);
    expect(delta.routesAdded).toEqual([]);
  });

  it('reports a brand change independently of the routes', () => {
    const revised = plan(FOUR);
    revised.brandSystem.palette.accent = '#0f0';

    const delta = planDelta(plan(FOUR), revised);
    expect(delta.brandChanged).toBe(true);
    expect(delta.routesRevised).toEqual([]);
  });

  it('is computed, not taken from what Sol claimed', () => {
    // Sol reports its changes; this measures them. The artifact carries both so
    // a discrepancy is visible rather than trusted away.
    const revised = plan(['/', '/services', '/about', '/contact', '/faq']);
    expect(planDelta(plan(FOUR), revised).routesAdded).toEqual(['/faq']);
  });
});

describe('what the replan contract cannot touch', () => {
  const forbidden =
    /profile|business|budget|permission|credential|secret|token|deploy|environment|autonomy|override|gate/i;

  it('offers no field for the business profile, budgets, permissions or deployment', () => {
    // Sol reads the profile — it is supplied as canonical factual context, since
    // a revision that cannot see the facts cannot check its claims against them.
    // What it cannot do is send one back, so an unsupported "24/7 emergency
    // service" claim can only be answered by changing what the site says.
    const json = toStrictModelSchema(SolReplanResult) as { properties?: Record<string, unknown> };
    for (const key of Object.keys(json.properties ?? {})) {
      expect(forbidden.test(key), key).toBe(false);
    }
  });

  it('returns only a diagnosis, changes, preserved areas and a plan', () => {
    const json = toStrictModelSchema(SolReplanResult) as { properties?: Record<string, unknown> };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      'changes',
      'failureDiagnosis',
      'preservedAreas',
      'revisedPlan',
    ]);
  });

  it('carries budgets inward as read-only numbers with no way back', () => {
    // The request may show what remains so a nearly-spent run is judged
    // differently. The result has no budget field to answer with.
    expect(Object.keys(SolReplanRequest.shape)).toContain('remainingBudgets');
    const json = toStrictModelSchema(SolReplanResult) as { properties?: Record<string, unknown> };
    expect(Object.keys(json.properties ?? {})).not.toContain('remainingBudgets');
  });

  it('requires a diagnosis and at least one change', () => {
    const base = {
      failureDiagnosis: 'The services page cannot meet criterion 4 without a fact the profile lacks.',
      changes: [{ area: '/services', change: 'Drop the guarantee section', reason: 'GATE-002' }],
      preservedAreas: ['brand system'],
      revisedPlan: plan(FOUR),
    };
    expect(SolReplanResult.safeParse(base).success).toBe(true);
    expect(SolReplanResult.safeParse({ ...base, changes: [] }).success).toBe(false);
    expect(SolReplanResult.safeParse({ ...base, failureDiagnosis: '' }).success).toBe(false);
  });
});

describe('a revision that changed nothing', () => {
  // `isEmptyDelta` is policy and is tested there; what is pinned here is that
  // `planDelta` reports a real revision as one, and a rewritten copy as none.
  it('is detected however Sol described it', () => {
    // Rebuilding from it would reproduce the site that just failed, spend the
    // cycle, and arrive at the same defects.
    const identical = plan(FOUR);
    expect(isEmptyDelta(planDelta(identical, plan(FOUR)))).toBe(true);
  });

  it('is not confused with a real change', () => {
    const revised = plan(FOUR);
    revised.strategy = 'A different strategy';
    expect(isEmptyDelta(planDelta(plan(FOUR), revised))).toBe(false);

    const reworded = plan(FOUR);
    reworded.valueProposition = 'Something else';
    expect(isEmptyDelta(planDelta(plan(FOUR), reworded))).toBe(false);
  });

  it('notices a change in any single dimension', () => {
    const dimensions: ((p: SitePlan) => void)[] = [
      (p) => void (p.strategy = 'x'),
      (p) => void (p.valueProposition = 'x'),
      (p) => void (p.brandSystem.palette.accent = '#0f0'),
      (p) => void p.acceptanceCriteria.push('d'),
      (p) => void (p.sitemap.pages[0]!.title = 'x'),
    ];
    for (const mutate of dimensions) {
      const revised = plan(FOUR);
      mutate(revised);
      expect(isEmptyDelta(planDelta(plan(FOUR), revised))).toBe(false);
    }
  });
});

describe('the evidence a replan is given', () => {
  it('carries the previous plan as an object, not a summary', () => {
    // Sol is revising the plan and cannot revise what it has only been told
    // about. This is the field whose absence made the old path regeneration.
    const parsed = SolReplanRequest.safeParse({
      reviewCycle: 2,
      previousPlan: plan(FOUR),
      adjudicationReason: 'The claim recurs on three pages after two repairs.',
      scope: 'page',
      unresolvedDefects: [
        { id: 'GATE-002', category: 'claims', severity: 'P1', location: 'services.html', reason: 'unsupported guarantee' },
      ],
      gateFindings: ['P1 claims services.html — unsupported guarantee'],
      reviewSummary: 'reject, quality 68',
      repairHistory: [{ defectId: 'GATE-002', fingerprint: 'abc123', outcome: 'failed (1 file)' }],
      remainingBudgets: { totalRepairJobs: 1, replans: 1, reviewRejections: 1 },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.previousPlan.sitemap.pages).toHaveLength(4);
      expect(parsed.data.repairHistory[0]?.outcome).toContain('failed');
      expect(parsed.data.scope).toBe('page');
    }
  });

  it('rejects evidence missing the previous plan', () => {
    const parsed = SolReplanRequest.safeParse({
      reviewCycle: 1,
      adjudicationReason: 'r',
      scope: 'site',
      unresolvedDefects: [],
      gateFindings: [],
      reviewSummary: null,
      repairHistory: [],
      remainingBudgets: {},
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The case this phase exists for.
 *
 * A plan asks a page to make a claim the business profile cannot support. Luna
 * repairs it, the claim comes back, and adjudication concludes the plan is at
 * fault. What matters is that the revision is handed the failure — the previous
 * page spec, the surviving defect, the repair that did not work, and the reason
 * the replan was requested — instead of being asked to plan again from intake.
 */
describe('regression: a plan that requires an unsupported claim', () => {
  const PROFILE = {
    businessName: 'Halden Electrical',
    industry: 'Electrical contracting',
    location: 'Ashford, Kent',
    audience: 'Homeowners',
    services: [{ name: 'Emergency callout', description: 'Weekday faults, on site within two hours.' }],
    differentiators: ['NICEIC approved'],
    contact: { email: 'office@haldenelectrical.co.uk', phone: '01233 664 902' },
    tone: 'Practical',
    goals: ['Get emergency callouts phoned through'],
  };

  /** The plan that failed: a section whose whole purpose is a 24/7 promise. */
  const FAILED = plan(['/', '/emergency'], {}) as SitePlan;
  FAILED.sitemap.pages[1]!.sections[0] = {
    id: 'always-open',
    heading: 'Available 24/7, every day of the year',
    purpose: 'Establish round-the-clock availability as the reason to call.',
    layout: 'split-hero',
    contentBindings: ['services'],
  } as (typeof FAILED.sitemap.pages)[number]['sections'][number];

  const evidence = {
    reviewCycle: 3,
    previousPlan: FAILED,
    adjudicationReason:
      'The unsupported 24/7 claim on /emergency survived a repair because the page ' +
      'specification requires it: the section exists to assert round-the-clock cover.',
    scope: 'page' as const,
    unresolvedDefects: [
      {
        id: 'GATE-002',
        category: 'claims',
        severity: 'P1',
        location: 'emergency.html',
        reason:
          'States round-the-clock availability with nothing in the business profile to support it.',
      },
    ],
    gateFindings: ['P1 claims emergency.html — states 24/7 availability, unsupported'],
    reviewSummary: '  decision reject, quality 61, blocking=true',
    repairHistory: [
      { defectId: 'GATE-002', fingerprint: '579dbc22ae', outcome: 'failed (1 file(s))' },
    ],
    remainingBudgets: { totalRepairJobs: 1, replans: 1, reviewRejections: 1 },
  };

  it('hands the revision every piece of evidence that caused it', () => {
    const parsed = SolReplanRequest.safeParse(evidence);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const e = parsed.data;
    // The previous page spec — the thing being revised.
    expect(e.previousPlan.sitemap.pages[1]?.sections[0]?.heading).toContain('24/7');
    // The defect that survived.
    expect(e.unresolvedDefects[0]?.category).toBe('claims');
    // Evidence that narrow repair already failed on it, which is what makes
    // this a specification problem rather than a build problem.
    expect(e.repairHistory[0]).toMatchObject({ defectId: 'GATE-002', outcome: 'failed (1 file(s))' });
    // Why adjudication asked for a replan, verbatim.
    expect(e.adjudicationReason).toContain('specification requires it');
    expect(e.scope).toBe('page');
  });

  it('lets the revision answer by changing the plan, not the facts', () => {
    // The fix is to stop the site making the claim. Nothing in the result can
    // reach the profile, so "assume the business is open 24/7" is not
    // expressible — the guarantee is structural, not a prompt instruction.
    const revised = plan(['/', '/emergency']) as SitePlan;
    revised.sitemap.pages[1]!.sections[0] = {
      id: 'weekday-response',
      heading: 'On site within two hours on weekdays',
      purpose: 'State the response commitment the profile actually supports.',
      layout: 'split-hero',
      contentBindings: ['services'],
    } as (typeof revised.sitemap.pages)[number]['sections'][number];

    const result = SolReplanResult.safeParse({
      failureDiagnosis:
        'The /emergency page specification required a round-the-clock claim the profile does not support, so every repair reintroduced it.',
      changes: [
        {
          area: '/emergency',
          change: 'Replace the 24/7 availability section with the supported weekday two-hour response.',
          reason: 'GATE-002 survived a repair because the section existed to assert 24/7 cover.',
        },
      ],
      preservedAreas: ['brand system', '/ homepage strategy'],
      revisedPlan: revised,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The revision is scoped to the page it was asked about.
    const delta = planDelta(FAILED, result.data.revisedPlan);
    expect(delta.routesAdded).toEqual([]);
    expect(delta.routesRemoved).toEqual([]);
    expect(delta.routesRevised).toEqual(['/emergency']);
    expect(delta.brandChanged).toBe(false);
    expect(scopeViolations('page', delta)).toEqual([]);

    // The profile is unchanged. Sol was given it to read; the result carries no
    // field through which a revised one could return, so the harness's copy
    // remains authoritative.
    expect(PROFILE.services[0]?.description).toBe('Weekday faults, on site within two hours.');
  });

  it('flags a revision that used a page scope to rewrite the site', () => {
    const sprawling = plan(['/', '/emergency', '/about', '/pricing']) as SitePlan;
    sprawling.brandSystem.palette.accent = '#123456';

    const delta = planDelta(FAILED, sprawling);
    const violations = scopeViolations('page', delta);

    expect(violations).toHaveLength(2);
    expect(violations.join(' ')).toContain('/about');
    expect(violations.join(' ')).toContain('brand system');
  });
});

describe('a replan that cannot be produced', () => {
  it('leaves no path from an authorised replan back to the original planner', async () => {
    // The defect this phase removes was `plan = await producePlan(reviewCycle)`
    // on the replan path: a second guess from the same inputs as the first.
    // Falling back to it on a model failure would reinstate exactly that, so
    // the source is checked for any surviving call.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const code = strip(await readFile(join(src, 'orchestrator.ts'), 'utf8'));

    // Exactly one call survives in the delivery loop: the initial plan.
    expect(code.match(/producePlan\(/g) ?? []).toHaveLength(1);
    // Destructured since Phase 5j threaded `sitePlanRef` out of `producePlan`
    // alongside the plan itself.
    expect(code).toContain(
      'const { plan: initialPlan, sitePlanRef: initialSitePlanRef } = await producePlan({ deps, facts }, 0)',
    );

    // And the replan branch reaches revisePlan, not the planner.
    const replanBranch = code.slice(code.indexOf("adjudication.action === 'replan'"));
    expect(replanBranch).toContain('revisePlan(');
    expect(replanBranch.slice(0, replanBranch.indexOf('continue;'))).not.toContain('producePlan(');
  });

  it('stops rather than inventing a revision in the harness', async () => {
    // `revisePlan` returns null on a model failure and the caller breaks with a
    // terminal decision. The harness must not reason semantically in the
    // reasoning model's absence, and the replan budget is already spent.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(join(src, 'orchestrator.ts'), 'utf8');

    expect(code).toContain('if (!revised) {');
    expect(code).toContain('Replan could not be produced');
  });
});

/**
 * Scope is enforced, not merely observed.
 *
 * A revision that exceeds the scope adjudication authorised is not a narrow
 * change that went slightly wide — it is a different decision from the one that
 * was approved, and executing it would let the requested scope mean nothing.
 */
describe('what a refused revision leaves behind', () => {
  it('activates the plan only after both checks pass', async () => {
    // `persistPlan` makes a revision the accepted plan and `clearSite` discards
    // the build. Both must sit behind the rejection, or a refused revision
    // would still take effect.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(join(src, 'phases/planning.ts'), 'utf8');
    const loop = await readFile(join(src, 'orchestrator.ts'), 'utf8');

    // `revisePlan` is the last export in the module, so its body runs to the end.
    const body = code.slice(code.indexOf('export async function revisePlan'));

    // The refusal returns before the plan is persisted.
    expect(body.indexOf('if (record.rejected)')).toBeLessThan(body.indexOf('await persistPlan'));

    // And the refusal comes from the policy engine, not from a second copy of
    // the rules living here. What it decides is pinned in that package.
    expect(body).toContain('authorizeReplanRevision({');
    expect(body.indexOf('authorizeReplanRevision({')).toBeLessThan(
      body.indexOf('if (record.rejected)'),
    );

    // And the caller clears the site only after a non-null revision.
    const caller = loop.slice(loop.indexOf('const revised = await revisePlan'));
    expect(caller.indexOf('if (!revised)')).toBeLessThan(caller.indexOf('clearSite()'));
  });

  it('persists the decision even when the revision is refused', async () => {
    // A refused revision is part of the history: the artifact records the
    // violation and the reason, and only the activation is withheld.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(join(src, 'phases/planning.ts'), 'utf8');
    const revise = code.slice(code.indexOf('export async function revisePlan'));

    expect(revise.indexOf('record.rejected =')).toBeLessThan(
      revise.indexOf("registry.put(facts.projectId, 'replan-decision'"),
    );
  });

  it('does not call Sol again after refusing', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = (await readFile(join(src, 'phases/planning.ts'), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    // One call site in the whole module, inside revisePlan's own body: a
    // refusal returns, it does not ask Sol for a different answer.
    expect(code.match(/replanSite\(/g) ?? []).toHaveLength(1);

    const revise = code.slice(code.indexOf('export async function revisePlan'));
    expect(revise.match(/replanSite\(/g) ?? []).toHaveLength(1);
    expect(revise).toContain('return null;');
  });
});

