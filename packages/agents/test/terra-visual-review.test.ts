/**
 * Terra's multimodal visual review, at the runtime and provider contract.
 *
 * Offline and deterministic: the provider is scripted, and the OpenAI provider is
 * given a fake SDK client that records the exact request it would send — so what
 * is proven is that real image bytes, not a description of them, reach the
 * vendor request, through the one runtime path, with one usage event.
 */
import { describe, expect, it, vi } from 'vitest';
import { VisualQualityAssessment, toStrictModelSchema, type SitePlan } from '@statxai/contracts';
import {
  MalformedModelOutput,
  ModelClient,
  ModelRefusal,
  ModelRuntime,
  OpenAiProvider,
  reviewVisualQuality,
  userContent,
  type ModelUsageEvent,
  type Provider,
  type ProviderRequest,
  type VisualReviewImage,
} from '../src/index.js';

const PNG = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2]);

const profile = { businessName: 'Harrowgate Joinery', industry: 'Joinery', location: 'Harrogate', audience: 'Homeowners', tone: 'Warm' } as never;
const plan = {
  brandSystem: { artDirection: 'workshop editorial' },
  sitemap: { pages: [{ route: '/', title: 'Home', goal: 'enquiries', primaryAction: 'call' }, { route: '/services', title: 'Services', goal: 'explain', primaryAction: 'quote' }] },
} as unknown as SitePlan;

const frames: VisualReviewImage[] = [
  { route: '/', viewport: 'desktop', index: 1, count: 1, offsetY: 0, sourceHeight: 900, png: PNG(1) },
  { route: '/', viewport: 'tablet', index: 1, count: 1, offsetY: 0, sourceHeight: 1024, png: PNG(2) },
  { route: '/', viewport: 'mobile', index: 1, count: 2, offsetY: 0, sourceHeight: 1600, png: PNG(3) },
  { route: '/', viewport: 'mobile', index: 2, count: 2, offsetY: 756, sourceHeight: 1600, png: PNG(4) },
  { route: '/services', viewport: 'desktop', index: 1, count: 1, offsetY: 0, sourceHeight: 900, png: PNG(5) },
];

const ASSESSMENT = {
  overallScore: 64,
  scores: { composition: 60, typography: 70, spacingRhythm: 55, hierarchy: 66, brandDistinctiveness: 48, assetQuality: 58, conversionClarity: 75, mobileQuality: 62 },
  summary: 'Competent but generic.',
  routeReviews: [{ route: '/', viewports: ['desktop', 'mobile'], score: 62, summary: 'Centred hero.' }],
  strengths: ['Clear primary action'],
  issues: [{ id: 'VQ-001', route: '/', viewports: ['mobile'], dimension: 'mobileQuality', severity: 'major', problem: 'Desktop stacked.', direction: 'Recompose for a phone.' }],
  antiPatterns: [{ pattern: 'generic_centered_hero', route: '/', viewports: ['desktop'] }],
  refinementPriorities: [{ rank: 1, dimension: 'brandDistinctiveness', direction: 'Give the hero a workshop identity.' }],
};

function scripted(answer: unknown | (() => never)) {
  const requests: ProviderRequest[] = [];
  const usage: ModelUsageEvent[] = [];
  const provider: Provider = {
    name: 'scripted',
    schemaDialect: 'strict',
    async complete(request) {
      requests.push(request);
      if (typeof answer === 'function') return (answer as () => never)();
      if (answer && typeof answer === 'object' && 'stopReason' in (answer as object)) {
        return { text: '', model: request.model, inputTokens: 1, outputTokens: 1, ...(answer as object) } as never;
      }
      return { text: JSON.stringify(answer), model: request.model, inputTokens: 900, outputTokens: 300, stopReason: 'complete' };
    },
  };
  return { runtime: new ModelRuntime({ provider, onUsage: (e) => usage.push(e) }), requests, usage };
}

const input = () => ({ profile, plan, frames, missing: [{ route: '/services', viewport: 'mobile' as const, reason: 'render_not_ready' as const }], notReviewed: [], browserFindings: [] });

describe('the multimodal review invocation', () => {
  it('sends every frame as an image, in order and labelled with its route, viewport and position, through one runtime invocation', async () => {
    const { runtime, requests, usage } = scripted(ASSESSMENT);

    const result = await reviewVisualQuality(runtime, input());

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.images?.map((i) => Buffer.from(i.data))).toEqual(frames.map((f) => f.png));
    expect(request.images?.map((i) => i.label)).toEqual([
      'IMAGE 1: / @ desktop — frame 1 of 1, from y=0px of a 900px page',
      'IMAGE 2: / @ tablet — frame 1 of 1, from y=0px of a 1024px page',
      'IMAGE 3: / @ mobile — frame 1 of 2, from y=0px of a 1600px page',
      'IMAGE 4: / @ mobile — frame 2 of 2, from y=756px of a 1600px page',
      'IMAGE 5: /services @ desktop — frame 1 of 1, from y=0px of a 900px page',
    ]);
    expect(request.images?.every((i) => i.mediaType === 'image/png')).toBe(true);
    expect(request.prompt).toContain('/services @ mobile (no screenshot: render_not_ready)');
    expect(request.schemaName).toBe('terra_visual-review');
    expect(request.schema).toEqual(toStrictModelSchema(VisualQualityAssessment));

    expect(result.value).toEqual(ASSESSMENT);
    expect([result.skill, result.tier]).toEqual(['terra-review', 'terra']);
    // One invocation, however many images: one usage event, from the runtime alone.
    expect(usage).toEqual([expect.objectContaining({ skill: 'terra-review', tier: 'terra', inputTokens: 900, outputTokens: 300, invocationId: result.invocationId })]);
  });

  it('asks for all eight scores and the template patterns, and names nothing executable', async () => {
    const { runtime, requests } = scripted(ASSESSMENT);
    await reviewVisualQuality(runtime, input());
    const { system } = requests[0]!;
    for (const dimension of ['composition', 'typography', 'spacingRhythm', 'hierarchy', 'brandDistinctiveness', 'assetQuality', 'conversionClarity', 'mobileQuality']) {
      expect(system).toContain(`- ${dimension}:`);
    }
    for (const pattern of ['generic_centered_hero', 'three_equal_cards', 'cards_everywhere', 'repetitive_icon_circles', 'arbitrary_gradients', 'unnecessary_pills', 'all_centered_composition', 'uniform_spacing', 'oversized_heading_without_composition', 'mobile_is_stacked_desktop']) {
      expect(system).toContain(pattern);
    }
    const properties = Object.keys((requests[0]!.schema as { properties: Record<string, unknown> }).properties).sort();
    expect(properties).toEqual(['antiPatterns', 'issues', 'overallScore', 'refinementPriorities', 'routeReviews', 'scores', 'strengths', 'summary']);
    expect(JSON.stringify(requests[0]!.schema)).not.toMatch(/"files"|"contents"|"tool"|"action"/);
  });

  it.each([
    ['a score above 100', { ...ASSESSMENT, scores: { ...ASSESSMENT.scores, composition: 101 } }],
    ['an overall score below 0', { ...ASSESSMENT, overallScore: -1 }],
    ['a missing mobileQuality score', { ...ASSESSMENT, scores: { ...ASSESSMENT.scores, mobileQuality: undefined } }],
    ['a missing brandDistinctiveness score', { ...ASSESSMENT, scores: { ...ASSESSMENT.scores, brandDistinctiveness: undefined } }],
    ['a build output instead of a review', { files: [{ path: 'app/page.tsx', contents: 'x' }], notes: 'n' }],
    ['an unknown dimension', { ...ASSESSMENT, issues: [{ ...ASSESSMENT.issues[0], dimension: 'vibes' }] }],
  ])('rejects %s as malformed', async (_label, answer) => {
    const { runtime } = scripted(answer);
    await expect(reviewVisualQuality(runtime, input())).rejects.toBeInstanceOf(MalformedModelOutput);
  });

  it('a refusal stays a refusal, and a provider failure stays that failure', async () => {
    await expect(reviewVisualQuality(scripted({ stopReason: 'refusal', refusalCategory: 'policy' }).runtime, input())).rejects.toBeInstanceOf(ModelRefusal);
    const failure = new Error('provider unavailable');
    await expect(reviewVisualQuality(scripted(() => { throw failure; }).runtime, input())).rejects.toBe(failure);
  });

  it('a truncated answer is retried once with the same images', async () => {
    let calls = 0;
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
      name: 'scripted',
      schemaDialect: 'strict',
      async complete(request) {
        requests.push(request);
        calls += 1;
        return calls === 1
          ? { text: '', model: 'm', inputTokens: 1, outputTokens: 1, stopReason: 'truncated' }
          : { text: JSON.stringify(ASSESSMENT), model: 'm', inputTokens: 1, outputTokens: 1, stopReason: 'complete' };
      },
    };
    await new ModelClient(provider).call({ tier: 'terra', label: 'terra:visual-review', system: 's', prompt: 'p', images: [{ label: 'a', mediaType: 'image/png', data: PNG(9) }], schema: VisualQualityAssessment });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.images).toEqual(requests[0]!.images);
  });
});

describe('the OpenAI provider request', () => {
  function recordingClient() {
    const create = vi.fn(async (_body: unknown) => ({
      model: 'gpt-5.6-terra',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(ASSESSMENT), refusal: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    return { client: { chat: { completions: { create } } } as never, create };
  }

  it('carries each image as a high-detail base64 data URL of the exact PNG bytes, after its label', async () => {
    const { client, create } = recordingClient();
    const bytes = PNG(42);
    await new OpenAiProvider(client).complete({
      model: 'gpt-5.6-terra', system: 'sys', prompt: 'Review.', schema: {}, schemaName: 'terra_visual-review', maxTokens: 100, effort: 'high',
      images: [{ label: 'IMAGE 1: / @ desktop', mediaType: 'image/png', data: bytes }],
    });

    const body = create.mock.calls[0]![0] as { messages: { role: string; content: unknown }[] };
    const user = body.messages.find((m) => m.role === 'user')!;
    expect(user.content).toEqual([
      { type: 'text', text: 'Review.' },
      { type: 'text', text: 'IMAGE 1: / @ desktop' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'high' } },
    ]);
    const url = ((user.content as { image_url?: { url: string } }[])[2]!.image_url!.url);
    expect(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64').equals(bytes)).toBe(true);
  });

  it('keeps a text-only request exactly as it was: a plain string user message', async () => {
    const { client, create } = recordingClient();
    await new OpenAiProvider(client).complete({ model: 'm', system: 'sys', prompt: 'Plan.', schema: {}, schemaName: 'sol_plan', maxTokens: 100, effort: 'high' });
    const body = create.mock.calls[0]![0] as { messages: { role: string; content: unknown }[] };
    expect(body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'Plan.' }]);
    expect(userContent('Plan.', [])).toBe('Plan.');
  });
});
