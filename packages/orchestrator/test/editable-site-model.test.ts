/**
 * The editable site model: contract, harness-owned identity, replan
 * reconciliation, semantic patches and the site-model gate — pure and offline.
 */
import { describe, expect, it } from 'vitest';
import {
  EDITABLE_SITE_MODEL_ARTIFACT,
  EditableSiteModel,
  SITE_MODEL_MARKERS,
  type ArtifactRef,
  type SemanticPatch,
  type SitePlan,
} from '@statxai/contracts';
import { siteModelMarkerFindings } from '@statxai/gates';
import { contentHash } from '@statxai/workspace';
import { EditableSiteModelUnconstructible, modelFromPlan, reconcileModelWithPlan } from '../src/site-model/materialize.js';
import { SemanticPatchRejected, applySemanticPatch } from '../src/site-model/patch.js';
import { derivedId, usedIds } from '../src/site-model/identity.js';
import { exportForModel } from './support/site-model-export.js';

const section = (id: string, heading: string, layout = 'split-hero') => ({ id, heading, purpose: 'p', layout, contentBindings: [] });
const page = (route: string, title: string, sections: ReturnType<typeof section>[]) => ({ route, title, metaDescription: `${title} description`, goal: 'g', primaryAction: 'call', sections });
const plan = (pages: ReturnType<typeof page>[], over: Partial<SitePlan['brandSystem']> = {}): SitePlan =>
  ({
    strategy: 's',
    valueProposition: 'v',
    brandSystem: {
      palette: { background: '#F4F1E8', surface: '#FFFFFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
      typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
      artDirection: 'Trade-signage directness.',
      radius: 'square',
      rationale: 'r',
      ...over,
    },
    sitemap: { pages },
    acceptanceCriteria: ['a', 'b', 'c'],
  }) as unknown as SitePlan;

const P0 = plan([
  page('/', 'Harrowgate Joinery', [section('hero', 'Fitted joinery, made here'), section('services', 'What we make', 'rule-list'), section('contact', 'Talk to the workshop', 'contact-panel')]),
  page('/about', 'About', [section('story', 'Two joiners, one workshop', 'editorial-split')]),
]);
const planRef = (version: number): ArtifactRef => ({ name: 'site-plan', version, contentHash: String(version).repeat(64).slice(0, 64) });
const M0 = modelFromPlan({ projectId: 'proj_model', sitePlanRef: planRef(1), plan: P0 });
const M0_REF: ArtifactRef = { name: EDITABLE_SITE_MODEL_ARTIFACT, version: 1, contentHash: contentHash(M0) };

const home = (m: EditableSiteModel) => m.pages.find((p) => p.route === '/')!;
const sectionByKey = (m: EditableSiteModel, key: string) => m.pages.flatMap((p) => p.sections).find((s) => s.planKey === key)!;
const heading = (m: EditableSiteModel, key: string) => sectionByKey(m, key).fields[0]!;
const patch = (operation: SemanticPatch['operation'], baseModel: ArtifactRef = M0_REF) => ({ baseModel, operation }) as SemanticPatch;
const apply = (operation: SemanticPatch['operation'], base: EditableSiteModel = M0, baseRef: ArtifactRef = M0_REF) => applySemanticPatch({ baseRef, base, patch: patch(operation, baseRef) });
const rejectedWith = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SemanticPatchRejected) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
};
const clone = <T>(value: T): T => structuredClone(value);

describe('identity', () => {
  it('every ID is typed, opaque and unique across pages, sections, fields and assets', () => {
    const ids = [...usedIds(M0)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of M0.pages) {
      expect(p.pageId).toMatch(/^pg_[a-f0-9]{16}$/);
      for (const f of p.fields) expect(f.fieldId).toMatch(/^fld_[a-f0-9]{16}$/);
      for (const s of p.sections) {
        expect(s.sectionId).toMatch(/^sec_[a-f0-9]{16}$/);
        expect(s.fields[0]!.fieldId).toMatch(/^fld_[a-f0-9]{16}$/);
      }
    }
    // Opaque: no route, key, heading or index is readable from an ID.
    expect(JSON.stringify(ids)).not.toMatch(/hero|about|services|joinery|_0\b|_1\b/i);
  });

  it('is derived from semantic keys, never from array position: the same plan with its pages and sections reordered yields the same IDs', () => {
    const reordered = plan([
      page('/about', 'About', [section('story', 'Two joiners, one workshop', 'editorial-split')]),
      page('/', 'Harrowgate Joinery', [section('contact', 'Talk to the workshop', 'contact-panel'), section('hero', 'Fitted joinery, made here'), section('services', 'What we make', 'rule-list')]),
    ]);
    const other = modelFromPlan({ projectId: 'proj_model', sitePlanRef: planRef(1), plan: reordered });
    for (const key of ['hero', 'services', 'contact', 'story']) {
      expect(sectionByKey(other, key).sectionId).toBe(sectionByKey(M0, key).sectionId);
      expect(heading(other, key).fieldId).toBe(heading(M0, key).fieldId);
    }
    expect(home(other).pageId).toBe(home(M0).pageId);
  });

  it('does not depend on display text: different headings and titles keep every ID', () => {
    const retitled = plan([
      page('/', 'Another title', [section('hero', 'Different words'), section('services', 'Other words', 'rule-list'), section('contact', 'More words', 'contact-panel')]),
      page('/about', 'About us', [section('story', 'A new story', 'editorial-split')]),
    ]);
    expect([...usedIds(modelFromPlan({ projectId: 'proj_model', sitePlanRef: planRef(1), plan: retitled }))].sort()).toEqual([...usedIds(M0)].sort());
  });

  it('is deterministic, project-scoped, and never a source path or DOM position', () => {
    expect(modelFromPlan({ projectId: 'proj_model', sitePlanRef: planRef(1), plan: P0 })).toEqual(M0);
    expect(home(modelFromPlan({ projectId: 'proj_other', sitePlanRef: planRef(1), plan: P0 })).pageId).not.toBe(home(M0).pageId);
    expect(derivedId('proj_model', 'sec', home(M0).pageId, 'hero')).toBe(sectionByKey(M0, 'hero').sectionId);
    expect(JSON.stringify(M0)).not.toMatch(/page\.tsx|nth-child|:nth|\[\d+\]/);
  });
});

describe('the model contract', () => {
  it('a model materialised from an exact plan parses, binds to that exact plan, and carries its typed design tokens', () => {
    expect(EditableSiteModel.parse(M0)).toEqual(M0);
    expect(M0.sitePlan).toEqual(planRef(1));
    expect(M0.provenance).toEqual({ kind: 'site_plan', sitePlan: planRef(1) });
    expect(M0.design).toEqual({
      colors: { background: '#F4F1E8', surface: '#FFFFFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
      typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
      radius: 'square',
      artDirection: 'Trade-signage directness.',
    });
    expect(heading(M0, 'hero').value).toBe('Fitted joinery, made here');
    expect(home(M0).fields.map((f) => [f.key, f.value])).toEqual([['title', 'Harrowgate Joinery'], ['description', 'Harrowgate Joinery description']]);
  });

  it.each([
    ['a duplicate ID', (m: EditableSiteModel) => { m.pages[1]!.sections[0]!.sectionId = m.pages[0]!.sections[0]!.sectionId; }],
    ['a duplicate field ID', (m: EditableSiteModel) => { m.pages[1]!.fields[0]!.fieldId = m.pages[0]!.fields[0]!.fieldId; }],
    ['an invalid route', (m: EditableSiteModel) => { m.pages[1]!.route = '/About Us'; }],
    ['two pages on one route', (m: EditableSiteModel) => { m.pages[1]!.route = '/'; }],
    ['no homepage', (m: EditableSiteModel) => { m.pages[0]!.route = '/home'; }],
    ['a mistyped ID', (m: EditableSiteModel) => { m.pages[0]!.pageId = 'sec_0123456789abcdef'; }],
    ['a section without its heading field', (m: EditableSiteModel) => { m.pages[0]!.sections[0]!.fields[0]!.key = 'title'; }],
    ['a dangling asset reference', (m: EditableSiteModel) => {
      m.pages[0]!.sections[0]!.blocks.push({ blockId: 'blk_0000000000000001', kind: 'image', visibility: 'visible', fields: [{ fieldId: 'fld_0000000000000001', key: 'image', type: 'asset', value: 'ast_0000000000000009' }, { fieldId: 'fld_0000000000000002', key: 'alt', type: 'text', value: 'x' }] });
    }],
    ['a block whose fields do not match its kind', (m: EditableSiteModel) => {
      m.pages[0]!.sections[0]!.blocks.push({ blockId: 'blk_0000000000000001', kind: 'card', visibility: 'visible', fields: [{ fieldId: 'fld_0000000000000001', key: 'body', type: 'text', value: 'x' }] });
    }],
    ['a retired ID still in use', (m: EditableSiteModel) => { m.identity.retired = [m.pages[0]!.pageId]; }],
    ['a free CSS declaration as a colour', (m: EditableSiteModel) => { m.design.colors.accent = 'red; background: url(x)'; }],
    ['a font stack as a family', (m: EditableSiteModel) => { m.design.typography.headingFamily = '"Fraunces", serif'; }],
    ['an unknown design field', (m: EditableSiteModel) => { (m.design as Record<string, unknown>).css = 'body{}'; }],
    ['an unknown section field', (m: EditableSiteModel) => { (m.pages[0]!.sections[0] as Record<string, unknown>).style = 'margin:0'; }],
    ['a javascript: CTA link', (m: EditableSiteModel) => {
      m.pages[0]!.sections[0]!.blocks.push({ blockId: 'blk_0000000000000001', kind: 'cta', visibility: 'visible', fields: [{ fieldId: 'fld_0000000000000001', key: 'action', type: 'cta', value: { label: 'Go', href: 'javascript:alert(1)' } }] });
    }],
  ])('rejects %s', (_label, corrupt) => {
    const m = clone(M0);
    corrupt(m);
    expect(EditableSiteModel.safeParse(m).success).toBe(false);
  });

  it('a plan that cannot be expressed as a model is refused, never coerced', () => {
    expect(() => modelFromPlan({ projectId: 'p', sitePlanRef: planRef(1), plan: plan(P0.sitemap.pages as never, { palette: { ...P0.brandSystem.palette, accent: 'red; x: y' } }) })).toThrow(EditableSiteModelUnconstructible);
    const duplicateKeys = plan([page('/', 'Home', [section('hero', 'A'), section('hero', 'B', 'rule-list')])]);
    expect(() => modelFromPlan({ projectId: 'p', sitePlanRef: planRef(1), plan: duplicateKeys })).toThrow(EditableSiteModelUnconstructible);
  });
});

describe('replan reconciliation', () => {
  const P1 = plan([
    page('/', 'Harrowgate Joinery', [section('services', 'What we make now', 'feature-grid'), section('hero', 'Fitted joinery, made here'), section('faq', 'Questions', 'faq-accordion')]),
    page('/workshop', 'Workshop', [section('story', 'Two joiners, one workshop', 'editorial-split')]),
  ]);
  const M1 = reconcileModelWithPlan({ base: M0, baseRef: M0_REF, sitePlanRef: planRef(2), plan: P1 });

  it('surviving pages and sections keep identity; planned attributes take the revised plan’s values', () => {
    expect(home(M1).pageId).toBe(home(M0).pageId);
    expect(sectionByKey(M1, 'hero').sectionId).toBe(sectionByKey(M0, 'hero').sectionId);
    expect(sectionByKey(M1, 'services').sectionId).toBe(sectionByKey(M0, 'services').sectionId);
    expect(heading(M1, 'services').fieldId).toBe(heading(M0, 'services').fieldId);
    expect(sectionByKey(M1, 'services')).toMatchObject({ layout: 'feature-grid', fields: [{ value: 'What we make now' }] });
    expect(M1.provenance).toEqual({ kind: 'replan', base: M0_REF, sitePlan: planRef(2) });
    expect(M1.sitePlan).toEqual(planRef(2));
  });

  it('new objects get new identity; removed ones are retired with everything they contained; a replaced route is a new page', () => {
    const removed = [sectionByKey(M0, 'contact').sectionId, heading(M0, 'contact').fieldId, M0.pages[1]!.pageId, sectionByKey(M0, 'story').sectionId];
    for (const id of removed) expect(M1.identity.retired).toContain(id);
    expect(M1.pages[1]!.pageId).not.toBe(M0.pages[1]!.pageId);
    expect(usedIds(M1).has(sectionByKey(M1, 'faq').sectionId)).toBe(true);
    for (const id of usedIds(M1)) expect(M1.identity.retired).not.toContain(id);
  });

  it('a retired identity is never handed back: reintroducing a removed page and section yields fresh IDs', () => {
    const M2 = reconcileModelWithPlan({ base: M1, baseRef: { ...M0_REF, version: 2 }, sitePlanRef: planRef(3), plan: P0 });
    expect(M2.pages[1]!.route).toBe('/about');
    expect(M2.pages[1]!.pageId).not.toBe(M0.pages[1]!.pageId);
    expect(sectionByKey(M2, 'contact').sectionId).not.toBe(sectionByKey(M0, 'contact').sectionId);
    expect(M2.identity.minted).toBeGreaterThan(M1.identity.minted);
    for (const id of usedIds(M2)) expect(M2.identity.retired).not.toContain(id);
  });
});

describe('semantic patches', () => {
  const heroHeading = heading(M0, 'hero');

  it('set_field_value changes exactly one field and preserves every containing ID', () => {
    const M1 = apply({ op: 'set_field_value', fieldId: heroHeading.fieldId, expected: heroHeading.value, value: 'Joinery built to last' });
    expect(heading(M1, 'hero')).toEqual({ ...heroHeading, value: 'Joinery built to last' });
    expect([...usedIds(M1)].sort()).toEqual([...usedIds(M0)].sort());
    expect(M1.provenance).toEqual({ kind: 'semantic_patch', base: M0_REF, operation: 'set_field_value', target: heroHeading.fieldId });
  });

  it('is deterministic and never mutates its base', () => {
    const before = JSON.stringify(M0);
    const op = { op: 'set_field_value', fieldId: heroHeading.fieldId, expected: heroHeading.value, value: 'x y z' } as const;
    expect(apply(op)).toEqual(apply(op));
    expect(JSON.stringify(M0)).toBe(before);
  });

  it('rejects an unknown target, a wrong target type, a stale expectation and an invalid value', () => {
    expect(rejectedWith(() => apply({ op: 'set_field_value', fieldId: 'fld_ffffffffffffffff', expected: 'x', value: 'y' }))).toBe('unknown_target');
    expect(rejectedWith(() => apply({ op: 'set_field_value', fieldId: sectionByKey(M0, 'hero').sectionId as never, expected: 'x', value: 'y' }))).toBe('wrong_target_type');
    expect(rejectedWith(() => apply({ op: 'move_section', sectionId: heroHeading.fieldId as never, toIndex: 0 }))).toBe('wrong_target_type');
    expect(rejectedWith(() => apply({ op: 'set_field_value', fieldId: heroHeading.fieldId, expected: 'something else', value: 'y' }))).toBe('stale_expectation');
    expect(rejectedWith(() => apply({ op: 'set_field_value', fieldId: heroHeading.fieldId, expected: heroHeading.value, value: '' }))).toBe('invalid_value');
    expect(rejectedWith(() => apply({ op: 'set_field_value', fieldId: heroHeading.fieldId, expected: heroHeading.value, value: { label: 'x' } }))).toBe('invalid_value');
  });

  it('rejects a patch written against any other base version', () => {
    const other = { ...M0_REF, version: 2 };
    expect(rejectedWith(() => applySemanticPatch({ baseRef: M0_REF, base: M0, patch: patch({ op: 'remove_block', blockId: 'blk_0000000000000001' }, other) }))).toBe('base_mismatch');
    expect(rejectedWith(() => applySemanticPatch({ baseRef: M0_REF, base: M0, patch: patch({ op: 'remove_block', blockId: 'blk_0000000000000001' }, { ...M0_REF, contentHash: 'f'.repeat(64) }) }))).toBe('base_mismatch');
    expect(rejectedWith(() => applySemanticPatch({ baseRef: M0_REF, base: M0, patch: { baseModel: { name: 'site-plan', version: 1, contentHash: M0_REF.contentHash }, operation: { op: 'remove_block', blockId: 'blk_0000000000000001' } } }))).toBe('invalid_patch');
  });

  it('move_section preserves the section’s identity and changes only its position', () => {
    const contact = sectionByKey(M0, 'contact');
    const M1 = apply({ op: 'move_section', sectionId: contact.sectionId, toIndex: 0 });
    expect(home(M1).sections.map((s) => s.planKey)).toEqual(['contact', 'hero', 'services']);
    expect(home(M1).sections[0]).toEqual(contact);
    expect(rejectedWith(() => apply({ op: 'move_section', sectionId: contact.sectionId, toIndex: 3 }))).toBe('invalid_value');
  });

  it('set_section_layout and set_visibility change bounded values only, preserving identity', () => {
    const hero = sectionByKey(M0, 'hero');
    const laidOut = apply({ op: 'set_section_layout', sectionId: hero.sectionId, expected: 'split-hero', layout: 'editorial-split' });
    expect(sectionByKey(laidOut, 'hero')).toEqual({ ...hero, layout: 'editorial-split' });
    const hidden = apply({ op: 'set_visibility', targetId: hero.sectionId, visibility: 'hidden' });
    expect(sectionByKey(hidden, 'hero')).toEqual({ ...hero, visibility: 'hidden' });
    expect(rejectedWith(() => apply({ op: 'set_visibility', targetId: hero.sectionId, visibility: 'collapsed' as never }))).toBe('invalid_patch');
    expect(rejectedWith(() => apply({ op: 'set_section_layout', sectionId: hero.sectionId, expected: 'split-hero', layout: 'masonry' as never }))).toBe('invalid_patch');
  });

  it('set_design_token accepts only a value of the token’s own type', () => {
    const M1 = apply({ op: 'set_design_token', token: 'colors.accent', expected: '#F2B705', value: 'oklch(0.72 0.15 80)' });
    expect(M1.design.colors.accent).toBe('oklch(0.72 0.15 80)');
    expect(M1.provenance).toMatchObject({ target: 'colors.accent' });
    expect(apply({ op: 'set_design_token', token: 'radius', expected: 'square', value: 'rounded' }).design.radius).toBe('rounded');
    expect(rejectedWith(() => apply({ op: 'set_design_token', token: 'colors.accent', expected: '#F2B705', value: 'red; background: url(evil)' }))).toBe('invalid_value');
    expect(rejectedWith(() => apply({ op: 'set_design_token', token: 'radius', expected: 'square', value: 'pill' }))).toBe('invalid_value');
    expect(rejectedWith(() => apply({ op: 'set_design_token', token: 'typography.baseSize', expected: '18px', value: 'calc(100vw)' }))).toBe('invalid_value');
    expect(rejectedWith(() => apply({ op: 'set_design_token', token: 'css' as never, expected: '', value: 'body{}' }))).toBe('invalid_patch');
  });

  describe('blocks and assets', () => {
    const hero = sectionByKey(M0, 'hero');
    const withCard = apply({ op: 'add_block', sectionId: hero.sectionId, index: 0, kind: 'card', values: { title: 'Wardrobes', body: 'Fitted to the room.' } });
    const withCardRef: ArtifactRef = { name: EDITABLE_SITE_MODEL_ARTIFACT, version: 2, contentHash: contentHash(withCard) };
    const card = sectionByKey(withCard, 'hero').blocks[0]!;

    it('add_block mints fresh IDs under harness authority, with exactly the kind’s fields', () => {
      expect(card.blockId).toMatch(/^blk_[a-f0-9]{16}$/);
      expect(card.fields.map((f) => [f.key, f.type, f.value])).toEqual([['title', 'text', 'Wardrobes'], ['body', 'text', 'Fitted to the room.']]);
      expect(usedIds(M0).has(card.blockId)).toBe(false);
      expect(withCard.identity.minted).toBe(M0.identity.minted + 1);
      expect(rejectedWith(() => apply({ op: 'add_block', sectionId: hero.sectionId, index: 0, kind: 'card', values: { title: 'x' } }))).toBe('invalid_value');
      expect(rejectedWith(() => apply({ op: 'add_block', sectionId: hero.sectionId, index: 0, kind: 'carousel' as never, values: {} }))).toBe('invalid_patch');
    });

    it('remove_block retires its IDs, and a later add never reuses them', () => {
      const removed = applySemanticPatch({ baseRef: withCardRef, base: withCard, patch: patch({ op: 'remove_block', blockId: card.blockId }, withCardRef) });
      expect(removed.identity.retired).toEqual(expect.arrayContaining([card.blockId, ...card.fields.map((f) => f.fieldId)]));
      const removedRef: ArtifactRef = { name: EDITABLE_SITE_MODEL_ARTIFACT, version: 3, contentHash: contentHash(removed) };
      const again = applySemanticPatch({ baseRef: removedRef, base: removed, patch: patch({ op: 'add_block', sectionId: hero.sectionId, index: 0, kind: 'card', values: { title: 'Wardrobes', body: 'Fitted to the room.' } }, removedRef) });
      const fresh = sectionByKey(again, 'hero').blocks[0]!;
      expect(fresh.blockId).not.toBe(card.blockId);
      for (const field of fresh.fields) expect(card.fields.map((f) => f.fieldId)).not.toContain(field.fieldId);
      expect(rejectedWith(() => applySemanticPatch({ baseRef: removedRef, base: removed, patch: patch({ op: 'set_visibility', targetId: card.blockId, visibility: 'hidden' }, removedRef) }))).toBe('unknown_target');
    });

    it('set_asset changes what fills a slot, never the slot’s identity', () => {
      const slotted = clone(M0);
      slotted.assets.push({ assetId: 'ast_00000000000000aa', kind: 'image', source: { kind: 'unassigned' } });
      const ref: ArtifactRef = { name: EDITABLE_SITE_MODEL_ARTIFACT, version: 9, contentHash: contentHash(slotted) };
      const source = { kind: 'blob' as const, blob: `sha256:${'c'.repeat(64)}`, mediaType: 'image/png' as const, width: 1200, height: 800 };
      const filled = applySemanticPatch({ baseRef: ref, base: slotted, patch: patch({ op: 'set_asset', assetId: 'ast_00000000000000aa', expected: { kind: 'unassigned' }, source }, ref) });
      expect(filled.assets).toEqual([{ assetId: 'ast_00000000000000aa', kind: 'image', source }]);
      expect(rejectedWith(() => applySemanticPatch({ baseRef: ref, base: slotted, patch: patch({ op: 'set_asset', assetId: 'ast_00000000000000bb', expected: { kind: 'unassigned' }, source }, ref) }))).toBe('unknown_target');
      expect(rejectedWith(() => applySemanticPatch({ baseRef: ref, base: slotted, patch: patch({ op: 'set_asset', assetId: 'ast_00000000000000aa', expected: { kind: 'unassigned' }, source: { ...source, blob: 'https://evil' } }, ref) }))).toBe('invalid_patch');
    });
  });
});

describe('the site-model gate over the static export', () => {
  const clean = () => exportForModel(M0);
  const findings = (files: { path: string; contents: string }[], model = M0) => siteModelMarkerFindings(model, files);
  const rewrite = (files: { path: string; contents: string }[], path: string, fn: (html: string) => string) => files.map((f) => (f.path === path ? { ...f, contents: fn(f.contents) } : f));
  const hero = sectionByKey(M0, 'hero');

  it('an export carrying exactly the model’s identity and values passes', () => {
    expect(findings(clean())).toEqual([]);
  });

  it.each([
    ['a missing page marker', (h: string) => h.replace(`${SITE_MODEL_MARKERS.page}="${home(M0).pageId}"`, ''), /does not render pg_/],
    ['a missing section marker', (h: string) => h.replace(`${SITE_MODEL_MARKERS.section}="${hero.sectionId}"`, ''), /does not render sec_/],
    ['a duplicated section marker', (h: string) => h.replace('</main>', `<section ${SITE_MODEL_MARKERS.section}="${hero.sectionId}"></section></main>`), /rendered 2 times/],
    ['the wrong page ID on a route', (h: string) => h.replace(home(M0).pageId, M0.pages[1]!.pageId), /belongs to \/about|does not render pg_/],
    ['another page’s section rendered on this route', (h: string) => h.replace('</main>', `<section ${SITE_MODEL_MARKERS.section}="${M0.pages[1]!.sections[0]!.sectionId}"></section></main>`), /belongs to \/about, not \//],
    ['an ID the model never issued', (h: string) => h.replace('</main>', `<div ${SITE_MODEL_MARKERS.block}="blk_0123456789abcdef"></div></main>`), /not in the editable site model/],
    ['a changed heading', (h: string) => h.replace('Fitted joinery, made here', 'Fitted joinery, made anywhere'), /not the model's/],
    ['a changed title', (h: string) => h.replace('<title>Harrowgate Joinery</title>', '<title>Harrowgate Joinery | Home</title>'), /<title>/],
    ['a heading outside its section', (h: string) => h.replace(`<h2 ${SITE_MODEL_MARKERS.field}="${hero.fields[0]!.fieldId}">Fitted joinery, made here</h2>`, '').replace('<main', `<h2 ${SITE_MODEL_MARKERS.field}="${hero.fields[0]!.fieldId}">Fitted joinery, made here</h2><main`), /outside sec_/],
    ['sections out of order', (h: string) => {
      const services = sectionByKey(M0, 'services');
      const heroHtml = h.match(new RegExp(`<section ${SITE_MODEL_MARKERS.section}="${hero.sectionId}">.*?</section>`))![0];
      const servicesHtml = h.match(new RegExp(`<section ${SITE_MODEL_MARKERS.section}="${services.sectionId}">.*?</section>`))![0];
      return h.replace(heroHtml, '@@').replace(servicesHtml, heroHtml).replace('@@', servicesHtml);
    }, /out of the model's order/],
  ])('detects %s', (_label, corrupt, message) => {
    const result = findings(rewrite(clean(), 'index.html', corrupt));
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((f) => f.gate === 'site-model' && f.severity === 'P0' && f.location === 'app/page.tsx')).toBe(true);
    expect(result.map((f) => f.message).join('\n')).toMatch(message);
  });

  it('detects a route that did not export, and a hidden section that still renders', () => {
    expect(findings(clean().filter((f) => f.path !== 'about.html')).map((f) => f.message).join()).toMatch(/did not export/);
    const hiddenRef: ArtifactRef = M0_REF;
    const hidden = applySemanticPatch({ baseRef: hiddenRef, base: M0, patch: patch({ op: 'set_visibility', targetId: hero.sectionId, visibility: 'hidden' }) });
    expect(findings(clean(), hidden).map((f) => f.message).join()).toMatch(/hidden in the model but rendered/);
    expect(findings(exportForModel(hidden), hidden)).toEqual([]);
  });

  it('follows a moved section and a patched field: the gate always measures the exact model it is given', () => {
    const moved = apply({ op: 'move_section', sectionId: sectionByKey(M0, 'contact').sectionId, toIndex: 0 });
    expect(findings(clean(), moved).map((f) => f.message).join()).toMatch(/out of the model's order/);
    expect(findings(exportForModel(moved), moved)).toEqual([]);
  });
});
