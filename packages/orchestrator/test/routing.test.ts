/**
 * Authorising Sol's routing decision.
 *
 * Sol chooses the execution strategy; the harness decides whether the choice is
 * permitted. These tests pin the boundary between those two, because it is the
 * first place in the system where a model output changes what actually runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SolRouteDecision, type SitePlan } from '@statxai/contracts';
import {
  authorizeRoute,
  developerOverride,
  permittedStrategies,
} from '../src/routing.js';

const planWith = (routes: string[]): SitePlan =>
  ({
    sitemap: {
      pages: routes.map((route) => ({
        route,
        title: route,
        sections: [{ id: 's', heading: 'h', purpose: 'p', layout: 'split-hero', contentBindings: [] }],
      })),
    },
  }) as unknown as SitePlan;

const decision = (over: Record<string, unknown> = {}) =>
  SolRouteDecision.parse({
    action: 'one_shot',
    reason: 'Five ordinary pages fit one response.',
    confidence: 0.82,
    workstreams: null,
    ...over,
  });

const FIVE = planWith(['/', '/services', '/about', '/contact', '/faq']);

describe('what the harness will permit', () => {
  it('offers both strategies for a multi-page plan', () => {
    expect(permittedStrategies(FIVE).sort()).toEqual(['decompose', 'one_shot']);
  });

  it('refuses decomposition for a single-page plan', () => {
    // Decomposition builds an anchor and then the *remaining* pages. With one
    // route there is nothing left, so the second phase would be empty.
    expect(permittedStrategies(planWith(['/']))).toEqual(['one_shot']);
  });
});

describe('authorising Sol', () => {
  it('follows a permitted choice and records it as Sol’s', () => {
    const auth = authorizeRoute(decision(), FIVE);
    expect(auth).toEqual({ strategy: 'one_shot', source: 'sol', refusal: null });
  });

  it('follows a permitted decomposition', () => {
    const auth = authorizeRoute(
      decision({
        action: 'decompose',
        workstreams: [{ route: '/services', reason: 'eight offerings' }],
      }),
      FIVE,
    );
    expect(auth.strategy).toBe('decompose');
    expect(auth.source).toBe('sol');
  });

  it('falls back when Sol chooses something not on offer', () => {
    const auth = authorizeRoute(
      decision({ action: 'decompose', workstreams: [{ route: '/', reason: 'x' }] }),
      planWith(['/']),
    );
    expect(auth.strategy).toBe('one_shot');
    expect(auth.source).toBe('fallback');
    expect(auth.refusal).toContain('not permitted');
  });

  it('falls back when the workstreams name routes the sitemap does not have', () => {
    // Scheduling work for a page that does not exist would produce builds with
    // no specification behind them.
    const auth = authorizeRoute(
      decision({
        action: 'decompose',
        workstreams: [{ route: '/pricing', reason: 'invented' }],
      }),
      FIVE,
    );
    expect(auth.strategy).toBe('one_shot');
    expect(auth.refusal).toContain('/pricing');
  });

  it('never fails the run over a strategy', () => {
    // Routing is a preference between two working paths, so every refusal
    // resolves to the documented default rather than ending a delivery.
    for (const bad of [
      decision({ action: 'decompose', workstreams: [{ route: '/nope', reason: 'x' }] }),
      decision({ action: 'decompose', workstreams: [{ route: '/also-nope', reason: 'x' }] }),
    ]) {
      expect(authorizeRoute(bad, FIVE).strategy).toBe('one_shot');
    }
  });
});

describe('the developer override', () => {
  const saved = process.env.BUILD_STRATEGY;
  beforeEach(() => delete process.env.BUILD_STRATEGY);
  afterEach(() => {
    if (saved === undefined) delete process.env.BUILD_STRATEGY;
    else process.env.BUILD_STRATEGY = saved;
  });

  it('is absent by default, so Sol decides', () => {
    expect(developerOverride()).toBeNull();
  });

  it('reads both spellings of one-shot', () => {
    expect(developerOverride('one-shot')).toBe('one_shot');
    expect(developerOverride('one_shot')).toBe('one_shot');
    expect(developerOverride('decompose')).toBe('decompose');
  });

  it('ignores a value it does not recognise rather than guessing', () => {
    // "auto" always meant "no override". An unrecognised value must not be
    // silently reinterpreted as a strategy.
    expect(developerOverride('auto')).toBeNull();
    expect(developerOverride('fastest')).toBeNull();
    expect(developerOverride('')).toBeNull();
  });

  it('overrides Sol and says so, rather than substituting silently', () => {
    // The checklist allows an explicit developer override and forbids an
    // environment variable quietly standing in for the model's decision.
    const auth = authorizeRoute(decision({ action: 'one_shot' }), FIVE, 'decompose');
    expect(auth.strategy).toBe('decompose');
    expect(auth.source).toBe('developer-override');
    expect(auth.refusal).toContain("overrode Sol's choice");
  });

  it('records no refusal when the override agrees with Sol', () => {
    const auth = authorizeRoute(decision({ action: 'one_shot' }), FIVE, 'one_shot');
    expect(auth.source).toBe('developer-override');
    expect(auth.refusal).toBeNull();
  });
});
