import OpenAI from 'openai';
import type { Effort, ModelImage, Provider, ProviderRequest, ProviderResponse } from './types.js';

/**
 * OpenAI provider.
 *
 * Every vendor-specific constraint lives in this file and nowhere else:
 *
 *   - the output cap is `max_completion_tokens`;
 *   - reasoning depth is `reasoning_effort`, whose ladder is shorter than the
 *     platform's five levels, so the top two collapse onto `high`;
 *   - strict structured output forbids optional properties, hence the `strict`
 *     schema dialect;
 *   - `json_schema.name` is capped at 64 characters;
 *   - long planning and build calls need a request timeout well above the
 *     SDK default.
 */
export class OpenAiProvider implements Provider {
  readonly name = 'openai' as const;
  readonly schemaDialect = 'strict' as const;

  private readonly client: OpenAI;

  constructor(client?: OpenAI) {
    // The SDK defaults to a 10-minute request timeout. Planning and build calls
    // legitimately exceed that — one observed plan took 651s where an identical
    // earlier call took 43s — and a timeout mid-call costs a full silent retry
    // of work already in progress rather than failing fast.
    this.client = client ?? new OpenAI({ timeout: 20 * 60 * 1000, maxRetries: 2 });
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const completion = await this.client.chat.completions.create({
      model: request.model,
      max_completion_tokens: request.maxTokens,
      reasoning_effort: toReasoningEffort(request.effort),
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: userContent(request.prompt, request.images) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName(request.schemaName),
          strict: true,
          schema: request.schema,
        },
      },
    }, request.signal ? { signal: request.signal } : undefined);

    const choice = completion.choices[0];
    const message = choice?.message;

    return {
      text: message?.content ?? '',
      model: completion.model,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      stopReason: message?.refusal
        ? 'refusal'
        : choice?.finish_reason === 'length'
          ? 'truncated'
          : 'complete',
      refusalCategory: message?.refusal ?? null,
    };
  }
}

/**
 * The user turn. Text-only requests stay a plain string, byte-for-byte what they
 * always were; images follow the prompt as base64 data URLs at high detail, each
 * preceded by its label so the model knows which route and viewport it shows.
 */
export function userContent(
  prompt: string,
  images: readonly ModelImage[] | undefined,
): string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'high' } })[] {
  if (!images || images.length === 0) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.flatMap((image) => [
      { type: 'text' as const, text: image.label },
      { type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`, detail: 'high' as const } },
    ]),
  ];
}

/** This provider caps the schema name at 64 characters; labels can exceed it. */
const MAX_SCHEMA_NAME = 64;

export function schemaName(label: string): string {
  // Keep the tail rather than the head: labels are prefixed by role and
  // suffixed by the thing being built ("terra_build_period-properties_html"),
  // so the end is what distinguishes one call from another.
  return label.length <= MAX_SCHEMA_NAME ? label : label.slice(label.length - MAX_SCHEMA_NAME);
}

/**
 * The platform's five effort levels onto this provider's four.
 *
 * `xhigh` and `max` both land on `high` — there is nothing above it here, and
 * silently sending an unknown value would be rejected rather than degraded.
 */
export function toReasoningEffort(effort: Effort): 'minimal' | 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
  }
}
