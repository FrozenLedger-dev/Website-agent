/**
 * The semantic identity contract every Terra build and refinement is given.
 *
 * Offline: the provider is scripted. What is proven is that each call carries
 * exactly the pages it writes, with the harness's own IDs and exact values — and
 * that a call with no model is the build it always was.
 */
import { describe, expect, it } from 'vitest';
import { EditableSiteModel, type SitePlan } from '@statxai/contracts';
import { ModelRuntime, buildAnchor, buildPage, buildSite, refineSiteVisually, semanticIdentityBrief, type Provider, type ProviderRequest } from '../src/index.js';

const MODEL = EditableSiteModel.parse({
  schemaVersion: 'statxai-editable-site-model@1',
  projectId: 'proj_brief',
  sitePlan: { name: 'site-plan', version: 1 },
  provenance: { kind: 'site_plan', sitePlan: { name: 'site-plan', version: 1 } },
  design: {
    colors: { background: '#F4F1E8', surface: '#FFFFFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    radius: 'square',
    artDirection: 'a',
  },
  pages: [
    {
      pageId: 'pg_1111111111111111',
      route: '/',
      fields: [
        { fieldId: 'fld_1111111111111111', key: 'title', type: 'text', value: 'Harrowgate Joinery' },
        { fieldId: 'fld_1111111111111112', key: 'description', type: 'text', value: 'Fitted joinery.' },
      ],
      sections: [
        { sectionId: 'sec_1111111111111111', planKey: 'hero', layout: 'split-hero', visibility: 'visible', fields: [{ fieldId: 'fld_1111111111111113', key: 'heading', type: 'text', value: 'Fitted joinery, made here' }], blocks: [] },
        { sectionId: 'sec_1111111111111112', planKey: 'old', layout: 'rule-list', visibility: 'hidden', fields: [{ fieldId: 'fld_1111111111111114', key: 'heading', type: 'text', value: 'Hidden section' }], blocks: [] },
      ],
    },
    {
      pageId: 'pg_2222222222222222',
      route: '/services',
      fields: [
        { fieldId: 'fld_2222222222222221', key: 'title', type: 'text', value: 'Services' },
        { fieldId: 'fld_2222222222222222', key: 'description', type: 'text', value: 'What we make.' },
      ],
      sections: [
        {
          sectionId: 'sec_2222222222222221',
          planKey: 'list',
          layout: 'rule-list',
          visibility: 'visible',
          fields: [{ fieldId: 'fld_2222222222222223', key: 'heading', type: 'text', value: 'What we make' }],
          blocks: [{ blockId: 'blk_2222222222222221', kind: 'cta', visibility: 'visible', fields: [{ fieldId: 'fld_2222222222222224', key: 'action', type: 'cta', value: { label: 'Get a quote', href: '/contact' } }] }],
        },
      ],
    },
  ],
  assets: [],
  identity: { retired: [], minted: 0 },
});

const plan = { brandSystem: { artDirection: 'a' }, sitemap: { pages: [{ route: '/', title: 'Home', sections: [] }, { route: '/services', title: 'Services', sections: [] }] } } as unknown as SitePlan;
const OUTPUT = { files: [{ path: 'app/page.tsx', contents: 'x' }], notes: '' };

function scripted() {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    schemaDialect: 'strict',
    async complete(request) {
      requests.push(request);
      return { text: JSON.stringify(OUTPUT), model: request.model, inputTokens: 1, outputTokens: 1, stopReason: 'complete' };
    },
  };
  return { runtime: new ModelRuntime({ provider }), requests };
}

describe('the identity brief', () => {
  it('names every visible section, its exact heading, block fields and the page metadata — never a hidden one', () => {
    const brief = semanticIdentityBrief(MODEL, 'all');
    for (const text of ['data-statx-page-id', 'data-statx-section-id', 'data-statx-field-id', 'pg_1111111111111111', 'sec_1111111111111111', 'fld_1111111111111113', '"Fitted joinery, made here"', 'title = "Harrowgate Joinery"', 'blk_2222222222222221', 'fld_2222222222222224']) {
      expect(brief).toContain(text);
    }
    expect(brief).not.toContain('sec_1111111111111112');
    expect(brief).not.toContain('Hidden section');
    expect(brief).toMatch(/Never invent, rename, repeat or\s+omit a data-statx-\* attribute/);
    expect(semanticIdentityBrief(MODEL, ['/services'])).not.toContain('pg_1111111111111111');
  });

  it('reaches every build call shape with exactly the pages it writes', async () => {
    const site = scripted();
    await buildSite(site.runtime, {} as never, plan, { siteModel: MODEL });
    expect(site.requests[0]!.prompt).toContain('pg_1111111111111111');
    expect(site.requests[0]!.prompt).toContain('pg_2222222222222222');

    const anchor = scripted();
    await buildAnchor(anchor.runtime, {} as never, plan, { siteModel: MODEL });
    expect(anchor.requests[0]!.prompt).toContain('pg_1111111111111111');
    expect(anchor.requests[0]!.prompt).not.toContain('pg_2222222222222222');

    const page = scripted();
    await buildPage(page.runtime, {} as never, plan, plan.sitemap.pages[1]!, 'anchor', 'layout', { siteModel: MODEL });
    expect(page.requests[0]!.prompt).toContain('pg_2222222222222222');
    expect(page.requests[0]!.prompt).not.toContain('pg_1111111111111111');
  });

  it('a build with no model is exactly the build it always was', async () => {
    const { runtime, requests } = scripted();
    await buildSite(runtime, {} as never, plan);
    expect(requests[0]!.prompt).not.toMatch(/data-statx|SEMANTIC IDENTITY/);
  });

  it('a refinement is given the same identity to preserve, and told it may not change it', async () => {
    const { runtime, requests } = scripted();
    await refineSiteVisually(runtime, {
      profile: {} as never,
      plan,
      refinementCycle: 1,
      predecessor: { bindingId: 'b', sourceCommit: 'a'.repeat(40) },
      source: [],
      review: {
        ref: { name: 'visual-quality-review', version: 1 },
        screenshotSet: { name: 'screenshot-set', version: 1 },
        assessment: { overallScore: 60, scores: { composition: 60, typography: 60, spacingRhythm: 60, hierarchy: 60, brandDistinctiveness: 60, assetQuality: 60, conversionClarity: 60, mobileQuality: 60 }, summary: 's', routeReviews: [], strengths: [], issues: [], antiPatterns: [], refinementPriorities: [] },
      },
      frames: [],
      siteModel: MODEL,
    });
    expect(requests[0]!.prompt).toContain('sec_2222222222222221');
    expect(requests[0]!.system).toContain('Refinement changes presentation, never the site model');
  });
});
