/**
 * Costing a delivery.
 *
 * The failure that matters is not "no number" — it is a *plausible* number that
 * is wrong. Rates are configuration, tiers are priced independently, and a
 * half-configured tier must be reported as unpriced rather than counted at
 * whatever half it has.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costOf, rateFor, type UsageByTier } from '../src/pricing.js';

const KEYS = [
  'PRICE_SOL_INPUT',
  'PRICE_SOL_OUTPUT',
  'PRICE_TERRA_INPUT',
  'PRICE_TERRA_OUTPUT',
  'PRICE_LUNA_INPUT',
  'PRICE_LUNA_OUTPUT',
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const usage = (over: UsageByTier = {}): UsageByTier => ({
  sol: { inputTokens: 12_000, outputTokens: 6_000, calls: 1, ms: 50_000 },
  terra: { inputTokens: 80_000, outputTokens: 14_000, calls: 2, ms: 100_000 },
  ...over,
});

describe('rateFor', () => {
  it('is null when a tier has not been priced', () => {
    // Tiers map to models through configuration, so the platform genuinely
    // cannot know what one costs. Inventing a default would put a confident,
    // wrong figure on an invoice-shaped screen.
    expect(rateFor('sol')).toBeNull();
  });

  it('requires both halves of the rate', () => {
    // Output is the expensive half. Pricing input alone would understate every
    // run while still looking like a real total.
    process.env.PRICE_SOL_INPUT = '1.25';
    expect(rateFor('sol')).toBeNull();

    process.env.PRICE_SOL_OUTPUT = '10';
    expect(rateFor('sol')).toEqual({ input: 1.25, output: 10 });
  });

  it('rejects a negative or non-numeric rate', () => {
    process.env.PRICE_SOL_INPUT = '-1';
    process.env.PRICE_SOL_OUTPUT = '10';
    expect(rateFor('sol')).toBeNull();

    process.env.PRICE_SOL_INPUT = 'free';
    expect(rateFor('sol')).toBeNull();
  });

  it('accepts a genuine zero', () => {
    process.env.PRICE_SOL_INPUT = '0';
    process.env.PRICE_SOL_OUTPUT = '0';
    expect(rateFor('sol')).toEqual({ input: 0, output: 0 });
  });
});

describe('costOf', () => {
  it('reports no total when nothing is priced', () => {
    const cost = costOf(usage());
    expect(cost.total).toBeNull();
    expect(cost.unpriced.sort()).toEqual(['sol', 'terra']);
  });

  it('prices each tier at its own rate', () => {
    process.env.PRICE_SOL_INPUT = '1.25';
    process.env.PRICE_SOL_OUTPUT = '10';
    process.env.PRICE_TERRA_INPUT = '3';
    process.env.PRICE_TERRA_OUTPUT = '15';

    const cost = costOf(usage());

    // sol: 12k/1M × 1.25 + 6k/1M × 10 = 0.015 + 0.06
    expect(cost.byTier.sol).toBeCloseTo(0.075, 6);
    // terra: 80k/1M × 3 + 14k/1M × 15 = 0.24 + 0.21
    expect(cost.byTier.terra).toBeCloseTo(0.45, 6);
    expect(cost.total).toBeCloseTo(0.525, 6);
    expect(cost.unpriced).toEqual([]);
  });

  it('names the tiers it could not price rather than counting them as free', () => {
    // A partial configuration must not silently understate the total: the
    // number shown has to be attributable to the tiers it actually covers.
    process.env.PRICE_SOL_INPUT = '1.25';
    process.env.PRICE_SOL_OUTPUT = '10';

    const cost = costOf(usage());
    expect(cost.total).toBeCloseTo(0.075, 6);
    expect(cost.unpriced).toEqual(['terra']);
    expect(cost.byTier.terra).toBeUndefined();
  });

  it('ignores a tier that did no work', () => {
    process.env.PRICE_LUNA_INPUT = '1';
    process.env.PRICE_LUNA_OUTPUT = '1';

    // A run with no repairs must not report luna as unpriced or as $0.00 spent.
    const cost = costOf({ luna: { inputTokens: 0, outputTokens: 0, calls: 0, ms: 0 } });
    expect(cost.total).toBeNull();
    expect(cost.unpriced).toEqual([]);
  });

  it('handles a run with no recorded usage at all', () => {
    expect(costOf({})).toEqual({ total: null, byTier: {}, unpriced: [] });
  });
});
