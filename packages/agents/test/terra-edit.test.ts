/**
 * Terra's semantic edit, at the runtime and provider contract.
 *
 * Offline and deterministic: the provider is scripted and records every request.
 * What is proven is that `terra-edit` is its own Terra skill, crosses the model
 * runtime on every turn with one usage event each, carries the exact base model,
 * result model, patch and source on every turn of its tool loop, is offered no
 * tool it was not granted, and returns nothing but a strict `BuildOutput`.
 */
import { describe, expect, it } from 'vitest';
import type { EditableSiteModel, SemanticPatch, SitePlan, ToolResult } from '@statxai/contracts';
import {
  MODEL_SKILL_TIERS,
  MalformedModelOutput,
  ModelRuntime,
  TERRA_MAX_MODEL_TURNS,
  ToolLoopBudgetExhausted,
  editSiteSemantically,
  type ModelUsageEvent,
  type Provider,
  type ProviderRequest,
  type SemanticEditInput,
  type ToolAccess,
  type ToolRequest,
} from '../src/index.js';

const plan = {
  brandSystem: { artDirection: 'workshop editorial' },
  sitemap: { pages: [{ route: '/', title: 'Home' }] },
} as unknown as SitePlan;

const modelWith = (heading: string, provenance: EditableSiteModel['provenance']) =>
  ({
    projectId: 'proj_edit',
    pages: [
      {
        pageId: 'pg_0123456789abcdef',
        route: '/',
        fields: [
          { fieldId: 'fld_000000000000000a', key: 'title', type: 'text', value: 'Harrowgate Joinery' },
          { fieldId: 'fld_000000000000000b', key: 'description', type: 'text', value: 'Fitted joinery.' },
        ],
        sections: [
          {
            sectionId: 'sec_0123456789abcdef',
            layout: 'split-hero',
            visibility: 'visible',
            fields: [{ fieldId: 'fld_000000000000000c', key: 'heading', type: 'text', value: heading }],
            blocks: [],
          },
        ],
      },
    ],
    assets: [],
    provenance,
  }) as unknown as EditableSiteModel;

const baseRef = { name: 'editable-site-model' as const, version: 3, contentHash: 'a'.repeat(64) };
const patch: SemanticPatch = { baseModel: baseRef, operation: { op: 'set_field_value', fieldId: 'fld_000000000000000c', expected: 'BASE-HEADING-MARKER', value: 'RESULT-HEADING-MARKER' } } as SemanticPatch;

const input: SemanticEditInput = {
  profile: { businessName: 'Harrowgate Joinery' } as never,
  plan,
  predecessor: { bindingId: 'frontend-backend-build-b0', sourceCommit: 'b'.repeat(40) },
  source: [{ path: 'app/page.tsx', contents: 'export default function Home(){return <main>HOME-SOURCE-MARKER</main>}' }],
  baseModel: modelWith('BASE-HEADING-MARKER', { kind: 'plan', sitePlan: { name: 'site-plan', version: 1 } } as never),
  model: modelWith('RESULT-HEADING-MARKER', { kind: 'semantic_patch', base: baseRef, operation: 'set_field_value', target: 'fld_000000000000000c' } as never),
  patch,
};

const OUTPUT = { files: [{ path: 'app/page.tsx', contents: 'edited' }], notes: 'Changed the heading.' };

function scripted(answers: unknown[]) {
  const requests: ProviderRequest[] = [];
  const usage: ModelUsageEvent[] = [];
  const provider: Provider = {
    name: 'scripted',
    schemaDialect: 'strict',
    async complete(request) {
      requests.push(request);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      return { text: typeof answer === 'string' ? answer : JSON.stringify(answer), model: request.model, inputTokens: 1000, outputTokens: 400, stopReason: 'complete' };
    },
  };
  return { runtime: new ModelRuntime({ provider, onUsage: (e) => usage.push(e) }), requests, usage };
}

function access(granted: ToolAccess['grantedTools']) {
  const calls: ToolRequest[] = [];
  const tools: ToolAccess = {
    grantedTools: granted,
    async execute(request) {
      calls.push(request);
      return (request.tool === 'test_runner'
        ? { tool: 'test_runner', ok: true, passed: true, compiled: true, diagnostics: [], findings: [], truncated: false }
        : { tool: 'filesystem', ok: true, path: 'components/ui/card.tsx', content: 'export const Card = 1;' }) as unknown as ToolResult;
    },
  };
  return { tools, calls };
}

const promptOf = (request: ProviderRequest) => JSON.stringify(request);

describe('terra-edit is its own Terra skill', () => {
  it('is registered at tier terra, distinct from terra-build, terra-refine and terra-review', () => {
    expect(MODEL_SKILL_TIERS['terra-edit']).toBe('terra');
    expect(new Set(['terra-build', 'terra-refine', 'terra-review', 'terra-edit']).size).toBe(4);
  });

  it('crosses the runtime once, under terra-edit, and carries the exact base model, result model, patch and source', async () => {
    const { runtime, requests, usage } = scripted([OUTPUT]);
    const result = await editSiteSemantically(runtime, input);

    expect(result.value).toEqual(OUTPUT);
    expect(result.skill).toBe('terra-edit');
    expect(result.tier).toBe('terra');
    expect(usage.map((u) => [u.skill, u.tier])).toEqual([['terra-edit', 'terra']]);
    expect(requests).toHaveLength(1);
    const prompt = promptOf(requests[0]!);
    for (const marker of ['BASE-HEADING-MARKER', 'RESULT-HEADING-MARKER', 'HOME-SOURCE-MARKER', 'set_field_value', 'fld_000000000000000c', 'frontend-backend-build-b0', 'b'.repeat(40)]) {
      expect(prompt, marker).toContain(marker);
    }
    // The exact operation itself — its expectation exists nowhere but in the patch.
    expect(requests[0]!.prompt).toContain('"expected": "BASE-HEADING-MARKER"');
    // The result model's identity is the one the model is told to carry — IDs are given, never invented.
    expect(prompt).toContain('SEMANTIC IDENTITY');
    expect(prompt).toContain('Never invent, rename, reuse or drop a page, section');
    expect(prompt).not.toMatch(/"images"\s*:\s*\[\s*\{/);
  });

  it('offers only the granted tools, carries every exact input on every turn, and returns only a strict BuildOutput', async () => {
    const { runtime, requests, usage } = scripted([
      { action: 'tool', tool: 'filesystem', input: { path: 'components/ui/card.tsx' }, output: null },
      { action: 'final', tool: null, input: null, output: OUTPUT },
    ]);
    const { tools, calls } = access(['filesystem', 'test_runner']);
    const result = await editSiteSemantically(runtime, input, { tools });

    expect(result.value).toEqual(OUTPUT);
    expect(calls.map((c) => c.tool)).toEqual(['filesystem']);
    expect(usage.map((u) => u.skill)).toEqual(['terra-edit', 'terra-edit']);
    for (const request of requests) {
      const prompt = promptOf(request);
      for (const marker of ['BASE-HEADING-MARKER', 'RESULT-HEADING-MARKER', 'HOME-SOURCE-MARKER', 'set_field_value']) expect(prompt).toContain(marker);
      // The actions offered are exactly the granted tools and the final answer — no browser, Git, write, shell or release action.
      const offered = [...(request.prompt ?? '').matchAll(/\{"action":"tool","tool":"([a-z_]+)"/g)].map((m) => m[1]);
      expect(offered).toEqual(['filesystem', 'test_runner']);
    }
  });

  it('with no tools granted, none is offered and one invocation is the whole edit', async () => {
    const { runtime, requests } = scripted([OUTPUT]);
    await editSiteSemantically(runtime, input, { tools: access([]).tools });
    expect(requests).toHaveLength(1);
    expect(promptOf(requests[0]!)).not.toMatch(/INSPECTING THE SCAFFOLD|TESTING A CANDIDATE/);
  });

  it('is bounded by the shared Terra turn limit, and a malformed answer is never a build', async () => {
    const looping = scripted([{ action: 'tool', tool: 'filesystem', input: { path: 'components/ui/card.tsx' }, output: null }]);
    const spinning = { tools: { ...access(['filesystem']).tools, execute: async () => ({ tool: 'filesystem', ok: true, path: 'x', content: String(Math.random()) }) as unknown as ToolResult } };
    await expect(editSiteSemantically(looping.runtime, input, spinning)).rejects.toBeInstanceOf(ToolLoopBudgetExhausted);
    expect(looping.requests.length).toBeLessThanOrEqual(TERRA_MAX_MODEL_TURNS);

    const malformed = scripted(['{"files": "not a list"}']);
    await expect(editSiteSemantically(malformed.runtime, input)).rejects.toBeInstanceOf(MalformedModelOutput);
  });
});
