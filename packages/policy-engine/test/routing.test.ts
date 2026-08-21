/**
 * Authorising Sol's routing decision.
 *
 * Sol chooses the execution strategy; the harness decides whether the choice is
 * permitted. These tests pin the boundary between those two, because it is the
 * first place in the system where a model output changes what actually runs.
 */
import { describe, expect, it } from 'vitest';
import { SolRouteDecision, type SitePlan } from '@statxai/contracts';
import { authorizeRoute, permittedStrategies, workstreamFaults } from '../src/routing.js';

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

/** What `executeDecomposed` builds after the anchor: every route but the home one. */
const REST = ['/services', '/about', '/contact', '/faq'];
const workstreams = (routes: string[]) => routes.map((route) => ({ route, reason: 'r' }));

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
    // The whole set the anchor does not build, each named once.
    const auth = authorizeRoute(
      decision({
        action: 'decompose',
        workstreams: REST.map((route) => ({ route, reason: 'content-heavy' })),
      }),
      FIVE,
    );
    expect(auth.strategy).toBe('decompose');
    expect(auth.source).toBe('sol');
    expect(auth.refusal).toBeNull();
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

describe('an explicit developer override', () => {
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

describe('the workstream set a decomposition must describe', () => {
  /**
   * `executeDecomposed` builds the anchor — layout plus the homepage — and then
   * every remaining sitemap page. So there is exactly one correct workstream
   * set, and only unknown routes used to be checked against it.
   *
   * None of the shapes below broke a build, because execution reads the sitemap
   * and ignores the workstreams entirely. What they broke was the record: the
   * `route-decision` artifact kept a plan the delivery did not follow.
   */
  const refusalFor = (routes: string[]) =>
    authorizeRoute(decision({ action: 'decompose', workstreams: workstreams(routes) }), FIVE);

  it('accepts the sitemap minus the homepage, exactly once each', () => {
    expect(refusalFor(REST).strategy).toBe('decompose');
  });

  it('accepts it in any order', () => {
    // The set is what matters; execution does not follow the listed sequence.
    expect(refusalFor([...REST].reverse()).strategy).toBe('decompose');
  });

  it('refuses a route the sitemap does not have', () => {
    const auth = refusalFor([...REST, '/pricing']);
    expect(auth.strategy).toBe('one_shot');
    expect(auth.refusal).toContain('absent from the sitemap');
    expect(auth.refusal).toContain('/pricing');
  });

  it('refuses a set that includes the homepage', () => {
    // The anchor already builds it, so a workstream for `/` describes work that
    // would happen twice or not at all.
    const auth = refusalFor(['/', ...REST]);
    expect(auth.strategy).toBe('one_shot');
    expect(auth.refusal).toContain('anchor');
  });

  it('refuses a duplicated route', () => {
    const auth = refusalFor([...REST, '/services']);
    expect(auth.strategy).toBe('one_shot');
    expect(auth.refusal).toContain('more than once');
    expect(auth.refusal).toContain('/services');
  });

  it('refuses a set that omits a route the decomposition would build', () => {
    const auth = refusalFor(['/services', '/about']);
    expect(auth.strategy).toBe('one_shot');
    expect(auth.refusal).toContain('did not name');
    expect(auth.refusal).toContain('/contact');
    expect(auth.refusal).toContain('/faq');
  });

  it('refuses a decomposition naming only the homepage', () => {
    // The case the doc comment always claimed and the code never checked.
    const auth = refusalFor(['/']);
    expect(auth.strategy).toBe('one_shot');
    expect(auth.source).toBe('fallback');
  });

  it('reports every fault, not just the first', () => {
    // An operator reading the refusal should not have to fix one shape, re-run,
    // and discover the next.
    const faults = workstreamFaults(workstreams(['/', '/services', '/services', '/pricing']), FIVE);
    expect(faults).toHaveLength(4);
  });

  it('accepts a two-page site whose only workstream is its one other page', () => {
    const two = planWith(['/', '/contact']);
    const auth = authorizeRoute(
      decision({ action: 'decompose', workstreams: workstreams(['/contact']) }),
      two,
    );
    expect(auth.strategy).toBe('decompose');
  });
});
