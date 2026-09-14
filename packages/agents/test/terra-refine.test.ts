/**
 * Terra's bounded visual refinement, at the runtime and provider contract.
 *
 * Offline and deterministic: the provider is scripted and records every request.
 * What is proven is that `terra-refine` is its own Terra skill, crosses the model
 * runtime on every turn with one usage event each, carries the exact screenshots
 * and the exact review and source on every turn of its tool loop, and returns
 * nothing but a strict `BuildOutput`.
 */
import { describe, expect, it } from 'vitest';
import type { SitePlan, ToolResult } from '@statxai/contracts';
import {
  MODEL_SKILL_TIERS,
  MalformedModelOutput,
  ModelRuntime,
  TERRA_MAX_MODEL_TURNS,
  ToolLoopBudgetExhausted,
  refineSiteVisually,
  type ModelUsageEvent,
  type Provider,
  type ProviderRequest,
  type ToolAccess,
  type ToolRequest,
  type VisualRefinementInput,
} from '../src/index.js';

const PNG = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed]);

const plan = {
  brandSystem: { artDirection: 'workshop editorial' },
  sitemap: { pages: [{ route: '/', title: 'Home' }, { route: '/services', title: 'Services' }] },
} as unknown as SitePlan;

const input: VisualRefinementInput = {
  profile: { businessName: 'Harrowgate Joinery' } as never,
  plan,
  refinementCycle: 2,
  predecessor: { bindingId: 'frontend-backend-build-b1', sourceCommit: 'a'.repeat(40) },
  source: [
    { path: 'app/page.tsx', contents: 'export default function Home(){return <main>HOME-SOURCE-MARKER</main>}' },
    { path: 'app/services/page.tsx', contents: 'export default function S(){return <main/>}' },
  ],
  review: {
    ref: { name: 'visual-quality-review', version: 7, contentHash: 'b'.repeat(64) },
    screenshotSet: { name: 'screenshot-set', version: 5, contentHash: 'c'.repeat(64) },
    assessment: {
      overallScore: 58,
      scores: { composition: 52, typography: 61, spacingRhythm: 50, hierarchy: 60, brandDistinctiveness: 40, assetQuality: 55, conversionClarity: 70, mobileQuality: 45 },
      summary: 'Generic and stacked on mobile.',
      routeReviews: [],
      strengths: ['Clear phone number'],
      issues: [{ id: 'VQ-001', route: '/', viewports: ['mobile'], dimension: 'mobileQuality', severity: 'major', problem: 'Desktop stacked.', direction: 'Recompose for a phone.' }],
      antiPatterns: [{ pattern: 'three_equal_cards', route: '/services', viewports: ['desktop'] }],
      refinementPriorities: [{ rank: 1, dimension: 'composition', route: '/', direction: 'Break the centred hero.' }],
    },
  },
  frames: [
    { route: '/', viewport: 'desktop', index: 1, count: 1, offsetY: 0, sourceHeight: 900, png: PNG(1) },
    { route: '/', viewport: 'mobile', index: 1, count: 1, offsetY: 0, sourceHeight: 844, png: PNG(2) },
    { route: '/services', viewport: 'desktop', index: 1, count: 1, offsetY: 0, sourceHeight: 900, png: PNG(3) },
  ],
};

const OUTPUT = { files: [{ path: 'app/page.tsx', contents: 'refined' }, { path: 'app/services/page.tsx', contents: 'refined' }], notes: 'Recomposed the hero.' };

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

describe('terra-refine is its own Terra skill', () => {
  it('is registered at tier terra, distinct from terra-build and terra-review', () => {
    expect(MODEL_SKILL_TIERS['terra-refine']).toBe('terra');
    expect(MODEL_SKILL_TIERS['terra-review']).toBe('terra');
    expect(Object.keys(MODEL_SKILL_TIERS).filter((s) => s.startsWith('terra-')).sort()).toEqual(['terra-build', 'terra-edit', 'terra-refine', 'terra-review']);
  });

  it('crosses the model runtime once, as terra-refine, with one usage event, and returns the strict BuildOutput', async () => {
    const { runtime, requests, usage } = scripted([OUTPUT]);
    const result = await refineSiteVisually(runtime, input);

    expect(requests).toHaveLength(1);
    expect(usage).toEqual([expect.objectContaining({ skill: 'terra-refine', tier: 'terra', invocationId: result.invocationId })]);
    expect(result.skill).toBe('terra-refine');
    expect(result.value).toEqual(OUTPUT);
  });

  it('refuses anything that is not a strict BuildOutput: a review-shaped answer is malformed', async () => {
    const { runtime } = scripted([input.review.assessment]);
    await expect(refineSiteVisually(runtime, input)).rejects.toBeInstanceOf(MalformedModelOutput);
  });
});

describe('the refinement sees exactly the evidence that triggered it', () => {
  it('sends every frame as a labelled image, and names the exact review, screenshot set, cycle, source, scores, issues, priorities and patterns', async () => {
    const { runtime, requests } = scripted([OUTPUT]);
    await refineSiteVisually(runtime, input);
    const request = requests[0]!;

    expect(request.images?.map((i) => Buffer.from(i.data))).toEqual(input.frames.map((f) => f.png));
    expect(request.images?.map((i) => i.label)).toEqual([
      'IMAGE 1: / @ desktop — frame 1 of 1, from y=0px of a 900px page',
      'IMAGE 2: / @ mobile — frame 1 of 1, from y=0px of a 844px page',
      'IMAGE 3: /services @ desktop — frame 1 of 1, from y=0px of a 900px page',
    ]);
    expect(request.prompt).toContain('Visual refinement 2 of build frontend-backend-build-b1');
    expect(request.prompt).toContain(`source commit ${'a'.repeat(40)}`);
    expect(request.prompt).toContain('Triggered by visual-quality-review@7 of screenshot-set@5');
    expect(request.prompt).toContain('HOME-SOURCE-MARKER');
    expect(request.prompt).toContain('overall 58');
    expect(request.prompt).toContain('VQ-001 [major mobileQuality]');
    expect(request.prompt).toContain('1. composition on / — Break the centred hero.');
    expect(request.prompt).toContain('three_equal_cards on /services');
    expect(request.prompt).toContain('/services  →  app/services/page.tsx');
    expect(request.system).toContain('Preserve the routes exactly');
    expect(request.system).toContain('A file you leave out is removed from the site');
  });

  it('carries the same images and evidence on every stateless turn of its tool loop, not only the first', async () => {
    const { runtime, requests, usage } = scripted([
      { action: 'tool', tool: 'filesystem', input: { path: 'components/ui/card.tsx' }, output: null },
      { action: 'tool', tool: 'test_runner', input: { candidate: OUTPUT }, output: null },
      { action: 'final', tool: null, input: null, output: OUTPUT },
    ]);
    const { tools, calls } = access(['filesystem', 'test_runner']);

    const result = await refineSiteVisually(runtime, input, { tools });

    expect(result.value).toEqual(OUTPUT);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.images?.map((i) => Buffer.from(i.data))).toEqual(input.frames.map((f) => f.png));
      expect(request.prompt).toContain('HOME-SOURCE-MARKER');
      expect(request.prompt).toContain('VQ-001');
    }
    // One usage event per model invocation; the tools themselves add none.
    expect(usage).toHaveLength(3);
    expect(usage.every((u) => u.skill === 'terra-refine')).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(['filesystem', 'test_runner']);
  });
});

describe('tools stay exactly the build grant, and bounded', () => {
  it('describes and executes only filesystem and test_runner, whatever else is granted', async () => {
    const { runtime, requests } = scripted([{ action: 'final', tool: null, input: null, output: OUTPUT }]);
    const { tools } = access(['filesystem', 'test_runner', 'browser_preview' as never, 'git' as never]);
    await refineSiteVisually(runtime, input, { tools });
    expect(requests[0]!.prompt).toContain('"tool":"filesystem"');
    expect(requests[0]!.prompt).toContain('"tool":"test_runner"');
    expect(requests[0]!.prompt).not.toMatch(/browser_preview|"tool":"git"|shell|deploy/);
  });

  it('a model asking for a tool it was not granted is malformed: the action schema has no such tool', async () => {
    const { runtime } = scripted([{ action: 'tool', tool: 'browser_preview', input: { url: 'http://x' }, output: null }]);
    const { tools, calls } = access(['filesystem', 'test_runner']);
    await expect(refineSiteVisually(runtime, input, { tools })).rejects.toBeInstanceOf(MalformedModelOutput);
    expect(calls).toEqual([]);
  });

  it('is bounded by the same turn limit as a build: a model that never answers stops', async () => {
    let n = 0;
    const answers = Array.from({ length: TERRA_MAX_MODEL_TURNS + 2 }, () => ({ action: 'tool', tool: 'filesystem', input: { path: `components/ui/f${(n += 1)}.tsx` }, output: null }));
    const { runtime, requests } = scripted(answers);
    const { tools } = access(['filesystem', 'test_runner']);
    await expect(refineSiteVisually(runtime, input, { tools })).rejects.toBeInstanceOf(ToolLoopBudgetExhausted);
    expect(requests.length).toBeLessThanOrEqual(TERRA_MAX_MODEL_TURNS);
  });

  it('a passing advisory test is never the answer: only a final action returns a build output', async () => {
    const { runtime } = scripted([
      { action: 'tool', tool: 'test_runner', input: { candidate: OUTPUT }, output: null },
      { action: 'final', tool: null, input: null, output: { ...OUTPUT, notes: 'final' } },
    ]);
    const { tools } = access(['test_runner']);
    const result = await refineSiteVisually(runtime, input, { tools });
    expect(result.value.notes).toBe('final');
  });
});
