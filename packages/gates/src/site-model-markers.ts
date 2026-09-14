/**
 * The site-model gate: does the built site carry exactly the semantic identity
 * and values its editable site model claims?
 *
 * Deterministic, over the static export a visitor and a browser receive. For
 * every page of the model:
 *
 * - the route exported, and its `<title>` and meta description are exactly the
 *   page's `title` and `description` fields;
 * - exactly one element carries the page's `data-statx-page-id`;
 * - every visible section appears exactly once, inside the page element, in the
 *   model's order; no hidden section appears;
 * - every visible section's fields, visible blocks and their fields appear
 *   exactly once, each inside its owner, with exactly the model's value;
 * - no marker is repeated, and no marker names an ID the page does not own —
 *   whether it belongs to another page, is hidden, or is not in the model at all.
 *
 * Identity is read only from explicit `data-statx-*-id` attributes. Nothing is
 * inferred from position, text or source.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import {
  SITE_MODEL_MARKERS,
  routeToOutputPath,
  routeToSourcePath,
  type EditableSiteModel,
  type GateFinding,
  type SiteField,
} from '@statxai/contracts';

const GATE = 'site-model';
const ATTRIBUTES = Object.values(SITE_MODEL_MARKERS);
const SELECTOR = ATTRIBUTES.map((a) => `[${a}]`).join(',');
const ID_PREFIX = { page: 'pg', section: 'sec', block: 'blk', field: 'fld', asset: 'ast' } as const;

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();

function isInside(element: HTMLElement, ancestor: HTMLElement): boolean {
  let node = element.parentNode as HTMLElement | null;
  while (node) {
    if (node === ancestor) return true;
    node = node.parentNode as HTMLElement | null;
  }
  return false;
}

function markerOf(element: HTMLElement): { attribute: string; id: string }[] {
  return ATTRIBUTES.flatMap((attribute) => {
    const id = element.getAttribute(attribute);
    return id === undefined ? [] : [{ attribute, id }];
  });
}

export function siteModelMarkerFindings(model: EditableSiteModel, files: readonly { path: string; contents: string }[]): GateFinding[] {
  const findings: GateFinding[] = [];
  const everywhere = new Map<string, string>();
  for (const page of model.pages) {
    everywhere.set(page.pageId, page.route);
    for (const section of page.sections) {
      everywhere.set(section.sectionId, page.route);
      for (const field of section.fields) everywhere.set(field.fieldId, page.route);
      for (const block of section.blocks) {
        everywhere.set(block.blockId, page.route);
        for (const field of block.fields) everywhere.set(field.fieldId, page.route);
      }
    }
  }

  for (const page of model.pages) {
    const location = routeToSourcePath(page.route);
    const push = (message: string, acceptanceTest: string) => findings.push({ gate: GATE, severity: 'P0', location, message, acceptanceTest });
    const output = routeToOutputPath(page.route);
    const file = files.find((f) => f.path === output);
    if (!file) {
      push(`Route "${page.route}" did not export to ${output}, so its semantic identity cannot be checked.`, `${output} is exported.`);
      continue;
    }
    const root = parse(file.contents, { comment: false });

    const fieldValue = (key: string) => page.fields.find((f) => f.key === key)!.value as string;
    const title = normalise(root.querySelector('title')?.text ?? '');
    if (title !== normalise(fieldValue('title'))) push(`The <title> of ${page.route} is "${title}", not the model's "${fieldValue('title')}".`, `The <title> is exactly "${fieldValue('title')}".`);
    const description = normalise(root.querySelector('meta[name="description"]')?.getAttribute('content') ?? '');
    if (description !== normalise(fieldValue('description'))) push(`The meta description of ${page.route} is not the model's description.`, `The meta description is exactly "${fieldValue('description')}".`);

    // Every marker on the page, in document order, and how often each ID appears.
    const marked = root.querySelectorAll(SELECTOR);
    const elementsById = new Map<string, HTMLElement[]>();
    for (const element of marked) {
      for (const { attribute, id } of markerOf(element)) {
        const kind = (Object.keys(SITE_MODEL_MARKERS) as (keyof typeof SITE_MODEL_MARKERS)[]).find((k) => SITE_MODEL_MARKERS[k] === attribute)!;
        if (!id.startsWith(`${ID_PREFIX[kind]}_`)) {
          push(`${attribute}="${id}" on ${page.route} is not a ${kind} ID.`, `${attribute} carries only ${kind} IDs.`);
        }
        elementsById.set(id, [...(elementsById.get(id) ?? []), element]);
      }
    }

    // What this page owns and must render, and what it owns but must not.
    const required = new Map<string, { owner: string | null; field?: SiteField }>();
    const forbidden = new Set<string>();
    required.set(page.pageId, { owner: null });
    for (const section of page.sections) {
      const ids = [section.sectionId, ...section.fields.map((f) => f.fieldId), ...section.blocks.flatMap((b) => [b.blockId, ...b.fields.map((f) => f.fieldId)])];
      if (section.visibility === 'hidden') {
        for (const id of ids) forbidden.add(id);
        continue;
      }
      required.set(section.sectionId, { owner: page.pageId });
      for (const field of section.fields) required.set(field.fieldId, { owner: section.sectionId, field });
      for (const block of section.blocks) {
        const blockIds = [block.blockId, ...block.fields.map((f) => f.fieldId)];
        if (block.visibility === 'hidden') {
          for (const id of blockIds) forbidden.add(id);
          continue;
        }
        required.set(block.blockId, { owner: section.sectionId });
        for (const field of block.fields) required.set(field.fieldId, { owner: block.blockId, field });
      }
    }
    const pageOnly = new Set([...page.fields.map((f) => f.fieldId)]);
    const referencedAssets = new Set([...required.values()].flatMap((r) => (r.field?.type === 'asset' ? [r.field.value] : [])));

    for (const id of elementsById.keys()) {
      if (required.has(id) || referencedAssets.has(id)) continue;
      if (forbidden.has(id)) push(`${id} is hidden in the model but rendered on ${page.route}.`, `${id} is not rendered.`);
      else if (pageOnly.has(id)) push(`${id} is a page metadata field and is not rendered as a marker.`, `No element carries ${id}.`);
      else if (everywhere.has(id)) push(`${id} belongs to ${everywhere.get(id)}, not ${page.route}.`, `${page.route} carries only its own semantic IDs.`);
      else push(`${id} on ${page.route} is not in the editable site model.`, `Every semantic ID on ${page.route} is one the model issued.`);
    }

    for (const [id, expectation] of required) {
      const elements = elementsById.get(id) ?? [];
      if (elements.length === 0) {
        push(`${page.route} does not render ${id}.`, `Exactly one element on ${page.route} carries ${id}.`);
        continue;
      }
      if (elements.length > 1) {
        push(`${id} is rendered ${elements.length} times on ${page.route}.`, `Exactly one element on ${page.route} carries ${id}.`);
        continue;
      }
      const element = elements[0]!;
      if (expectation.owner) {
        const owners = elementsById.get(expectation.owner) ?? [];
        if (owners.length === 1 && !isInside(element, owners[0]!)) push(`${id} is rendered outside ${expectation.owner} on ${page.route}.`, `${id} is inside ${expectation.owner}.`);
      }
      const field = expectation.field;
      if (!field) continue;
      if (field.type === 'cta') {
        if (element.tagName !== 'A' || element.getAttribute('href') !== field.value.href || normalise(element.text) !== normalise(field.value.label)) {
          push(`${id} on ${page.route} is not a link to "${field.value.href}" labelled "${field.value.label}".`, `${id} is an <a href="${field.value.href}"> reading "${field.value.label}".`);
        }
      } else if (field.type === 'asset') {
        if (element.getAttribute(SITE_MODEL_MARKERS.asset) !== field.value) push(`${id} on ${page.route} does not show asset slot ${field.value}.`, `${id} carries ${SITE_MODEL_MARKERS.asset}="${field.value}".`);
      } else if (normalise(element.text) !== normalise(field.value)) {
        push(`${id} on ${page.route} reads "${normalise(element.text).slice(0, 120)}", not the model's "${field.value.slice(0, 120)}".`, `${id} reads exactly "${field.value}".`);
      }
    }

    // Composition: visible sections in the model's order.
    const expectedOrder = page.sections.filter((s) => s.visibility === 'visible').map((s) => s.sectionId);
    const renderedOrder = marked.map((e) => e.getAttribute(SITE_MODEL_MARKERS.section)).filter((id): id is string => id !== undefined && expectedOrder.includes(id));
    if (new Set(renderedOrder).size === expectedOrder.length && renderedOrder.join() !== expectedOrder.join()) {
      push(`The sections of ${page.route} render out of the model's order.`, `The sections of ${page.route} render in the order ${expectedOrder.join(', ')}.`);
    }
  }
  return findings;
}
