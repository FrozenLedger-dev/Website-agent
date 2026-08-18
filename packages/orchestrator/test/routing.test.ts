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
  executeRoute,
  isTruncationFailure,
  permittedStrategies,
  type RoutingAuthorization,
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

describe('executing the accepted route', () => {
  const truncation = () => {
    const error = new Error('Model output was truncated at the ceiling');
    error.name = 'MalformedModelOutput';
    return error;
  };

  /** Records which execution path actually ran. */
  const spy = (over: { oneShot?: () => Promise<void> } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      executors: {
        oneShot: over.oneShot
          ? async () => {
              calls.push('one-shot');
              await over.oneShot!();
            }
          : async () => void calls.push('one-shot'),
        decomposed: async () => void calls.push('decomposed'),
        onRecovery: async () => void calls.push('recovery'),
      },
    };
  };

  const authorized = (over: Partial<RoutingAuthorization> = {}): RoutingAuthorization => ({
    strategy: 'one_shot',
    source: 'sol',
    refusal: null,
    ...over,
  });

  it('runs one-shot directly when Sol chose one-shot', () => {
    const { calls, executors } = spy();
    return executeRoute(authorized(), FIVE, executors).then(() => {
      expect(calls).toEqual(['one-shot']);
    });
  });

  it('runs decomposition directly when Sol chose decompose', async () => {
    // The point of the change: decomposition is invoked, not reached by
    // throwing a fabricated truncation for the recovery handler to catch.
    const { calls, executors } = spy();
    await executeRoute(authorized({ strategy: 'decompose' }), FIVE, executors);

    expect(calls).toEqual(['decomposed']);
    expect(calls).not.toContain('one-shot');
    expect(calls).not.toContain('recovery');
  });

  it('runs decomposition directly under a developer override', async () => {
    const { calls, executors } = spy();
    await executeRoute(
      authorized({ strategy: 'decompose', source: 'developer-override' }),
      FIVE,
      executors,
    );
    expect(calls).toEqual(['decomposed']);
  });

  it('recovers from a real truncation, and reports it as recovery', async () => {
    // §3's escalation survives, but only for a truncation that genuinely
    // happened, and it is recorded separately from a routing decision.
    const { calls, executors } = spy({ oneShot: () => Promise.reject(truncation()) });
    await executeRoute(authorized(), FIVE, executors);

    expect(calls).toEqual(['one-shot', 'recovery', 'decomposed']);
  });

  it('propagates a failure that is not a truncation', async () => {
    const { calls, executors } = spy({ oneShot: () => Promise.reject(new Error('provider 500')) });

    await expect(executeRoute(authorized(), FIVE, executors)).rejects.toThrow('provider 500');
    expect(calls).toEqual(['one-shot']);
  });

  it('does not recover when an operator forced one-shot', async () => {
    // The override asked for that path specifically; silently switching to the
    // strategy it overrode away from would make the override a lie.
    const { calls, executors } = spy({ oneShot: () => Promise.reject(truncation()) });
    const route = authorized({ source: 'developer-override' });

    await expect(executeRoute(route, FIVE, executors)).rejects.toThrow(/truncated/);
    expect(calls).toEqual(['one-shot']);
  });

  it('does not recover when the plan cannot be decomposed', async () => {
    const { calls, executors } = spy({ oneShot: () => Promise.reject(truncation()) });

    await expect(executeRoute(authorized(), planWith(['/']), executors)).rejects.toThrow(/truncated/);
    expect(calls).toEqual(['one-shot']);
  });
});

describe('recognising a real truncation', () => {
  it('accepts the builder’s truncation failure', () => {
    const error = new Error('Model output was truncated');
    error.name = 'MalformedModelOutput';
    expect(isTruncationFailure(error)).toBe(true);
  });

  it('rejects other malformed output, which is not a ceiling problem', () => {
    const error = new Error('Model output did not satisfy its contract');
    error.name = 'MalformedModelOutput';
    expect(isTruncationFailure(error)).toBe(false);
  });

  it('rejects unrelated failures and non-errors', () => {
    expect(isTruncationFailure(new Error('truncated'))).toBe(false);
    expect(isTruncationFailure('truncated')).toBe(false);
    expect(isTruncationFailure(null)).toBe(false);
  });
});

describe('no synthetic truncation remains in the routing path', () => {
  it('never constructs MalformedModelOutput to steer control flow', async () => {
    // Decomposition was entered by throwing
    // `MalformedModelOutput('forced: output truncated')`, which made a chosen
    // strategy and a runtime failure the same code path.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    for (const file of ['orchestrator.ts', 'routing.ts']) {
      // Comments are stripped first: both files document the old hack, and
      // prose describing it must not read as the hack still being there.
      const code = (await readFile(join(src, file), 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      expect(code.match(/new MalformedModelOutput\(/g) ?? [], file).toEqual([]);
      expect(code.includes('forced: output truncated'), file).toBe(false);
    }
  });
});
