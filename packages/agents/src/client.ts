/**
 * Model adapter.
 *
 * The document is explicit that Sol/Terra/Luna are orchestration tiers, not
 * model names (§1), so the tier → model mapping lives in configuration.
 * Nothing above this file references a model id.
 *
 * The Provider seam is retained even with a single implementation: it is what
 * keeps the vendor's constraints — the strict schema dialect, the shorter
 * effort ladder, the schema-name cap, the request timeout — out of the skills,
 * gates and orchestrator. §2 lists model portability as a reason for the
 * architecture, and adding a vendor means implementing one interface.
 */
import type * as z from 'zod/v4';
import { stripNulls, toModelSchema, toStrictModelSchema, type AgentTier } from '@statxai/contracts';
import { OpenAiProvider } from './providers/openai.js';
import type { Effort, Provider } from './providers/types.js';

export type { Effort, Provider, ProviderRequest, ProviderResponse } from './providers/types.js';
export { OpenAiProvider, schemaName, toReasoningEffort } from './providers/openai.js';

/**
 * Tier defaults.
 *
 * The account exposes a model per orchestration tier, which maps onto §1's
 * labels directly. Override any of them with MODEL_SOL / MODEL_TERRA /
 * MODEL_LUNA — §2's cost-control argument (smaller models for bounded repairs)
 * is an operator decision, so it is configuration rather than an assumption
 * made here.
 */
const DEFAULT_MODELS: Record<AgentTier, string> = {
  sol: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-5.6-luna',
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

export function modelFor(tier: AgentTier): string {
  const override =
    tier === 'sol' ? process.env.MODEL_SOL : tier === 'terra' ? process.env.MODEL_TERRA : process.env.MODEL_LUNA;
  return override ?? DEFAULT_MODELS[tier];
}

export function createProvider(): Provider {
  return new OpenAiProvider();
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
   * The output cap bounds reasoning and answer together, so how much headroom a
   * call needs depends on how much the model chooses to think — which varies
   * run to run for identical inputs. Three separate call sites were each
   * truncated at a different ceiling before this existed, and every one killed
   * a delivery outright.
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
      model: modelFor(options.tier),
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
      // A strict dialect expresses "absent" as null, because every property must
      // be required. Convert back before the Zod schema — which is what actually
      // enforces the contract — sees it.
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
