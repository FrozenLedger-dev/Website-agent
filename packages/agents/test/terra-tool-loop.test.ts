/**
 * The bounded Terra model↔tool loop.
 *
 * Every turn goes through the real `ModelRuntime` with a scripted provider; the
 * tool side is a fake `ToolAccess`, because what is under test here is the
 * loop's contract — one strict action per turn, a final `BuildOutput`, the
 * bounds, cancellation — not a file system. The gateway and the real read-only
 * adapter are tested in the orchestrator package.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SitePlan, TestRunnerResult, ToolResult } from '@statxai/contracts';
import {
  MalformedModelOutput,
  ModelRefusal,
  ModelRuntime,
  TERRA_MAX_MODEL_TURNS,
  TERRA_MAX_TEST_RUNS,
  TERRA_MAX_TOOL_CALLS,
  ToolLoopBudgetExhausted,
  buildAnchor,
  buildPage,
  buildSite,
  type ModelUsageEvent,
  type Provider,
  type ProviderRequest,
  type ToolAccess,
  type ToolRequest,
} from '../src/index.js';

const profile = { businessName: 'Acme', services: [] } as never;
const plan = {
  sitemap: { pages: [{ route: '/', title: 'Home', sections: [] }, { route: '/about', title: 'About', sections: [] }] },
  brandSystem: { artDirection: 'plain' },
  acceptanceCriteria: [],
} as unknown as SitePlan;

const OUTPUT = { files: [{ path: 'app/page.tsx', contents: 'export default function P(){return null}' }], notes: 'n' };
const readAction = (path: string, tool = 'filesystem') => ({ action: 'tool', tool, input: { path }, output: null });
const finalAction = (output: unknown = OUTPUT) => ({ action: 'final', tool: null, input: null, output });
const BROKEN = { files: [{ path: 'app/page.tsx', contents: 'export default function P(){ const n: number = "x"; return n }' }], notes: 'broken' };
const FIXED = { files: [{ path: 'app/page.tsx', contents: 'export default function P(){ return null }' }], notes: 'fixed' };
const testAction = (candidate: unknown) => ({ action: 'tool', tool: 'test_runner', input: { candidate }, output: null });

/** A deterministic stand-in for the harness's measurement: anything containing `"x"` fails to compile. */
function testResult({ candidate }: { candidate: typeof OUTPUT }): TestRunnerResult {
  const broken = candidate.files.some((file) => file.contents.includes('"x"'));
  return {
    tool: 'test_runner',
    status: broken ? 'failed' : 'passed',
    passed: !broken,
    candidateHash: `hash-${candidate.notes}`,
    compile: { ok: !broken, diagnostics: broken ? "app/page.tsx(1,40): error TS2322: Type 'string' is not assignable to type 'number'." : '' },
    findings: [],
    findingCount: 0,
    refusedPaths: [],
    truncated: false,
  };
}

type Turn = unknown | ((request: ProviderRequest) => Promise<unknown>);

function scripted(turns: Turn[]) {
  const requests: ProviderRequest[] = [];
  const usage: ModelUsageEvent[] = [];
  let index = 0;
  const provider: Provider = {
    name: 'scripted',
    // Strict, like the production provider: absent fields arrive as null.
    schemaDialect: 'strict',
    async complete(request) {
      requests.push(request);
      const turn = turns[Math.min(index++, turns.length - 1)];
      const value = typeof turn === 'function' ? await (turn as (r: ProviderRequest) => Promise<unknown>)(request) : turn;
      if (value && typeof value === 'object' && 'stopReason' in (value as object)) {
        return { text: '', model: request.model, inputTokens: 1, outputTokens: 1, ...(value as object) } as never;
      }
      return { text: JSON.stringify(value), model: request.model, inputTokens: 5, outputTokens: 7, stopReason: 'complete' };
    },
  };
  const runtime = new ModelRuntime({ provider, onUsage: (event) => usage.push(event) });
  return { runtime, requests, usage };
}

function fakeTools(granted: ToolAccess['grantedTools'] = ['filesystem'], behaviour?: (request: ToolRequest, signal?: AbortSignal) => Promise<ToolResult>) {
  const calls: ToolRequest[] = [];
  const access: ToolAccess = {
    grantedTools: granted,
    async execute(request, signal) {
      calls.push(request);
      if (behaviour) return behaviour(request, signal);
      if (request.tool === 'test_runner') return testResult(request.input as { candidate: typeof OUTPUT });
      const path = (request.input as { path: string }).path;
      return { tool: 'filesystem', ok: true, path, content: `// contents of ${path}`, bytes: 20, truncated: false };
    },
  };
  return { access, calls };
}

describe('without granted tools, a build is exactly what it was', () => {
  it('one invocation, the unchanged prompt and the plain BuildOutput schema', async () => {
    const plain = scripted([OUTPUT]);
    const result = await buildSite(plain.runtime, profile, plan);

    expect(plain.requests).toHaveLength(1);
    expect(plain.requests[0]!.prompt).not.toContain('INSPECTING THE SCAFFOLD');
    expect(plain.requests[0]!.schemaName).toBe('terra_build');
    expect(result.value).toEqual(OUTPUT);

    // Tool access that grants nothing is the same as none at all.
    const ungranted = scripted([OUTPUT]);
    await buildSite(ungranted.runtime, profile, plan, { tools: fakeTools([]).access });
    expect(ungranted.requests[0]!.prompt).toBe(plain.requests[0]!.prompt);
    expect(ungranted.requests[0]!.schema).toEqual(plain.requests[0]!.schema);
  });
});

describe('with filesystem granted', () => {
  it('reads a requested file through the granted access, then returns the ordinary BuildOutput', async () => {
    const { runtime, requests, usage } = scripted([readAction('components/ui/button.tsx'), finalAction()]);
    const { access, calls } = fakeTools();

    const result = await buildSite(runtime, profile, plan, { tools: access });

    expect(calls).toEqual([{ tool: 'filesystem', input: { path: 'components/ui/button.tsx' } }]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.prompt).toContain('INSPECTING THE SCAFFOLD');
    expect(requests[1]!.prompt).toContain('// contents of components/ui/button.tsx');
    // The caller sees only the BuildOutput, never the action envelope.
    expect(result.value).toEqual(OUTPUT);
    expect(result.value).not.toHaveProperty('action');
    // Every turn is an ordinary runtime invocation: same skill and tier, one usage event each.
    expect(usage.map((u) => [u.skill, u.tier])).toEqual([['terra-build', 'terra'], ['terra-build', 'terra']]);
    expect(new Set(usage.map((u) => u.invocationId)).size).toBe(2);
  });

  it('an immediate final answer uses no tools and one invocation', async () => {
    const { runtime, requests, usage } = scripted([finalAction()]);
    const { access, calls } = fakeTools();

    const result = await buildSite(runtime, profile, plan, { tools: access });
    expect(result.value).toEqual(OUTPUT);
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(usage).toHaveLength(1);
  });

  it('applies to every Terra build call shape — whole site, anchor and page', async () => {
    for (const call of [
      (r: ModelRuntime, tools: ToolAccess) => buildSite(r, profile, plan, { tools }),
      (r: ModelRuntime, tools: ToolAccess) => buildAnchor(r, profile, plan, { tools }),
      (r: ModelRuntime, tools: ToolAccess) => buildPage(r, profile, plan, { route: '/about', title: 'About', sections: [] } as never, 'a', 'l', { tools }),
    ]) {
      const { runtime } = scripted([readAction('app/globals.css'), finalAction()]);
      const { access, calls } = fakeTools();
      await call(runtime, access);
      expect(calls).toHaveLength(1);
    }
  });

  it('a denied tool request propagates from the harness, and nothing further is asked', async () => {
    class Denied extends Error {}
    const { runtime, requests } = scripted([readAction('x', 'git'), finalAction()]);
    const { access } = fakeTools(['filesystem'], async () => {
      throw new Denied('not permitted');
    });

    await expect(buildSite(runtime, profile, plan, { tools: access })).rejects.toBeInstanceOf(Denied);
    expect(requests).toHaveLength(1);
  });

  it('a model cannot grant itself tools: extra fields in its action change nothing the harness decides', async () => {
    const { runtime } = scripted([{ ...readAction('app/layout.tsx'), allowedTools: ['git', 'hosting_release_api'] }, finalAction()]);
    const { access, calls } = fakeTools();
    await buildSite(runtime, profile, plan, { tools: access });

    expect(access.grantedTools).toEqual(['filesystem']);
    expect(calls).toEqual([{ tool: 'filesystem', input: { path: 'app/layout.tsx' } }]);
  });
});

describe('the loop is bounded', () => {
  it(`stops at ${TERRA_MAX_TOOL_CALLS} distinct tool calls`, async () => {
    const { runtime } = scripted([readAction('a.ts'), readAction('b.ts'), readAction('c.ts'), readAction('d.ts'), finalAction()]);
    const { access, calls } = fakeTools();

    const error = await buildSite(runtime, profile, plan, { tools: access }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolLoopBudgetExhausted);
    expect((error as ToolLoopBudgetExhausted).budget).toBe('tool_calls');
    expect(calls).toHaveLength(TERRA_MAX_TOOL_CALLS);
  });

  it(`stops at ${TERRA_MAX_MODEL_TURNS} model turns, even when repeated reads spend no tool calls`, async () => {
    const { runtime, requests } = scripted([readAction('a.ts')]);
    const { access, calls } = fakeTools();

    const error = await buildSite(runtime, profile, plan, { tools: access }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolLoopBudgetExhausted);
    expect((error as ToolLoopBudgetExhausted).budget).toBe('model_turns');
    expect(requests).toHaveLength(TERRA_MAX_MODEL_TURNS);
    // The repeated read was answered once and served from the build's own record after.
    expect(calls).toHaveLength(1);
  });

  it('bounds the total content fed back', async () => {
    const big = 'x'.repeat(10_000);
    const { runtime } = scripted([readAction('a.ts'), readAction('b.ts'), readAction('c.ts'), finalAction()]);
    const { access } = fakeTools(['filesystem'], async (request) => ({
      tool: 'filesystem', ok: true, path: (request.input as { path: string }).path, content: big, bytes: big.length, truncated: false,
    }));

    const error = await buildSite(runtime, profile, plan, { tools: access }).catch((e: unknown) => e);
    expect((error as ToolLoopBudgetExhausted).budget).toBe('returned_bytes');
  });
});

describe('strict actions and preserved failures', () => {
  it.each([
    ['a tool action without input', { action: 'tool', tool: 'filesystem', input: null, output: null }],
    ['a tool action that also carries output', { ...readAction('a.ts'), output: OUTPUT }],
    ['a final action without output', finalAction(null)],
    ['a final action with a malformed BuildOutput', finalAction({ files: 'not a list' })],
  ])('%s fails strictly', async (_label, response) => {
    const { runtime } = scripted([response]);
    const { access, calls } = fakeTools();
    await expect(buildSite(runtime, profile, plan, { tools: access })).rejects.toBeInstanceOf(MalformedModelOutput);
    expect(calls).toHaveLength(0);
  });

  it('a refusal is still a refusal', async () => {
    const { runtime } = scripted([{ stopReason: 'refusal', refusalCategory: 'cyber' }]);
    await expect(buildSite(runtime, profile, plan, { tools: fakeTools().access })).rejects.toBeInstanceOf(ModelRefusal);
  });
});

describe('cancellation stops the loop', () => {
  it('during a model turn', async () => {
    const controller = new AbortController();
    const reason = new Error('lease lost');
    const { runtime } = scripted([
      (request: ProviderRequest) =>
        new Promise((_resolve, reject) => {
          request.signal!.addEventListener('abort', () => reject(new Error('provider abort')));
          controller.abort(reason);
        }),
    ]);
    const { access, calls } = fakeTools();

    await expect(buildSite(runtime, profile, plan, { tools: access, signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(0);
  });

  it('during a tool call, with no further turn', async () => {
    const controller = new AbortController();
    const { runtime, requests } = scripted([readAction('a.ts'), finalAction()]);
    const invoke = vi.spyOn(runtime, 'invoke');
    const { access } = fakeTools(['filesystem'], async (request, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('lease lost during read'));
      return { tool: 'filesystem', ok: true, path: (request.input as { path: string }).path, content: 'x', bytes: 1, truncated: false };
    });

    await expect(buildSite(runtime, profile, plan, { tools: access, signal: controller.signal })).rejects.toThrow('lease lost during read');
    expect(requests).toHaveLength(1);
    // The loop itself stops: the runtime is never even asked for another turn.
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('with test_runner granted', () => {
  const both: ToolAccess['grantedTools'] = ['filesystem', 'test_runner'];

  it('describes testing only when it is granted, and never a command to run', async () => {
    const readsOnly = scripted([finalAction()]);
    await buildSite(readsOnly.runtime, profile, plan, { tools: fakeTools(['filesystem']).access });
    expect(readsOnly.requests[0]!.prompt).not.toContain('TESTING A CANDIDATE');

    const testsOnly = scripted([finalAction()]);
    await buildSite(testsOnly.runtime, profile, plan, { tools: fakeTools(['test_runner']).access });
    expect(testsOnly.requests[0]!.prompt).toContain('TESTING A CANDIDATE');
    expect(testsOnly.requests[0]!.prompt).not.toContain('INSPECTING THE SCAFFOLD');
    expect(testsOnly.requests[0]!.prompt).toContain(`up to ${TERRA_MAX_TEST_RUNS} more`);
  });

  it('a test_runner-only flow: test a candidate, then return it', async () => {
    const { runtime, requests, usage } = scripted([testAction(FIXED), finalAction(FIXED)]);
    const { access, calls } = fakeTools(['test_runner']);

    const result = await buildSite(runtime, profile, plan, { tools: access });

    expect(calls).toEqual([{ tool: 'test_runner', input: { candidate: FIXED } }]);
    expect(requests[1]!.prompt).toContain('"status":"passed"');
    expect(result.value).toEqual(FIXED);
    expect(result.value).not.toHaveProperty('action');
    expect(usage).toHaveLength(2);
  });

  it('filesystem → test_runner → final', async () => {
    const { runtime, requests } = scripted([readAction('components/ui/card.tsx'), testAction(FIXED), finalAction(FIXED)]);
    const { access, calls } = fakeTools(both);

    const result = await buildSite(runtime, profile, plan, { tools: access });

    expect(calls.map((c) => c.tool)).toEqual(['filesystem', 'test_runner']);
    expect(requests[2]!.prompt).toContain('// contents of components/ui/card.tsx');
    expect(requests[2]!.prompt).toContain('"status":"passed"');
    expect(result.value).toEqual(FIXED);
  });

  it('a failed test feeds the compiler diagnosis back, and a corrected final is returned', async () => {
    const { runtime, requests } = scripted([testAction(BROKEN), finalAction(FIXED)]);
    const { access } = fakeTools(both);

    const result = await buildSite(runtime, profile, plan, { tools: access });

    expect(requests[1]!.prompt).toContain('"passed":false');
    expect(requests[1]!.prompt).toContain('error TS2322');
    expect(result.value).toEqual(FIXED);
  });

  it('test → test → final within budget: three model usage events, two test executions', async () => {
    const { runtime, usage } = scripted([testAction(BROKEN), testAction(FIXED), finalAction(FIXED)]);
    const { access, calls } = fakeTools(both);

    const result = await buildSite(runtime, profile, plan, { tools: access });

    expect(result.value).toEqual(FIXED);
    expect(calls).toHaveLength(2);
    // Only model turns create usage; a test execution creates none.
    expect(usage).toHaveLength(3);
    expect(usage.every((u) => u.skill === 'terra-build' && u.tier === 'terra')).toBe(true);
  });

  it(`a third distinct test request is refused before it runs (max ${TERRA_MAX_TEST_RUNS})`, async () => {
    const third = { files: [{ path: 'app/page.tsx', contents: 'third' }], notes: 'third' };
    const { runtime, requests } = scripted([testAction(BROKEN), testAction(FIXED), testAction(third), finalAction()]);
    const { access, calls } = fakeTools(both);

    const error = await buildSite(runtime, profile, plan, { tools: access }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolLoopBudgetExhausted);
    expect((error as ToolLoopBudgetExhausted).budget).toBe('test_runs');
    expect(calls).toHaveLength(TERRA_MAX_TEST_RUNS);
    expect(requests).toHaveLength(3);
  });

  it('an exact duplicate candidate is served from the build’s own record: a turn, but no second sandbox run', async () => {
    const { runtime, requests } = scripted([testAction(BROKEN), testAction(BROKEN), testAction(FIXED), finalAction(FIXED)]);
    const { access, calls } = fakeTools(both);

    const result = await buildSite(runtime, profile, plan, { tools: access });

    expect(result.value).toEqual(FIXED);
    expect(calls.map((c) => (c.input as { candidate: { notes: string } }).candidate.notes)).toEqual(['broken', 'fixed']);
    expect(requests).toHaveLength(4);
  });

  it('repeating one duplicate forever still ends at the model-turn limit, having run once', async () => {
    const { runtime, requests } = scripted([testAction(BROKEN)]);
    const { access, calls } = fakeTools(both);

    const error = await buildSite(runtime, profile, plan, { tools: access }).catch((e: unknown) => e);

    expect((error as ToolLoopBudgetExhausted).budget).toBe('model_turns');
    expect(requests).toHaveLength(TERRA_MAX_MODEL_TURNS);
    expect(calls).toHaveLength(1);
  });

  it('the read budget is unaffected by tests: two tests, then a read, then final', async () => {
    const { runtime } = scripted([testAction(BROKEN), testAction(FIXED), readAction('app/globals.css'), finalAction(FIXED)]);
    const { access, calls } = fakeTools(both);

    await expect(buildSite(runtime, profile, plan, { tools: access })).resolves.toMatchObject({ value: FIXED });
    expect(calls.map((c) => c.tool)).toEqual(['test_runner', 'test_runner', 'filesystem']);
  });

  it('the test budget is unaffected by reads: two reads, then a test, then final', async () => {
    const { runtime } = scripted([readAction('a.ts'), readAction('b.ts'), testAction(FIXED), finalAction(FIXED)]);
    const { access, calls } = fakeTools(both);

    await expect(buildSite(runtime, profile, plan, { tools: access })).resolves.toMatchObject({ value: FIXED });
    expect(calls.map((c) => c.tool)).toEqual(['filesystem', 'filesystem', 'test_runner']);
  });

  it(`the read budget still stops a fourth read, whatever the test budget (max ${TERRA_MAX_TOOL_CALLS})`, async () => {
    const { runtime } = scripted([readAction('a.ts'), readAction('b.ts'), readAction('c.ts'), readAction('d.ts')]);
    const { access } = fakeTools(both);
    const error = await buildSite(runtime, profile, plan, { tools: access }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolLoopBudgetExhausted);
    expect((error as ToolLoopBudgetExhausted).budget).toBe('tool_calls');
  });

  it(`a test requested on the last of ${TERRA_MAX_MODEL_TURNS} turns is refused before it runs`, async () => {
    const { runtime, requests } = scripted([readAction('a.ts'), readAction('b.ts'), testAction(BROKEN), testAction(FIXED)]);
    const { access, calls } = fakeTools(both);

    const error = await buildSite(runtime, profile, plan, { tools: access }).catch((e: unknown) => e);

    expect((error as ToolLoopBudgetExhausted).budget).toBe('model_turns');
    expect(requests).toHaveLength(TERRA_MAX_MODEL_TURNS);
    expect(calls.map((c) => c.tool)).toEqual(['filesystem', 'filesystem', 'test_runner']);
  });

  it('applies to every Terra build call shape — whole site, anchor and page', async () => {
    for (const call of [
      (r: ModelRuntime, tools: ToolAccess) => buildSite(r, profile, plan, { tools }),
      (r: ModelRuntime, tools: ToolAccess) => buildAnchor(r, profile, plan, { tools }),
      (r: ModelRuntime, tools: ToolAccess) => buildPage(r, profile, plan, { route: '/about', title: 'About', sections: [] } as never, 'a', 'l', { tools }),
    ]) {
      const { runtime, usage } = scripted([testAction(FIXED), finalAction(FIXED)]);
      const { access, calls } = fakeTools(both);
      await call(runtime, access);
      expect(calls.map((c) => c.tool)).toEqual(['test_runner']);
      expect(usage).toHaveLength(2);
    }
  });

  it('a test cancelled by the lease stops the loop: no further turn and no other tool', async () => {
    const controller = new AbortController();
    const { runtime, requests } = scripted([testAction(FIXED), readAction('a.ts'), finalAction()]);
    const invoke = vi.spyOn(runtime, 'invoke');
    const { access, calls } = fakeTools(both, async (request, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('lease lost during test'));
      return testResult(request.input as { candidate: typeof OUTPUT });
    });

    await expect(buildSite(runtime, profile, plan, { tools: access, signal: controller.signal })).rejects.toThrow('lease lost during test');
    expect(requests).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a test request carrying a command', { ...testAction(FIXED), input: { candidate: FIXED, command: 'curl http://169.254.169.254' } }],
    ['a test request carrying a working directory', { ...testAction(FIXED), input: { candidate: FIXED, cwd: '/' } }],
    ['a test request carrying an environment', { ...testAction(FIXED), input: { candidate: FIXED, env: { OPENAI_API_KEY: 'x' } } }],
    ['a test request with a malformed BuildOutput', testAction({ files: [], notes: 'empty' })],
    ['a test request without a candidate', { action: 'tool', tool: 'test_runner', input: { path: 'app/page.tsx' }, output: null }],
    ['a read request carrying a candidate instead of a path', { action: 'tool', tool: 'filesystem', input: { candidate: FIXED }, output: null }],
    ['a test request that also carries output', { ...testAction(FIXED), output: FIXED }],
  ])('%s fails strictly, before anything runs', async (_label, response) => {
    const { runtime } = scripted([response]);
    const { access, calls } = fakeTools(both);
    await expect(buildSite(runtime, profile, plan, { tools: access })).rejects.toBeInstanceOf(MalformedModelOutput);
    expect(calls).toHaveLength(0);
  });
});
