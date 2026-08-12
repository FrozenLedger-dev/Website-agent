import Anthropic from '@anthropic-ai/sdk';
import type { Provider, ProviderRequest, ProviderResponse } from './types.js';

/**
 * Anthropic provider.
 *
 * Always streams: `max_tokens` here bounds thinking and output together, so
 * requests run large, and a non-streaming call above ~16K risks an HTTP timeout
 * rather than a clean failure.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic' as const;
  readonly schemaDialect = 'standard' as const;

  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const stream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: request.effort,
        format: { type: 'json_schema', schema: request.schema },
      },
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    });

    const message = await stream.finalMessage();

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      stopReason:
        message.stop_reason === 'refusal'
          ? 'refusal'
          : message.stop_reason === 'max_tokens'
            ? 'truncated'
            : 'complete',
      refusalCategory: message.stop_details?.category ?? null,
    };
  }
}
