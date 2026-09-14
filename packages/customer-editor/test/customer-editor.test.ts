/**
 * The customer editor's offline behaviour: model-backed selection, controls
 * compiled to the existing semantic patch contract, the preview message
 * contract, customer-safe status words, and the isolated snapshot preview
 * transport (HTML and CSS rewriting, path authority, script removal, bounds).
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import { SemanticPatch, SITE_MODEL_MARKERS } from '@statxai/contracts';
import {
  ADDABLE_BLOCK_KINDS,
  EDIT_FAILURE_LABEL,
  EDIT_STATE_LABEL,
  EditorPatchInvalid,
  SECTION_LAYOUTS,
  SELECTION_PRECEDENCE,
  addBlockPatch,
  editorModelView,
  isTerminalEditState,
  moveSectionPatch,
  parsePreviewMessage,
  removeBlockPatch,
  resolveSelection,
  selectFromMarkers,
  setFieldValuePatch,
  setSectionLayoutPatch,
  setVisibilityPatch,
} from '../src/client.js';
import { MAX_PREVIEW_DOCUMENT_BYTES, EditorPreviewTooLarge, editorPreviewContentSecurityPolicy, renderEditorPreviewDocument } from '../src/preview/transport.js';
import { editorBridgeSource } from '../src/preview/bridge.js';
import { EXPORT_FILES, FONT, IDS, MODEL, MODEL_REF, PNG, filesOf } from './support/fixtures.js';

const view = editorModelView(MODEL);
const CHANNEL = 'channel_0123456789abcdef';
const field = (fieldId: string) => {
  const found = resolveSelection(view, MODEL.pages.find((p) => JSON.stringify(p).includes(fieldId))!.route, { kind: 'field', id: fieldId });
  if (found?.kind !== 'field') throw new Error(`fixture field ${fieldId} not found`);
  return found.field;
};

describe('the customer-safe model view', () => {
  it('keeps exactly what an editor needs, and none of the plan, provenance, identity ledger, plan keys or asset contents', () => {
    const serialised = JSON.stringify(view);
    expect(serialised).not.toMatch(/sitePlan|provenance|retired|minted|planKey|blob|sha256|design|artDirection/);
    expect(view.pages.map((p) => p.route)).toEqual(['/', '/about']);
    expect(view.assets).toEqual([{ assetId: IDS.heroImage, kind: 'image', filled: false }]);
  });
});

describe('selection is semantic identity from data-statx markers, proven against the exact model', () => {
  it.each([
    ['page', IDS.home, 'page'],
    ['section', IDS.services, 'section'],
    ['block', IDS.card, 'block'],
    ['field', IDS.cardTitle, 'field'],
    ['asset', IDS.heroImage, 'asset'],
  ] as const)('a %s marker selects exactly that %s', (kind, id, expected) => {
    const selected = resolveSelection(view, '/', { kind, id });
    expect(selected).toMatchObject({ kind: expected, id });
  });

  it('resolves a field to its exact owner', () => {
    expect(resolveSelection(view, '/', { kind: 'field', id: IDS.homeTitle })).toMatchObject({ owner: { kind: 'page' } });
    expect(resolveSelection(view, '/', { kind: 'field', id: IDS.heroHeading })).toMatchObject({ owner: { kind: 'section', section: { sectionId: IDS.hero } } });
    expect(resolveSelection(view, '/', { kind: 'field', id: IDS.cardBody })).toMatchObject({ owner: { kind: 'block', block: { blockId: IDS.card } } });
  });

  it('nested markers resolve by fixed precedence — field, asset, block, section, page — whatever order the chain lists them in', () => {
    expect(SELECTION_PRECEDENCE).toEqual(['field', 'asset', 'block', 'section', 'page']);
    const chain = { page: IDS.home, section: IDS.hero, block: IDS.image, asset: IDS.heroImage, field: IDS.imageImage };
    expect(selectFromMarkers(view, '/', chain)).toMatchObject({ kind: 'field', id: IDS.imageImage });
    const noField = { page: chain.page, section: chain.section, block: chain.block, asset: chain.asset };
    expect(selectFromMarkers(view, '/', noField)).toMatchObject({ kind: 'asset', id: IDS.heroImage });
    expect(selectFromMarkers(view, '/', { section: IDS.hero, page: IDS.home })).toMatchObject({ kind: 'section', id: IDS.hero });
    expect(selectFromMarkers(view, '/', {})).toBeNull();
  });

  it('an unknown, malformed, wrong-kind or foreign-page ID selects nothing — and is never replaced by a lower marker', () => {
    const unknown = 'fld_ffffffffffffffff';
    expect(resolveSelection(view, '/', { kind: 'field', id: unknown })).toBeNull();
    expect(resolveSelection(view, '/', { kind: 'field', id: 'fld_123' })).toBeNull();
    expect(resolveSelection(view, '/', { kind: 'section', id: IDS.cardTitle })).toBeNull();
    // Valid-looking and real, but on another page than the one previewed.
    expect(resolveSelection(view, '/', { kind: 'section', id: IDS.aboutIntro })).toBeNull();
    expect(resolveSelection(view, '/about', { kind: 'field', id: IDS.cardTitle })).toBeNull();
    expect(resolveSelection(view, '/nope', { kind: 'page', id: IDS.home })).toBeNull();
    expect(selectFromMarkers(view, '/', { field: unknown, section: IDS.hero })).toBeNull();
    expect(resolveSelection(view, '/', { kind: 'nth-child' as never, id: '2' })).toBeNull();
  });

  it('identity is not position: the same ID selects the same object after the model reorders its sections', () => {
    const [hero, services, closing] = MODEL.pages[0]!.sections;
    const reordered = editorModelView({ ...MODEL, pages: [{ ...MODEL.pages[0]!, sections: [closing!, hero!, services!] }, MODEL.pages[1]!] });
    const before = resolveSelection(view, '/', { kind: 'section', id: IDS.services });
    const after = resolveSelection(reordered, '/', { kind: 'section', id: IDS.services });
    expect(before).toMatchObject({ kind: 'section', section: { sectionId: IDS.services } });
    expect(after).toMatchObject({ kind: 'section', section: { sectionId: IDS.services } });
    expect((before as { index: number }).index).not.toBe((after as { index: number }).index);
  });
});

describe('editor controls compile to the existing semantic patch contract', () => {
  const parsed = (patch: unknown) => SemanticPatch.parse(patch);

  it('a text field edit is exactly set_field_value with the value the author saw', () => {
    const patch = setFieldValuePatch(MODEL_REF, field(IDS.heroHeading), 'Wardrobes made here');
    expect(parsed(patch)).toEqual({ baseModel: MODEL_REF, operation: { op: 'set_field_value', fieldId: IDS.heroHeading, expected: 'Fitted joinery', value: 'Wardrobes made here' } });
  });

  it('a CTA edit is exactly set_field_value with a label and a contract link — and an executable or malformed link is refused', () => {
    const cta = field(IDS.ctaAction);
    expect(parsed(setFieldValuePatch(MODEL_REF, cta, { label: 'Book a visit', href: '/contact' })).operation).toEqual({ op: 'set_field_value', fieldId: IDS.ctaAction, expected: { label: 'Call us', href: 'tel:+441423887214' }, value: { label: 'Book a visit', href: '/contact' } });
    for (const href of ['javascript:alert(1)', 'http://insecure.example', 'data:text/html,x', '//evil.example', '/Contact Us']) {
      expect(() => setFieldValuePatch(MODEL_REF, cta, { label: 'x', href })).toThrow(EditorPatchInvalid);
    }
    expect(() => setFieldValuePatch(MODEL_REF, cta, { label: '', href: '/contact' })).toThrow(EditorPatchInvalid);
    expect(() => setFieldValuePatch(MODEL_REF, cta, { label: 'x', href: '/contact', style: 'color:red' })).toThrow(EditorPatchInvalid);
  });

  it('phone, email and address use the contract field validators', () => {
    expect(parsed(setFieldValuePatch(MODEL_REF, field(IDS.phoneValue), '+44 1423 000 000')).operation).toMatchObject({ op: 'set_field_value', value: '+44 1423 000 000' });
    expect(() => setFieldValuePatch(MODEL_REF, field(IDS.phoneValue), 'call me')).toThrow(EditorPatchInvalid);
    expect(parsed(setFieldValuePatch(MODEL_REF, field(IDS.emailValue), 'hello@example.com')).operation).toMatchObject({ value: 'hello@example.com' });
    expect(() => setFieldValuePatch(MODEL_REF, field(IDS.emailValue), 'not-an-email')).toThrow(EditorPatchInvalid);
    expect(parsed(setFieldValuePatch(MODEL_REF, field(IDS.addressValue), '2 Low Street')).operation).toMatchObject({ value: '2 Low Street' });
    expect(() => setFieldValuePatch(MODEL_REF, field(IDS.addressValue), '')).toThrow(EditorPatchInvalid);
  });

  it('an asset slot is read-only: no builder sets it, and a field edit refuses asset fields', () => {
    expect(() => setFieldValuePatch(MODEL_REF, field(IDS.imageImage), 'ast_0000000000000009')).toThrow(EditorPatchInvalid);
  });

  it('section visibility, bounded layout and reorder produce exact patches; reorder keeps the section ID', () => {
    const page = view.pages[0]!;
    const services = page.sections[1]!;
    expect(parsed(setVisibilityPatch(MODEL_REF, IDS.services, 'hidden')).operation).toEqual({ op: 'set_visibility', targetId: IDS.services, visibility: 'hidden' });
    expect(parsed(setSectionLayoutPatch(MODEL_REF, services, 'rule-list')).operation).toEqual({ op: 'set_section_layout', sectionId: IDS.services, expected: 'feature-grid', layout: 'rule-list' });
    expect(SECTION_LAYOUTS).toContain('rule-list');
    expect(() => setSectionLayoutPatch(MODEL_REF, services, 'display:grid')).toThrow(EditorPatchInvalid);
    expect(parsed(moveSectionPatch(MODEL_REF, page, IDS.services, 'up')).operation).toEqual({ op: 'move_section', sectionId: IDS.services, toIndex: 0 });
    expect(parsed(moveSectionPatch(MODEL_REF, page, IDS.services, 'down')).operation).toEqual({ op: 'move_section', sectionId: IDS.services, toIndex: 2 });
    expect(() => moveSectionPatch(MODEL_REF, page, IDS.hero, 'up')).toThrow(EditorPatchInvalid);
    expect(() => moveSectionPatch(MODEL_REF, page, IDS.closing, 'down')).toThrow(EditorPatchInvalid);
  });

  it('adding a block chooses a supported kind and values — never an ID; removing names an existing block', () => {
    const services = view.pages[0]!.sections[1]!;
    const added = parsed(addBlockPatch(MODEL_REF, services, 'card', { title: 'Staircases', body: 'Oak.' }));
    expect(added.operation).toEqual({ op: 'add_block', sectionId: IDS.services, index: 1, kind: 'card', values: { title: 'Staircases', body: 'Oak.' } });
    expect(JSON.stringify(added)).not.toMatch(/"blockId"|"fieldId"/);
    expect(ADDABLE_BLOCK_KINDS).not.toContain('image');
    expect(() => addBlockPatch(MODEL_REF, services, 'image', { image: 'ast_0000000000000001', alt: 'x' })).toThrow(EditorPatchInvalid);
    expect(() => addBlockPatch(MODEL_REF, services, 'card', { title: 'x', body: 'y', blockId: 'blk_0000000000000099' })).toThrow(EditorPatchInvalid);
    expect(() => addBlockPatch(MODEL_REF, services, 'cta', { action: { label: 'x', href: 'javascript:1' } })).toThrow(EditorPatchInvalid);
    expect(parsed(removeBlockPatch(MODEL_REF, IDS.card)).operation).toEqual({ op: 'remove_block', blockId: IDS.card });
  });

  it('there is no way to express CSS, source or a design token: the contract refuses such operations', () => {
    expect(SemanticPatch.safeParse({ baseModel: MODEL_REF, operation: { op: 'set_css', selector: 'h1', css: 'color:red' } }).success).toBe(false);
    expect(SemanticPatch.safeParse({ baseModel: MODEL_REF, operation: { op: 'set_field_value', fieldId: IDS.heroHeading, expected: 'x', value: 'y', style: 'color:red' } }).success).toBe(false);
  });
});

describe('preview messages and status words', () => {
  it('accepts only a strict message for exactly this channel', () => {
    const select = { type: 'statx-editor-preview', version: 1, channel: CHANNEL, event: 'select', markers: { field: IDS.cardTitle } };
    expect(parsePreviewMessage(select, CHANNEL)).toEqual(select);
    expect(parsePreviewMessage({ ...select, channel: 'channel_ffffffffffffffff' }, CHANNEL)).toBeNull();
    expect(parsePreviewMessage({ ...select, markers: { field: IDS.cardTitle, selector: 'h1' } }, CHANNEL)).toBeNull();
    expect(parsePreviewMessage({ ...select, markers: { field: 'fld_<script>' } }, CHANNEL)).toBeNull();
    expect(parsePreviewMessage({ ...select, event: 'submit_edit' }, CHANNEL)).toBeNull();
    expect(parsePreviewMessage('select', CHANNEL)).toBeNull();
  });

  it('every state and failure has customer words, and nothing claims approval or publishing', () => {
    expect(EDIT_STATE_LABEL).toEqual({ queued: 'Saving changes…', running: 'Building new revision…', finishing: 'Validating and finishing…', completed: 'Changes applied', failed: 'Edit could not be completed' });
    expect(Object.keys(EDIT_FAILURE_LABEL).sort()).toEqual(['build_failed', 'needs_attention', 'temporarily_unavailable', 'validation_failed']);
    expect(JSON.stringify([EDIT_STATE_LABEL, EDIT_FAILURE_LABEL])).not.toMatch(/approv|publish|live/i);
    expect(['queued', 'running', 'finishing'].map((s) => isTerminalEditState(s as never))).toEqual([false, false, false]);
    expect(isTerminalEditState('completed') && isTerminalEditState('failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Preview transport
// ---------------------------------------------------------------------------

type P5Node = { nodeName: string; tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: P5Node[]; value?: string; content?: P5Node };
function allElements(node: P5Node, out: P5Node[] = []): P5Node[] {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) out.push(child);
    allElements(child, out);
  }
  return out;
}
const attrOf = (el: P5Node, name: string) => el.attrs?.find((a) => a.name === name)?.value;
const textOf = (el: P5Node): string => (el.childNodes ?? []).map((c) => c.value ?? textOf(c)).join('');

async function render(documentPath = 'index.html', files = EXPORT_FILES, reads: string[] = []) {
  const doc = await renderEditorPreviewDocument({ files: filesOf(files, reads), documentPath, channel: CHANNEL });
  const elements = allElements(parse(doc.html) as unknown as P5Node);
  return { doc, elements };
}

describe('the editor preview transport: one self-contained, scriptless view of an exact snapshot page', () => {
  it('removes every generated script and keeps exactly one trusted bridge carrying the response nonce', async () => {
    const { doc, elements } = await render();
    const scripts = elements.filter((e) => e.tagName === 'script');
    expect(scripts).toHaveLength(1);
    expect(attrOf(scripts[0]!, 'nonce')).toBe(doc.nonce);
    expect(textOf(scripts[0]!)).toBe(editorBridgeSource(CHANNEL));
    expect(doc.html).not.toMatch(/generated-script-ran|hydrate|app\.js|forged-channel|alert\(/);
    expect(doc.contentSecurityPolicy).toBe(editorPreviewContentSecurityPolicy(doc.nonce));
    expect(doc.contentSecurityPolicy).toMatch(/default-src 'none'.*script-src 'nonce-[A-Za-z0-9_-]+'.*connect-src 'none'.*form-action 'none'.*sandbox allow-scripts/);
    expect(doc.contentSecurityPolicy).not.toMatch(/unsafe-eval|allow-same-origin|script-src[^;]*unsafe-inline/);
  });

  it('strips inline handlers, javascript: and every other navigation, targets, form actions, meta refresh, base, frames and objects', async () => {
    const { elements, doc } = await render();
    for (const el of elements) {
      for (const a of el.attrs ?? []) {
        expect(a.name, `${el.tagName}[${a.name}]`).not.toMatch(/^on|^(formaction|action|target|ping|srcdoc|http-equiv)$/i);
        expect(a.value, `${el.tagName}[${a.name}]`).not.toMatch(/javascript:|evil\.example/i);
      }
    }
    expect(elements.map((e) => e.tagName)).not.toEqual(expect.arrayContaining(['iframe']));
    for (const tag of ['iframe', 'object', 'base', 'embed', 'noscript']) expect(elements.some((e) => e.tagName === tag), tag).toBe(false);
    expect(elements.some((e) => e.tagName === 'meta' && attrOf(e, 'http-equiv'))).toBe(false);
    for (const link of elements.filter((e) => e.tagName === 'a')) expect(attrOf(link, 'href')).toBe('#');
    expect(elements.filter((e) => e.tagName === 'link')).toEqual([]);
    expect(doc.html).toContain('<form method="post">');
  });

  it('keeps every data-statx marker exactly as the snapshot carries it', async () => {
    const { elements } = await render();
    const markers = elements.flatMap((e) => (e.attrs ?? []).filter((a) => Object.values(SITE_MODEL_MARKERS).includes(a.name as never)).map((a) => `${a.name}=${a.value}`));
    const source = [...EXPORT_FILES['index.html']!.toString().matchAll(/(data-statx-[a-z]+-id)="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(markers).toEqual(source);
  });

  it('inlines the linked Next stylesheet, its @import, fonts and images from the exact snapshot — nothing points at /_next/static or any origin', async () => {
    const reads: string[] = [];
    const { doc, elements } = await render('index.html', EXPORT_FILES, reads);
    const styles = elements.filter((e) => e.tagName === 'style').map(textOf);
    const site = styles.find((s) => s.includes('font-family:Site'))!;
    expect(site).toContain('.extra{border-top:4px solid rgb(4, 5, 6)}');
    expect(site).toContain(`url("data:font/woff2;base64,${FONT.toString('base64')}")`);
    expect(site).toContain(`url("data:image/png;base64,${PNG.toString('base64')}")`);
    expect(site).not.toMatch(/@import/);
    const img = elements.find((e) => attrOf(e, SITE_MODEL_MARKERS.asset))!;
    expect(attrOf(img, 'src')).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(attrOf(img, 'srcset')).toBe(`data:image/png;base64,${PNG.toString('base64')} 1x`);
    expect(attrOf(elements.find((e) => attrOf(e, SITE_MODEL_MARKERS.section) === IDS.hero)!, 'style')).toBe(`background-image:url("data:image/png;base64,${PNG.toString('base64')}");color:red`);
    expect(doc.html).not.toMatch(/\/_next\/static|\/images\/|https?:\/\//);
    expect(reads).not.toContain('_next/static/chunks/app.js');
    expect(reads).not.toContain('_next/static/chunks/hydrate.js');
    expect(reads.every((r) => Object.hasOwn(EXPORT_FILES, r) || !r.includes('..'))).toBe(true);
  });

  it('a nested page resolves its relative stylesheet inside the snapshot', async () => {
    const { elements } = await render('about.html');
    expect(elements.filter((e) => e.tagName === 'style').map(textOf).join('')).toContain('font-family:Site');
  });

  it('traversal, encoded traversal and external URLs in CSS resolve to nothing, and read nothing outside the manifest', async () => {
    const reads: string[] = [];
    const { elements } = await render('index.html', EXPORT_FILES, reads);
    const site = elements.filter((e) => e.tagName === 'style').map(textOf).find((s) => s.includes('.escape'))!;
    expect(site).toContain('.escape{background:none}');
    expect(site).toContain('.encoded{background:none}');
    expect(site).toContain('.external{background:none}');
    // Only manifest lookups of normalised snapshot paths: never a dot segment, never absolute.
    expect(reads.every((r) => !r.startsWith('/') && !r.split('/').includes('..') && !r.includes('%'))).toBe(true);
  });

  it('a stylesheet or asset the manifest does not have is dropped, not fetched from anywhere else', async () => {
    const rest = Object.fromEntries(Object.entries(EXPORT_FILES).filter(([path]) => path !== '_next/static/chunks/site.css' && path !== 'images/hero.png'));
    const { doc, elements } = await render('index.html', rest);
    expect(elements.some((e) => e.tagName === 'link')).toBe(false);
    expect(attrOf(elements.find((e) => attrOf(e, SITE_MODEL_MARKERS.asset))!, 'src')).toBeUndefined();
    expect(doc.html).not.toMatch(/\/images\/hero\.png|_next/);
  });

  it('CSS that could close its <style> element is never embedded', async () => {
    const close = ['<', '/style>'].join('');
    const files = { ...EXPORT_FILES, '_next/static/chunks/site.css': Buffer.from(`.a::after{content:"${close}<img src=x onerror=alert(1)>"}`) };
    const { elements } = await render('index.html', files);
    // Whatever the stylesheet says, it stays text inside one style element: no element escapes it.
    expect(elements.filter((e) => e.tagName === 'img')).toHaveLength(1);
    expect(elements.some((e) => attrOf(e, 'onerror') !== undefined)).toBe(false);
    for (const style of elements.filter((e) => e.tagName === 'style')) expect(textOf(style).toLowerCase()).not.toContain(close);
  });

  it('refuses — never truncates — a document whose inlined bytes exceed the bound', async () => {
    const huge = Buffer.alloc(MAX_PREVIEW_DOCUMENT_BYTES, 0);
    await expect(render('index.html', { ...EXPORT_FILES, 'images/hero.png': huge })).rejects.toBeInstanceOf(EditorPreviewTooLarge);
  });

  it('serves HTML documents only', async () => {
    await expect(render('_next/static/chunks/site.css')).rejects.toThrow(TypeError);
  });
});
