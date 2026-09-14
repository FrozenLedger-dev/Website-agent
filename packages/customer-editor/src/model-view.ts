/**
 * The customer-safe view of one exact editable site model, and the selection a
 * click in the preview may resolve to.
 *
 * Browser-safe: no Node, no store. The view keeps exactly what an editor needs
 * to show and change — routes, fields and their values, section and block
 * structure, asset slots — and drops what is planning or identity-ledger
 * authority (the plan ref, provenance, retired IDs, plan keys, blob keys).
 *
 * A selection is only ever resolved from a `data-statx-*-id` marker value
 * against this exact model and the page being previewed. Nothing about the DOM
 * — position, text, a selector — can name an editable object, and a marker the
 * model does not know (or knows on another page) selects nothing.
 */
import {
  AssetId,
  BlockId,
  FieldId,
  PageId,
  SectionId,
  type EditableSiteModel,
  type SiteField,
} from '@statxai/contracts/editable-site-model';

export interface EditorBlockView {
  readonly blockId: string;
  readonly kind: EditableSiteModel['pages'][number]['sections'][number]['blocks'][number]['kind'];
  readonly visibility: 'visible' | 'hidden';
  readonly fields: readonly SiteField[];
}

export interface EditorSectionView {
  readonly sectionId: string;
  readonly layout: EditableSiteModel['pages'][number]['sections'][number]['layout'];
  readonly visibility: 'visible' | 'hidden';
  /** Exactly the section's `heading` text field. */
  readonly fields: readonly SiteField[];
  readonly blocks: readonly EditorBlockView[];
}

export interface EditorPageView {
  readonly pageId: string;
  readonly route: string;
  /** Exactly `title` and `description`. */
  readonly fields: readonly SiteField[];
  readonly sections: readonly EditorSectionView[];
}

export interface EditorAssetView {
  readonly assetId: string;
  readonly kind: 'image' | 'illustration' | 'logo';
  /** Whether the slot is filled. What fills it is not chosen in this editor. */
  readonly filled: boolean;
}

export interface EditorModelView {
  readonly pages: readonly EditorPageView[];
  readonly assets: readonly EditorAssetView[];
}

/** The customer-safe view of an exact model. */
export function editorModelView(model: EditableSiteModel): EditorModelView {
  return {
    pages: model.pages.map((page) => ({
      pageId: page.pageId,
      route: page.route,
      fields: page.fields,
      sections: page.sections.map((section) => ({
        sectionId: section.sectionId,
        layout: section.layout,
        visibility: section.visibility,
        fields: section.fields,
        blocks: section.blocks.map((block) => ({ blockId: block.blockId, kind: block.kind, visibility: block.visibility, fields: block.fields })),
      })),
    })),
    assets: model.assets.map((asset) => ({ assetId: asset.assetId, kind: asset.kind, filled: asset.source.kind !== 'unassigned' })),
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type SelectionKind = 'page' | 'section' | 'block' | 'field' | 'asset';

/** Which marker wins when one click lies inside several: the most specific editable object. */
export const SELECTION_PRECEDENCE: readonly SelectionKind[] = Object.freeze(['field', 'asset', 'block', 'section', 'page']);

const ID_SCHEMA = { page: PageId, section: SectionId, block: BlockId, field: FieldId, asset: AssetId } as const;

/** The nearest marker value of each kind around a clicked element, as the bridge reports them. Untrusted. */
export type MarkerChain = Partial<Record<SelectionKind, string>>;

export type FieldOwner = { readonly kind: 'page' } | { readonly kind: 'section'; readonly section: EditorSectionView } | { readonly kind: 'block'; readonly section: EditorSectionView; readonly block: EditorBlockView };

export type ResolvedSelection =
  | { readonly kind: 'page'; readonly id: string; readonly page: EditorPageView }
  | { readonly kind: 'section'; readonly id: string; readonly page: EditorPageView; readonly section: EditorSectionView; readonly index: number }
  | { readonly kind: 'block'; readonly id: string; readonly page: EditorPageView; readonly section: EditorSectionView; readonly block: EditorBlockView; readonly index: number }
  | { readonly kind: 'field'; readonly id: string; readonly page: EditorPageView; readonly owner: FieldOwner; readonly field: SiteField }
  | { readonly kind: 'asset'; readonly id: string; readonly page: EditorPageView; readonly asset: EditorAssetView };

export interface SelectionTarget {
  readonly kind: SelectionKind;
  readonly id: string;
}

/**
 * One exact semantic object of the model, on the page being previewed — or
 * `null`. The ID must parse as its kind and exist on exactly that page (or, for
 * an asset, be a slot of the model a field on that page uses).
 */
export function resolveSelection(model: EditorModelView, route: string, target: SelectionTarget): ResolvedSelection | null {
  if (!(target.kind in ID_SCHEMA) || !ID_SCHEMA[target.kind].safeParse(target.id).success) return null;
  const page = model.pages.find((p) => p.route === route);
  if (!page) return null;
  const id = target.id;
  switch (target.kind) {
    case 'page':
      return page.pageId === id ? { kind: 'page', id, page } : null;
    case 'section': {
      const index = page.sections.findIndex((s) => s.sectionId === id);
      return index >= 0 ? { kind: 'section', id, page, section: page.sections[index]!, index } : null;
    }
    case 'block': {
      for (const section of page.sections) {
        const index = section.blocks.findIndex((b) => b.blockId === id);
        if (index >= 0) return { kind: 'block', id, page, section, block: section.blocks[index]!, index };
      }
      return null;
    }
    case 'field': {
      const own = page.fields.find((f) => f.fieldId === id);
      if (own) return { kind: 'field', id, page, owner: { kind: 'page' }, field: own };
      for (const section of page.sections) {
        const heading = section.fields.find((f) => f.fieldId === id);
        if (heading) return { kind: 'field', id, page, owner: { kind: 'section', section }, field: heading };
        for (const block of section.blocks) {
          const field = block.fields.find((f) => f.fieldId === id);
          if (field) return { kind: 'field', id, page, owner: { kind: 'block', section, block }, field };
        }
      }
      return null;
    }
    case 'asset': {
      const asset = model.assets.find((a) => a.assetId === id);
      const usedHere = page.sections.some((s) => s.blocks.some((b) => b.fields.some((f) => f.type === 'asset' && f.value === id)));
      return asset && usedHere ? { kind: 'asset', id, page, asset } : null;
    }
  }
}

/**
 * The selection one click makes: the highest-precedence marker present, resolved
 * against the model — or `null` if that marker does not resolve. A lower marker
 * is never substituted for an unresolvable higher one.
 */
export function selectFromMarkers(model: EditorModelView, route: string, markers: MarkerChain): ResolvedSelection | null {
  const kind = SELECTION_PRECEDENCE.find((k) => markers[k] !== undefined);
  if (!kind) return null;
  return resolveSelection(model, route, { kind, id: markers[kind]! });
}
