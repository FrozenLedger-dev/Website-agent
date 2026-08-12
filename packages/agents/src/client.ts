/**
 * Model adapter.
 *
 * The document is explicit that Sol/Terra/Luna are orchestration tiers, not
 * model names (§1), so both the vendor and the tier → model mapping live in
 * configuration. Nothing above this file references a vendor or a model id.
 */
import type * as z from 'zod/v4';
import { stripNulls, toModelSchema, toStrictModelSchema, type AgentTier } from '@statxai/contracts';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAiProvider } from './providers/openai.js';
import type { Effort, Provider } from './providers/types.js';

export type { Effort, Provider, ProviderRequest, ProviderResponse } from './providers/types.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAiProvider, schemaName, toReasoningEffort } from './providers/openai.js';

export type ProviderName = 'anthropic' | 'openai';

/**
 * Per-provider tier defaults.
 *
 * The OpenAI account exposes a model per tier, which maps onto §1's labels
 * exactly. Anthropic defaults every tier to the flagship: §2 argues for smaller
 * models on bounded repairs, but that is an operator's cost decision, so it is
 * configuration (MODEL_LUNA=…) rather than an assumption made here.
 */
const DEFAULT_MODELS: Record<ProviderName, Record<AgentTier, string>> = {
  anthropic: {
    sol: 'claude-opus-5',
    terra: 'claude-opus-5',
    luna: 'claude-opus-5',
  },
  openai: {
    sol: 'gpt-5.6-sol',
    terra: 'gpt-5.6-terra',
    luna: 'gpt-5.6-luna',
  },
};

/** Model output ceiling. Retries never ask for more than the model can emit. */
const MAX_OUTPUT_TOKENS = 128_000;

const EFFORT_LADDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Lower effort on retry: less reasoning leaves more of the shared budget for
 * the answer, which is the half that was lost.
 */
export function stepDownEffort(effort: Effort): Effort {
  const index = EFFORT_LADDER.indexOf(effort);
  return index <= 0 ? 'low' : EFFORT_LADDER[index - 1]!;
}

export function providerName(): ProviderName {
  const configured = process.env.PROVIDER?.toLowerCase();
  if (configured === 'openai' || configured === 'anthropic') return configured;
  // Infer from whichever credential is present, so swapping keys is enough.
  if (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return 'openai';
  return 'anthropic';
}

export function modelFor(tier: AgentTier, provider: ProviderName = providerName()): string {
  const override =
    tier === 'sol' ? process.env.MODEL_SOL : tier === 'terra' ? process.env.MODEL_TERRA : process.env.MODEL_LUNA;
  return override ?? DEFAULT_MODELS[provider][tier];
}

export function createProvider(name: ProviderName = providerName()): Provider {
  return name === 'openai' ? new OpenAiProvider() : new AnthropicProvider();
}

export class ModelRefusal extends Error {
  constructor(readonly category: string | null | undefined) {
    super(`Model refused the request (${category ?? 'uncategorised'})`);
    this.name = 'ModelRefusal';
  }
}

export class MalformedModelOutput extends Error {
  constructor(
    readonly raw: string,
    cause: unknown,
  ) {
    super(`Model output did not satisfy its contract: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MalformedModelOutput';
  }
}

export interface CallOptions<T> {
  tier: AgentTier;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: Effort;
  /** Label used in usage reporting and as the provider-side schema name. */
  label: string;
}

export interface CallResult<T> {
  value: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export class ModelClient {
  private readonly provider: Provider;

  constructor(provider?: Provider) {
    this.provider = provider ?? createProvider();
  }

  /**
   * One structured call, retrying once if the response is cut off.
   *
   * The output cap bounds reasoning and answer together on both providers, so
   * how much headroom a call needs depends on how much the model chooses to
   * think — which varies run to run for identical inputs. Three separate call
   * sites were each truncated at a different ceiling before this existed, and
   * every one killed a delivery outright.
   */
  async call<T>(options: CallOptions<T>): Promise<CallResult<T>> {
    try {
      return await this.attempt(options);
    } catch (error) {
      if (!(error instanceof MalformedModelOutput) || !/truncated/.test(error.message)) throw error;

      return this.attempt({
        ...options,
        maxTokens: Math.min(MAX_OUTPUT_TOKENS, (options.maxTokens ?? 32_000) * 2),
        effort: stepDownEffort(options.effort ?? 'high'),
      });
    }
  }

  private async attempt<T>(options: CallOptions<T>): Promise<CallResult<T>> {
    const started = Date.now();
    const strict = this.provider.schemaDialect === 'strict';

    const response = await this.provider.complete({
      model: modelFor(options.tier, this.provider.name),
      system: options.system,
      prompt: options.prompt,
      schema: strict ? toStrictModelSchema(options.schema) : toModelSchema(options.schema),
      schemaName: options.label.replace(/[^a-zA-Z0-9_-]/g, '_'),
      maxTokens: options.maxTokens ?? 32_000,
      effort: options.effort ?? 'high',
    });

    if (response.stopReason === 'refusal') throw new ModelRefusal(response.refusalCategory);
    if (response.stopReason === 'truncated') {
      throw new MalformedModelOutput(response.text, new Error('output truncated at max_tokens'));
    }

    let value: T;
    try {
      const parsed: unknown = JSON.parse(response.text);
      // Strict dialects express "absent" as null, because every property must
      // be required. Convert back before the Zod schema — which is what
      // actually enforces the contract — sees it.
      value = options.schema.parse(strict ? stripNulls(parsed) : parsed);
    } catch (error) {
      throw new MalformedModelOutput(response.text, error);
    }

    return {
      value,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ms: Date.now() - started,
    };
  }
}
