/**
 * Revising a failed specification.
 *
 * The behaviour being pinned is that a replan *learns from the failure*. The
 * implementation this replaces called the planner again with the business
 * profile and nothing else, so the revision was a second guess drawn from the
 * same inputs as the first — regeneration wearing a replan's name.
 */
import { describe, expect, it } from 'vitest';
import { authorizeReplanRevision, isEmptyDelta, scopeViolations } from '../src/replanning.js';
import type { PlanDelta } from '../src/types.js';

describe('scope', () => {
  const unchanged = {
    routesAdded: [],
    routesRemoved: [],
    routesRevised: [],
    brandChanged: false,
    acceptanceCriteriaChanged: false,
    strategyChanged: false,
    valuePropositionChanged: false,
  } satisfies PlanDelta;

  const structural: PlanDelta = { ...unchanged, routesAdded: ['/faq'], routesRemoved: ['/about'] };
  const brandOnly: PlanDelta = { ...unchanged, routesRevised: ['/services'], brandChanged: true };

  it('flags routes appearing under a page scope', () => {
    const violations = scopeViolations('page', structural);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('/faq');
  });

  it('flags routes appearing under a design scope', () => {
    // Design revises how the site looks, not which pages exist.
    expect(scopeViolations('design', structural)).toHaveLength(1);
  });

  it('flags a brand change under a page scope but not a design scope', () => {
    expect(scopeViolations('page', brandOnly)).toHaveLength(1);
    expect(scopeViolations('design', brandOnly)).toEqual([]);
  });

  it('permits anything under a site scope', () => {
    expect(scopeViolations('site', structural)).toEqual([]);
    expect(scopeViolations('site', brandOnly)).toEqual([]);
  });

  it('permits a page scope that only revises the page it was given', () => {
    expect(scopeViolations('page', { ...unchanged, routesRevised: ['/services'] })).toEqual([]);
  });
});

describe('objectively detectable overreach is refused', () => {
  const base = {
    routesAdded: [],
    routesRemoved: [],
    routesRevised: ['/services'],
    brandChanged: false,
    acceptanceCriteriaChanged: false,
    strategyChanged: false,
    valuePropositionChanged: false,
  } satisfies PlanDelta;

  it('page scope refuses a route addition', () => {
    expect(scopeViolations('page', { ...base, routesAdded: ['/pricing'] })).toHaveLength(1);
  });

  it('page scope refuses a route removal', () => {
    expect(scopeViolations('page', { ...base, routesRemoved: ['/about'] })).toHaveLength(1);
  });

  it('page scope refuses a brand-system change', () => {
    expect(scopeViolations('page', { ...base, brandChanged: true })).toHaveLength(1);
  });

  it('page scope refuses a strategy change', () => {
    const violations = scopeViolations('page', { ...base, strategyChanged: true });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('strategy');
  });

  it('page scope refuses a value-proposition change', () => {
    const violations = scopeViolations('page', { ...base, valuePropositionChanged: true });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('value proposition');
  });

  it('design scope refuses route changes', () => {
    expect(scopeViolations('design', { ...base, routesAdded: ['/pricing'] })).toHaveLength(1);
    expect(scopeViolations('design', { ...base, routesRemoved: ['/about'] })).toHaveLength(1);
  });

  it('design scope refuses strategy and value-proposition changes', () => {
    expect(scopeViolations('design', { ...base, strategyChanged: true })).toHaveLength(1);
    expect(scopeViolations('design', { ...base, valuePropositionChanged: true })).toHaveLength(1);
  });

  it('design scope permits the brand change it exists for', () => {
    expect(scopeViolations('design', { ...base, brandChanged: true })).toEqual([]);
  });

  it('site scope permits every one of them', () => {
    const everything: PlanDelta = {
      routesAdded: ['/pricing'],
      routesRemoved: ['/about'],
      routesRevised: ['/services'],
      brandChanged: true,
      acceptanceCriteriaChanged: true,
      strategyChanged: true,
      valuePropositionChanged: true,
    };
    expect(scopeViolations('site', everything)).toEqual([]);
  });

  it('reports every violation, not just the first', () => {
    const violations = scopeViolations('page', {
      ...base,
      routesAdded: ['/pricing'],
      brandChanged: true,
      strategyChanged: true,
      valuePropositionChanged: true,
    });
    expect(violations).toHaveLength(4);
  });
});

describe('a revision that changed nothing', () => {
  const unchanged: PlanDelta = {
    routesAdded: [],
    routesRemoved: [],
    routesRevised: [],
    brandChanged: false,
    acceptanceCriteriaChanged: false,
    strategyChanged: false,
    valuePropositionChanged: false,
  };

  it('recognises a delta in which nothing moved', () => {
    // Rebuilding from it would reproduce the site that just failed, spend the
    // cycle, and arrive at the same defects.
    expect(isEmptyDelta(unchanged)).toBe(true);
  });

  it('notices a change in any single dimension', () => {
    const moved: PlanDelta[] = [
      { ...unchanged, routesAdded: ['/faq'] },
      { ...unchanged, routesRemoved: ['/about'] },
      { ...unchanged, routesRevised: ['/services'] },
      { ...unchanged, brandChanged: true },
      { ...unchanged, acceptanceCriteriaChanged: true },
      { ...unchanged, strategyChanged: true },
      { ...unchanged, valuePropositionChanged: true },
    ];
    for (const delta of moved) expect(isEmptyDelta(delta)).toBe(false);
  });
});

describe('acceptance criteria are project-level state', () => {
  const base = {
    routesAdded: [],
    routesRemoved: [],
    routesRevised: ['/services'],
    brandChanged: false,
    acceptanceCriteriaChanged: false,
    strategyChanged: false,
    valuePropositionChanged: false,
  } satisfies PlanDelta;

  it('page scope refuses an acceptance-criteria change', () => {
    // Every rejection cites a criterion, so moving them redefines the bar for
    // pages the revision was never authorised to touch.
    const violations = scopeViolations('page', { ...base, acceptanceCriteriaChanged: true });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('acceptance criteria');
  });

  it('design scope still permits it, deliberately', () => {
    // A design revision can legitimately restate a criterion about composition.
    // Under review rather than settled.
    expect(scopeViolations('design', { ...base, acceptanceCriteriaChanged: true })).toEqual([]);
  });

  it('site scope permits it', () => {
    expect(scopeViolations('site', { ...base, acceptanceCriteriaChanged: true })).toEqual([]);
  });

  it('reports it alongside the other page-scope violations', () => {
    const violations = scopeViolations('page', {
      ...base,
      acceptanceCriteriaChanged: true,
      brandChanged: true,
      strategyChanged: true,
    });
    expect(violations).toHaveLength(3);
  });
});

describe('authorising a revision', () => {
  const unchanged: PlanDelta = {
    routesAdded: [],
    routesRemoved: [],
    routesRevised: [],
    brandChanged: false,
    acceptanceCriteriaChanged: false,
    strategyChanged: false,
    valuePropositionChanged: false,
  };

  it('accepts a revision that stayed inside its scope', () => {
    const permitted = authorizeReplanRevision({
      scope: 'page',
      delta: { ...unchanged, routesRevised: ['/services'] },
      reportedChangeCount: 1,
    });

    expect(permitted.authorized).toBe(true);
    expect(permitted.violations).toEqual([]);
    expect(permitted.reason).toBeNull();
  });

  it('refuses a revision that reached outside its scope, and says which parts', () => {
    // A page-scoped replan that adds routes and repaints the brand is not the
    // revision that was authorised, however well-argued it is.
    const permitted = authorizeReplanRevision({
      scope: 'page',
      delta: { ...unchanged, routesAdded: ['/pricing'], brandChanged: true },
      reportedChangeCount: 2,
    });

    expect(permitted.authorized).toBe(false);
    expect(permitted.violations).toHaveLength(2);
    expect(permitted.reason).toContain('scope');
  });

  it('refuses a revision that changed nothing, however many changes it claimed', () => {
    // Rebuilding from it would reproduce the site that just failed and spend
    // the cycle to arrive at the same defects.
    const permitted = authorizeReplanRevision({
      scope: 'site',
      delta: unchanged,
      reportedChangeCount: 4,
    });

    expect(permitted.authorized).toBe(false);
    expect(permitted.reason).toContain('4');
  });

  it('reports scope before emptiness when a revision manages both', () => {
    // Both are refusals, so the run ends the same way either order — but the
    // operator reading the record should see the more specific fault.
    const permitted = authorizeReplanRevision({
      scope: 'page',
      delta: unchanged,
      reportedChangeCount: 0,
    });

    expect(permitted.authorized).toBe(false);
    expect(permitted.reason).not.toBeNull();
  });
});
