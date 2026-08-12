import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  MalformedModelOutput,
  ModelClient,
  ModelRefusal,
  modelFor,
  providerName,
  stepDownEffort,
  schemaName,
  toReasoningEffort,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from '../src/index.js';

const Schema = z.object({ ok: z.boolean(), note: z.string().optional() });

type Turn = Partial<ProviderResponse> & Pick<ProviderResponse, 'stopReason' | 'text'>;

/** Stub provider recording each attempt, so retry behaviour is testable free. */
function fakeProvider(turns: Turn[], dialect: Provider['schemaDialect'] = 'standard') {
  const calls: ProviderRequest[] = [];
  let index = 0;

  const provider: Provider = {
    name: 'anthropic',
    schemaDialect: dialect,
    async complete(request) {
      calls.push(request);
      const turn = turns[Math.min(index++, turns.length - 1)]!;
      return {
        model: 'test-model',
        inputTokens: 10,
        outputTokens: 20,
        refusalCategory: 'cyber',
        ...turn,
      };
    },
  };

  return { provider, calls };
}

const call = (provider: Provider) =>
  new ModelClient(provider).call({
    tier: 'terra',
    label: 'terra:review',
    system: 's',
    prompt: 'p',
    schema: Schema,
    maxTokens: 32_000,
    effort: 'xhigh',
  });

describe('provider selection', () => {
  it('infers the provider from whichever credential is present', () => {
    const env = { ...process.env };
    try {
      delete process.env.PROVIDER;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = 'x';
      expect(providerName()).toBe('openai');

      process.env.ANTHROPIC_API_KEY = 'y';
      expect(providerName()).toBe('anthropic');

      process.env.PROVIDER = 'openai';
      expect(providerName()).toBe('openai');
    } finally {
      process.env = env;
    }
  });

  it('maps each tier to its provider default', () => {
    const env = { ...process.env };
    try {
      delete process.env.MODEL_SOL;
      delete process.env.MODEL_TERRA;
      delete process.env.MODEL_LUNA;

      expect(modelFor('sol', 'openai')).toBe('gpt-5.6-sol');
      expect(modelFor('terra', 'openai')).toBe('gpt-5.6-terra');
      expect(modelFor('luna', 'openai')).toBe('gpt-5.6-luna');
      expect(modelFor('sol', 'anthropic')).toBe('claude-opus-5');

      // §2's cost control is a config change, not a code change.
      process.env.MODEL_LUNA = 'claude-haiku-4-5';
      expect(modelFor('luna', 'anthropic')).toBe('claude-haiku-4-5');
    } finally {
      process.env = env;
    }
  });
});

describe('effort ladders', () => {
  it('steps down one level and floors at low', () => {
    expect(stepDownEffort('max')).toBe('xhigh');
    expect(stepDownEffort('xhigh')).toBe('high');
    expect(stepDownEffort('low')).toBe('low');
  });

  it('collapses the top two tiers onto the shorter provider ladder', () => {
    expect(toReasoningEffort('xhigh')).toBe('high');
    expect(toReasoningEffort('max')).toBe('high');
    expect(toReasoningEffort('medium')).toBe('medium');
  });
});

describe('truncation retry', () => {
  it('retries with double the headroom and one step less effort', async () => {
    const { provider, calls } = fakeProvider([
      { stopReason: 'truncated', text: '' },
      { stopReason: 'complete', text: '{"ok":true}' },
    ]);

    const result = await call(provider);

    expect(result.value).toEqual({ ok: true });
    expect(calls.map((c) => [c.maxTokens, c.effort])).toEqual([
      [32_000, 'xhigh'],
      [64_000, 'high'],
    ]);
  });

  it('gives up after one retry rather than looping', async () => {
    const { provider, calls } = fakeProvider([{ stopReason: 'truncated', text: '' }]);
    await expect(call(provider)).rejects.toBeInstanceOf(MalformedModelOutput);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a refusal', async () => {
    // A refusal is a decision, not a capacity problem.
    const { provider, calls } = fakeProvider([{ stopReason: 'refusal', text: '' }]);
    await expect(call(provider)).rejects.toBeInstanceOf(ModelRefusal);
    expect(calls).toHaveLength(1);
  });

  it('does not retry output that violates its contract', async () => {
    const { provider, calls } = fakeProvider([{ stopReason: 'complete', text: '{"ok":"yes"}' }]);
    await expect(call(provider)).rejects.toBeInstanceOf(MalformedModelOutput);
    expect(calls).toHaveLength(1);
  });
});

describe('schema dialects', () => {
  it('sends an optional property as optional on a standard provider', async () => {
    const { provider, calls } = fakeProvider([{ stopReason: 'complete', text: '{"ok":true}' }]);
    await call(provider);

    const schema = calls[0]!.schema as { required: string[] };
    expect(schema.required).toEqual(['ok']);
  });

  it('sends every property as required-and-nullable on a strict provider', async () => {
    // Strict mode forbids optional properties, so "absent" has to be expressed
    // as null instead — and converted back before the contract is checked.
    const { provider, calls } = fakeProvider([{ stopReason: 'complete', text: '{"ok":true,"note":null}' }], 'strict');

    const result = await call(provider);

    const schema = calls[0]!.schema as {
      required: string[];
      properties: { note: { type: string[] } };
    };
    expect(schema.required.sort()).toEqual(['note', 'ok']);
    expect(schema.properties.note.type).toContain('null');

    // The null must not survive into the parsed value.
    expect(result.value).toEqual({ ok: true });
    expect('note' in result.value).toBe(false);
  });

  it('derives a provider-safe schema name from the label', async () => {
    const { provider, calls } = fakeProvider([{ stopReason: 'complete', text: '{"ok":true}' }]);
    await call(provider);
    expect(calls[0]!.schemaName).toBe('terra_review');
  });

  it('trims a schema name to the provider limit, keeping the distinguishing tail', () => {
    // OpenAI caps json_schema.name at 64 characters and rejects the request
    // outright. Labels like "terra:build:period-properties.html" exceed it, and
    // the tail is the part that identifies which page is being built.
    const long = `terra_build_${'x'.repeat(80)}_period-properties_html`;
    const trimmed = schemaName(long);

    expect(trimmed).toHaveLength(64);
    expect(trimmed.endsWith('_period-properties_html')).toBe(true);
    expect(schemaName('terra_review')).toBe('terra_review');
  });
});
