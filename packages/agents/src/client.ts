/**
 * Model adapter.
 *
 * The document is explicit that Sol/Terra/Luna are orchestration tiers, not
 * model names (§1), so the tier → model mapping lives in configuration and
 * nothing downstream references a model id.
 */
import Anthropic from '@anthropic-ai/sdk';
import type * as z from 'zod/v4';
import { toModelSchema, type AgentTier } from '@statxai/contracts';

/**
 * Default mapping.
 *
 * All three tiers default to the flagship model. §2 argues for reserving
 * high-reasoning models for planning and giving bounded repairs to smaller
 * ones — that is a cost/quality decision for the operator, so it is exposed as
 * configuration (MODEL_SOL / MODEL_TERRA / MODEL_LUNA) rather than assumed
 * here. Setting MODEL_LUNA=claude-haiku-4-5 implements §2's cost-control
 * principle without a code change.
 */
const DEFAULT_MODEL = 'claude-opus-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  switch (tier) {
    case 'sol':
      return process.env.MODEL_SOL ?? DEFAULT_MODEL;
    case 'terra':
      return process.env.MODEL_TERRA ?? DEFAULT_MODEL;
    case 'luna':
      return process.env.MODEL_LUNA ?? DEFAULT_MODEL;
  }
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
  /** Label used in usage reporting. */
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
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  /**
   * One structured call, retrying once if the response is cut off.
   *
   * `max_tokens` bounds thinking *and* output together, so how much headroom a
   * call needs depends on how much the model chooses to reason — which varies
   * run to run for identical inputs. Three different call sites were each
   * truncated at a different ceiling before this existed, and every one killed
   * a delivery outright. Retrying with more headroom and less effort is far
   * cheaper than losing the work already done.
   */
  async call<T>(options: CallOptions<T>): Promise<CallResult<T>> {
    try {
      return await this.attempt(options);
    } catch (error) {
      if (!(error instanceof MalformedModelOutput) || !/truncated/.test(error.message)) throw error;

      const retry: CallOptions<T> = {
        ...options,
        maxTokens: Math.min(MAX_OUTPUT_TOKENS, (options.maxTokens ?? 32_000) * 2),
        effort: stepDownEffort(options.effort ?? 'high'),
      };
      return this.attempt(retry);
    }
  }

  private async attempt<T>(options: CallOptions<T>): Promise<CallResult<T>> {
    const model = modelFor(options.tier);
    const started = Date.now();

    const stream = this.client.messages.stream({
      model,
      max_tokens: options.maxTokens ?? 32_000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: options.effort ?? 'high',
        format: { type: 'json_schema', schema: toModelSchema(options.schema) },
      },
      system: options.system,
      messages: [{ role: 'user', content: options.prompt }],
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new ModelRefusal(message.stop_details?.category);
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (message.stop_reason === 'max_tokens') {
      throw new MalformedModelOutput(text, new Error('output truncated at max_tokens'));
    }

    let value: T;
    try {
      value = options.schema.parse(JSON.parse(text));
    } catch (error) {
      throw new MalformedModelOutput(text, error);
    }

    return {
      value,
      model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      ms: Date.now() - started,
    };
  }
}
