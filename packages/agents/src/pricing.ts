/**
 * What a delivery cost.
 *
 * Rates are configuration, never a built-in default. Tiers map to models
 * through `MODEL_SOL`/`MODEL_TERRA`/`MODEL_LUNA` (§1: tiers are orchestration
 * roles, not model names), so the platform cannot know what a tier costs — and
 * a guessed rate produces a confident, wrong number on an invoice-shaped
 * screen, which is worse than showing nothing.
 *
 *   PRICE_SOL_INPUT=1.25      # USD per 1M input tokens
 *   PRICE_SOL_OUTPUT=10       # USD per 1M output tokens
 *   PRICE_TERRA_INPUT=…       PRICE_TERRA_OUTPUT=…
 *   PRICE_LUNA_INPUT=…        PRICE_LUNA_OUTPUT=…
 *
 * A tier with no rates configured contributes nothing and is reported as
 * unpriced, so a partial configuration cannot silently understate a total.
 */
import type { AgentTier } from '@statxai/contracts';

export interface TierUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  ms: number;
}

export type UsageByTier = Partial<Record<AgentTier, TierUsage>>;

export interface Rate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

const ENV_KEYS: Record<AgentTier, [string, string]> = {
  sol: ['PRICE_SOL_INPUT', 'PRICE_SOL_OUTPUT'],
  terra: ['PRICE_TERRA_INPUT', 'PRICE_TERRA_OUTPUT'],
  luna: ['PRICE_LUNA_INPUT', 'PRICE_LUNA_OUTPUT'],
};

/** The configured rate for a tier, or null when it has not been priced. */
export function rateFor(tier: AgentTier): Rate | null {
  const [inputKey, outputKey] = ENV_KEYS[tier];
  const input = Number(process.env[inputKey]);
  const output = Number(process.env[outputKey]);

  // Both halves required: pricing input at a real rate and output at zero would
  // understate every run, and output is the expensive half.
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input < 0 || output < 0) return null;
  return { input, output };
}

export interface CostBreakdown {
  /** USD, summed over priced tiers only. Null when nothing is priced. */
  total: number | null;
  byTier: Partial<Record<AgentTier, number>>;
  /** Tiers that did work but have no configured rate. */
  unpriced: AgentTier[];
}

export function costOf(usage: UsageByTier): CostBreakdown {
  const byTier: Partial<Record<AgentTier, number>> = {};
  const unpriced: AgentTier[] = [];
  let total: number | null = null;

  for (const [key, tierUsage] of Object.entries(usage) as [AgentTier, TierUsage][]) {
    if (!tierUsage || tierUsage.calls === 0) continue;

    const rate = rateFor(key);
    if (!rate) {
      unpriced.push(key);
      continue;
    }

    const cost =
      (tierUsage.inputTokens / 1_000_000) * rate.input +
      (tierUsage.outputTokens / 1_000_000) * rate.output;
    byTier[key] = cost;
    total = (total ?? 0) + cost;
  }

  return { total, byTier, unpriced };
}
