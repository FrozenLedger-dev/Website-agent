/**
 * The model runtime — the one boundary every production model invocation
 * crosses.
 *
 * The provider is always faked: what is under test is the harness's authority
 * over invocation — which skill runs at which tier, that usage is reported
 * exactly once and only for a real result, and that refusal, malformed output,
 * provider failure and cancellation each stay distinguishable — not a vendor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import {
  BuildOutput,
  ReviewOutcomeInput,
  SitePlan,
  SolAdjudicationDecision,
  SolApprovalRecommendation,
  SolReplanResult,
  SolRouteDecision,
} from '@statxai/contracts';
import {
  MODEL_SKILL_TIERS,
  MalformedModelOutput,
  ModelRefusal,
  ModelRuntime,
  ModelSkillTierMismatch,
  OpenAiProvider,
  adjudicate,
  buildAnchor,
  buildPage,
  buildSite,
  planSite,
  recommendApproval,
  repairDefect,
  replanSite,
  reviewSite,
  routeBuild,
  type ModelInvocation,
  type ModelSkill,
  type ModelUsageEvent,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from '../src/index.js';

const Schema = z.object({ ok: z.boolean() });

type Turn = Partial<ProviderResponse> | ((request: ProviderRequest) => Promise<ProviderResponse>);

function fakeProvider(turns: Turn[]) {
  const requests: ProviderRequest[] = [];
  let index = 0;
  const provider: Provider = {
    name: 'test',
    schemaDialect: 'standard',
    async complete(request) {
      requests.push(request);
      const turn = turns[Math.min(index++, turns.length - 1)]!;
      if (typeof turn === 'function') return turn(request);
      return { text: '{"ok":true}', model: request.model, inputTokens: 11, outputTokens: 22, stopReason: 'complete', ...turn };
    },
  };
  return { provider, requests };
}

function runtimeWith(turns: Turn[]) {
  const usage: ModelUsageEvent[] = [];
  const { provider, requests } = fakeProvider(turns);
  const runtime = new ModelRuntime({ provider, onUsage: (event) => usage.push(event) });
  return { runtime, usage, requests };
}

const invocation = (over: Partial<ModelInvocation<{ ok: boolean }>> = {}): ModelInvocation<{ ok: boolean }> => ({
  skill: 'terra-review',
  tier: 'terra',
  label: 'terra:review',
  system: 's',
  prompt: 'p',
  schema: Schema,
  ...over,
});

let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env };
  delete process.env.MODEL_SOL;
  delete process.env.MODEL_TERRA;
  delete process.env.MODEL_LUNA;
});
afterEach(() => {
  process.env = env;
});

// ---------------------------------------------------------------------------

describe('skill and tier authority', () => {
  it('names every production skill at exactly the tier it ran at before', () => {
    expect(MODEL_SKILL_TIERS).toEqual({
      'sol-plan': 'sol',
      'sol-route': 'sol',
      'sol-adjudicate': 'sol',
      'sol-replan': 'sol',
      'sol-approve': 'sol',
      'terra-build': 'terra',
      'terra-review': 'terra',
      'terra-refine': 'terra',
      'terra-edit': 'terra',
      'luna-repair': 'luna',
    });
  });

  it('resolves each tier to the same model as before', async () => {
    const expected = { sol: 'gpt-5.6-sol', terra: 'gpt-5.6-terra', luna: 'gpt-5.6-luna' } as const;
    for (const [skill, tier] of Object.entries(MODEL_SKILL_TIERS) as [ModelSkill, keyof typeof expected][]) {
      const { runtime, requests } = runtimeWith([{}]);
      await runtime.invoke(invocation({ skill, tier }));
      expect(requests[0]!.model, skill).toBe(expected[tier]);
    }
  });

  it('refuses a skill at the wrong tier, or an unknown skill, before any provider call', async () => {
    const { runtime, requests, usage } = runtimeWith([{}]);

    await expect(runtime.invoke(invocation({ skill: 'sol-plan', tier: 'terra' }))).rejects.toBeInstanceOf(ModelSkillTierMismatch);
    await expect(runtime.invoke(invocation({ skill: 'terra-build', tier: 'luna' }))).rejects.toBeInstanceOf(ModelSkillTierMismatch);
    await expect(runtime.invoke(invocation({ skill: 'made-up' as ModelSkill, tier: 'sol' }))).rejects.toBeInstanceOf(ModelSkillTierMismatch);

    expect(requests).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('gives every invocation its own identity, carried on the result and its usage', async () => {
    const { runtime, usage } = runtimeWith([{}]);
    const a = await runtime.invoke(invocation());
    const b = await runtime.invoke(invocation());

    expect(a.invocationId).not.toBe(b.invocationId);
    expect(usage.map((u) => u.invocationId)).toEqual([a.invocationId, b.invocationId]);
    expect(a).toMatchObject({ skill: 'terra-review', tier: 'terra', value: { ok: true } });
  });

  it('never needs credentials merely to exist', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => new ModelRuntime()).not.toThrow();
  });
});

describe('usage is reported by the runtime, exactly once, for a real result only', () => {
  it('one successful invocation, one usage event', async () => {
    const { runtime, usage } = runtimeWith([{ inputTokens: 7, outputTokens: 9 }]);
    await runtime.invoke(invocation());

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ skill: 'terra-review', tier: 'terra', model: 'gpt-5.6-terra', inputTokens: 7, outputTokens: 9 });
  });

  it('a truncated first attempt is retried once, as before, and still reports once with the final attempt', async () => {
    const { runtime, usage, requests } = runtimeWith([
      { stopReason: 'truncated', text: '{"ok":', inputTokens: 1, outputTokens: 1 },
      { inputTokens: 3, outputTokens: 4 },
    ]);
    await runtime.invoke(invocation({ maxTokens: 10_000, effort: 'high' }));

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ maxTokens: 20_000, effort: 'medium' });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 3, outputTokens: 4 });
  });

  it.each([
    ['refusal', { stopReason: 'refusal' as const, refusalCategory: 'cyber' }, ModelRefusal],
    ['malformed output', { text: 'not json' }, MalformedModelOutput],
    ['schema violation', { text: '{"ok":"yes"}' }, MalformedModelOutput],
  ])('%s keeps its own error type and reports no usage', async (_label, turn, ErrorType) => {
    const { runtime, usage } = runtimeWith([turn]);
    await expect(runtime.invoke(invocation())).rejects.toBeInstanceOf(ErrorType);
    expect(usage).toHaveLength(0);
  });

  it('a refusal is not retried and carries its category', async () => {
    const { runtime, requests } = runtimeWith([{ stopReason: 'refusal', refusalCategory: 'cyber' }]);
    const error = await runtime.invoke(invocation()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelRefusal);
    expect((error as ModelRefusal).category).toBe('cyber');
    expect(requests).toHaveLength(1);
  });

  it('a provider failure propagates unchanged, reports no usage, and is not retried by the runtime', async () => {
    const outage = new Error('503 upstream unavailable');
    const { runtime, usage, requests } = runtimeWith([async () => { throw outage; }]);

    await expect(runtime.invoke(invocation())).rejects.toBe(outage);
    expect(requests).toHaveLength(1);
    expect(usage).toHaveLength(0);
  });
});

describe('cancellation reaches the provider', () => {
  it('forwards the signal on the provider request', async () => {
    const { runtime, requests } = runtimeWith([{}]);
    const controller = new AbortController();
    await runtime.invoke(invocation({ signal: controller.signal }));
    expect(requests[0]!.signal).toBe(controller.signal);
  });

  it('an in-flight call aborted by its caller rejects with the caller’s own reason and reports no usage', async () => {
    const controller = new AbortController();
    const reason = new Error('lease authority lost');
    const { runtime, usage } = runtimeWith([
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal!.addEventListener('abort', () => reject(new Error('provider-specific abort error')));
        }),
    ]);

    const pending = runtime.invoke(invocation({ signal: controller.signal }));
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(usage).toHaveLength(0);
  });

  it('an already-aborted signal never reaches the provider', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const { runtime, requests } = runtimeWith([{}]);

    await expect(runtime.invoke(invocation({ signal: controller.signal }))).rejects.toThrow('gone');
    expect(requests).toHaveLength(0);
  });

  it('a provider that ignores the signal still cannot turn a cancelled call into a success', async () => {
    const controller = new AbortController();
    const { runtime, usage } = runtimeWith([
      async (request) => {
        controller.abort(new Error('cancelled mid-call'));
        return { text: '{"ok":true}', model: request.model, inputTokens: 1, outputTokens: 1, stopReason: 'complete' };
      },
    ]);

    await expect(runtime.invoke(invocation({ signal: controller.signal }))).rejects.toThrow('cancelled mid-call');
    expect(usage).toHaveLength(0);
  });

  it('the OpenAI provider passes the signal as a request option, and keeps its timeout and transport retries', async () => {
    const create = vi.fn(async (_body: unknown, _options?: unknown) => ({
      model: 'gpt-5.6-terra',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: null } }],
    }));
    const provider = new OpenAiProvider({ chat: { completions: { create } } } as never);
    const controller = new AbortController();

    await provider.complete({ model: 'm', system: 's', prompt: 'p', schema: {}, schemaName: 'n', maxTokens: 10, effort: 'high', signal: controller.signal });
    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
    expect(Object.keys(create.mock.calls[0]![0] as object)).not.toContain('signal');

    process.env.OPENAI_API_KEY = 'test-key';
    const real = new OpenAiProvider() as unknown as { client: { timeout: number; maxRetries: number } };
    expect(real.client.timeout).toBe(20 * 60 * 1000);
    expect(real.client.maxRetries).toBe(2);
  });
});

describe('every production skill invokes through the runtime', () => {
  const profile = { businessName: 'Acme', services: [] } as never;
  const plan = {
    sitemap: { pages: [{ route: '/', title: 'Home', sections: [] }, { route: '/about', title: 'About', sections: [] }] },
    brandSystem: { artDirection: 'plain' },
    acceptanceCriteria: [],
  } as never;

  const spyRuntime = () => {
    const runtime = new ModelRuntime();
    const sentinel = { sentinel: true };
    const invoke = vi.spyOn(runtime, 'invoke').mockImplementation(async (inv) => ({
      value: sentinel as never,
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      ms: 0,
      invocationId: 'id',
      skill: inv.skill,
      tier: inv.tier,
    }));
    return { runtime, invoke, sentinel };
  };

  const signal = new AbortController().signal;

  it.each([
    ['sol-plan', 'sol', 'sol:plan', SitePlan, (r: ModelRuntime) => planSite(r, profile)],
    ['sol-route', 'sol', 'sol:route', SolRouteDecision, (r: ModelRuntime) =>
      routeBuild(r, profile, plan, { pageCount: 2, sectionCount: 0, serviceCount: 0, permittedStrategies: ['one_shot'] }, { signal })],
    ['sol-adjudicate', 'sol', 'sol:adjudicate', SolAdjudicationDecision, (r: ModelRuntime) =>
      adjudicate(r, {
        reviewCycle: 0, legalActions: ['block'], remainingBudgets: {}, openBlockingDefects: [], previousRepairs: [],
        repairEligibility: [], gateFindings: [], reviewSummary: null, autonomyMode: 'full_autonomous', maxRepairTargets: 1,
      } as never)],
    ['sol-replan', 'sol', 'sol:replan', SolReplanResult, (r: ModelRuntime) =>
      replanSite(r, {
        reviewCycle: 0, scope: 'site', adjudicationReason: 'r', remainingBudgets: {}, previousPlan: {}, profile: {},
        unresolvedDefects: [], repairHistory: [], gateFindings: [], reviewSummary: null,
      } as never)],
    ['sol-approve', 'sol', 'sol:approve', SolApprovalRecommendation, (r: ModelRuntime) =>
      recommendApproval(r, {
        reviewCycle: 0, plan: {}, profile: {}, qualityScore: 90, blockingCount: 0, gatesRun: [], gateFindings: [],
        buildSummary: 'ok', reviewSummary: null, openNonBlocking: [], repairHistory: [], replanCount: 0,
        autonomyMode: 'full_autonomous', releasePolicy: {},
      } as never)],
    ['terra-build', 'terra', 'terra:build', BuildOutput, (r: ModelRuntime) => buildSite(r, profile, plan, { signal })],
    ['terra-build', 'terra', 'terra:build:anchor', BuildOutput, (r: ModelRuntime) => buildAnchor(r, profile, plan, { signal })],
    ['terra-build', 'terra', 'terra:build:/about', BuildOutput, (r: ModelRuntime) =>
      buildPage(r, profile, plan, { route: '/about', title: 'About', sections: [] } as never, 'anchor', 'layout', { signal })],
    ['terra-review', 'terra', 'terra:review', ReviewOutcomeInput, (r: ModelRuntime) => reviewSite(r, profile, plan, [], 0, [])],
    ['luna-repair', 'luna', 'luna:repair:QA-1', BuildOutput, (r: ModelRuntime) =>
      repairDefect(r, profile, { id: 'QA-1', severity: 'P1', category: 'content', location: 'x', reason: 'r', acceptanceTest: 't' } as never, [])],
  ] as const)('%s (%s) — %s', async (skill, tier, label, schema, call) => {
    const { runtime, invoke, sentinel } = spyRuntime();
    const result = await call(runtime);

    expect(invoke).toHaveBeenCalledTimes(1);
    const sent = invoke.mock.calls[0]![0];
    expect(sent.skill).toBe(skill);
    expect(sent.tier).toBe(tier);
    // Compared by identity without printing: a Zod schema is far too large to diff.
    expect(sent.schema === schema, `${label} schema`).toBe(true);
    expect(sent.label).toBe(label);
    expect(result.value).toBe(sentinel);
    if (skill === 'sol-route' || skill === 'terra-build') expect(sent.signal).toBe(signal);
  });
});
