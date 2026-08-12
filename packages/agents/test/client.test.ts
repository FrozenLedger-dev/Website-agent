import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import type Anthropic from '@anthropic-ai/sdk';
import { MalformedModelOutput, ModelClient, ModelRefusal, stepDownEffort } from '../src/index.js';

const Schema = z.object({ ok: z.boolean() });

interface FakeTurn {
  stop_reason: string;
  text: string;
}

/**
 * Minimal stand-in for the SDK surface `ModelClient` uses, so retry behaviour
 * is testable without spending tokens. Records the parameters of every attempt.
 */
function fakeClient(turns: FakeTurn[]) {
  const calls: { max_tokens: number; effort: string }[] = [];
  let index = 0;

  const client = {
    messages: {
      stream(params: { max_tokens: number; output_config: { effort: string } }) {
        calls.push({ max_tokens: params.max_tokens, effort: params.output_config.effort });
        const turn = turns[Math.min(index++, turns.length - 1)]!;
        return {
          async finalMessage() {
            return {
              model: 'test-model',
              stop_reason: turn.stop_reason,
              stop_details: { category: 'cyber' },
              content: [{ type: 'text', text: turn.text }],
              usage: { input_tokens: 10, output_tokens: 20 },
            };
          },
        };
      },
    },
  } as unknown as Anthropic;

  return { client, calls };
}

const call = (client: Anthropic) =>
  new ModelClient(client).call({
    tier: 'terra',
    label: 'test',
    system: 's',
    prompt: 'p',
    schema: Schema,
    maxTokens: 32_000,
    effort: 'xhigh',
  });

describe('effort ladder', () => {
  it('steps down one level and floors at low', () => {
    expect(stepDownEffort('max')).toBe('xhigh');
    expect(stepDownEffort('xhigh')).toBe('high');
    expect(stepDownEffort('high')).toBe('medium');
    expect(stepDownEffort('low')).toBe('low');
  });
});

describe('truncation retry', () => {
  it('retries with double the headroom and one step less effort', async () => {
    // Truncation killed three separate call sites before this existed; each
    // lost a delivery that had already succeeded up to that point.
    const { client, calls } = fakeClient([
      { stop_reason: 'max_tokens', text: '' },
      { stop_reason: 'end_turn', text: '{"ok":true}' },
    ]);

    const result = await call(client);

    expect(result.value).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ max_tokens: 32_000, effort: 'xhigh' });
    expect(calls[1]).toEqual({ max_tokens: 64_000, effort: 'high' });
  });

  it('never asks for more than the model can emit', async () => {
    const { client, calls } = fakeClient([
      { stop_reason: 'max_tokens', text: '' },
      { stop_reason: 'end_turn', text: '{"ok":true}' },
    ]);

    await new ModelClient(client).call({
      tier: 'terra',
      label: 'test',
      system: 's',
      prompt: 'p',
      schema: Schema,
      maxTokens: 100_000,
      effort: 'high',
    });

    expect(calls[1]?.max_tokens).toBe(128_000);
  });

  it('gives up after one retry rather than looping', async () => {
    const { client, calls } = fakeClient([{ stop_reason: 'max_tokens', text: '' }]);
    await expect(call(client)).rejects.toBeInstanceOf(MalformedModelOutput);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a refusal', async () => {
    // A refusal is a decision, not a capacity problem — retrying wastes tokens.
    const { client, calls } = fakeClient([{ stop_reason: 'refusal', text: '' }]);
    await expect(call(client)).rejects.toBeInstanceOf(ModelRefusal);
    expect(calls).toHaveLength(1);
  });

  it('does not retry output that violates its contract', async () => {
    // Malformed-but-complete output will not improve with more headroom.
    const { client, calls } = fakeClient([{ stop_reason: 'end_turn', text: '{"ok":"yes"}' }]);
    await expect(call(client)).rejects.toBeInstanceOf(MalformedModelOutput);
    expect(calls).toHaveLength(1);
  });
});
