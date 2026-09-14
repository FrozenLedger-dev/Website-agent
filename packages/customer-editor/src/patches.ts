/**
 * Editor controls, compiled to the one existing semantic patch contract.
 *
 * Browser-safe. Every builder returns a `SemanticPatch` parsed by the contract's
 * own schema, and every value is checked by the contract's own field schema —
 * there is no second notion of what an edit is. The server re-proves all of it
 * against the exact current model before anything is recorded.
 *
 * The browser never names a new semantic ID (`add_block` has none to give), never
 * sets an asset's contents, and never touches design tokens, CSS or source.
 */
import {
  SUPPORTED_BLOCKS,
  SemanticPatch,
  SiteField,
  SiteSection,
  type BlockKind,
} from '@statxai/contracts/editable-site-model';
import type { EditorPageView, EditorSectionView } from './model-view.js';

/** The bounded section layouts, exactly as the model contract declares them. */
const SectionLayout = SiteSection.shape.layout;

/** An exact, hash-carrying model version — exactly the contract's patch base. */
export type ExactModelRef = SemanticPatch['baseModel'];

export class EditorPatchInvalid extends Error {
  constructor(readonly problem: 'invalid_value' | 'unsupported') {
    super(problem === 'invalid_value' ? 'That value is not valid for this field.' : 'That change is not supported here.');
    this.name = 'EditorPatchInvalid';
  }
}

/** Field types this editor changes directly. An asset slot is shown, never chosen, until a safe asset workflow exists. */
export const EDITABLE_FIELD_TYPES = Object.freeze(['text', 'cta', 'phone', 'email', 'address'] as const);
export type EditableFieldType = (typeof EDITABLE_FIELD_TYPES)[number];

/** Block kinds a customer may add: every supported kind whose fields this editor can fill. */
export const ADDABLE_BLOCK_KINDS: readonly BlockKind[] = Object.freeze(
  (Object.keys(SUPPORTED_BLOCKS) as BlockKind[]).filter((kind) => SUPPORTED_BLOCKS[kind].every((slot) => (EDITABLE_FIELD_TYPES as readonly string[]).includes(slot.type))),
);

export const SECTION_LAYOUTS: readonly string[] = Object.freeze([...SectionLayout.options]);

function patch(baseModel: ExactModelRef, operation: unknown): SemanticPatch {
  const parsed = SemanticPatch.safeParse({ baseModel: { name: baseModel.name, version: baseModel.version, contentHash: baseModel.contentHash }, operation });
  if (!parsed.success) throw new EditorPatchInvalid('invalid_value');
  return parsed.data;
}

/** The contract's value schema for one field type. */
function fieldValueSchema(type: SiteField['type']): { safeParse(value: unknown): { success: boolean } } {
  const option = SiteField.options.find((o) => o.shape.type.value === type);
  if (!option) throw new EditorPatchInvalid('unsupported');
  return option.shape.value;
}

/** Whether `value` is a valid value for exactly this field, by the contract's own field schema. */
export function isValidFieldValue(field: SiteField, value: unknown): boolean {
  return SiteField.safeParse({ ...field, value }).success;
}

export function setFieldValuePatch(baseModel: ExactModelRef, field: SiteField, value: unknown): SemanticPatch {
  if (!(EDITABLE_FIELD_TYPES as readonly string[]).includes(field.type)) throw new EditorPatchInvalid('unsupported');
  if (!isValidFieldValue(field, value)) throw new EditorPatchInvalid('invalid_value');
  return patch(baseModel, { op: 'set_field_value', fieldId: field.fieldId, expected: field.value, value });
}

export function setVisibilityPatch(baseModel: ExactModelRef, targetId: string, visibility: 'visible' | 'hidden'): SemanticPatch {
  return patch(baseModel, { op: 'set_visibility', targetId, visibility });
}

export function setSectionLayoutPatch(baseModel: ExactModelRef, section: EditorSectionView, layout: string): SemanticPatch {
  if (!SectionLayout.safeParse(layout).success) throw new EditorPatchInvalid('invalid_value');
  return patch(baseModel, { op: 'set_section_layout', sectionId: section.sectionId, expected: section.layout, layout });
}

/** Move a section one place up or down within its own page. The section keeps its ID. */
export function moveSectionPatch(baseModel: ExactModelRef, page: EditorPageView, sectionId: string, direction: 'up' | 'down'): SemanticPatch {
  const index = page.sections.findIndex((s) => s.sectionId === sectionId);
  const toIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || toIndex < 0 || toIndex >= page.sections.length) throw new EditorPatchInvalid('unsupported');
  return patch(baseModel, { op: 'move_section', sectionId, toIndex });
}

/** Add one block of a supported kind at the end of a section. Its IDs are minted by the harness. */
export function addBlockPatch(baseModel: ExactModelRef, section: EditorSectionView, kind: BlockKind, values: Record<string, unknown>): SemanticPatch {
  if (!ADDABLE_BLOCK_KINDS.includes(kind)) throw new EditorPatchInvalid('unsupported');
  const slots = SUPPORTED_BLOCKS[kind];
  if (Object.keys(values).sort().join() !== slots.map((s) => s.key).sort().join()) throw new EditorPatchInvalid('invalid_value');
  // Each value by the contract's own value schema for its slot's field type; the harness mints the field's identity.
  for (const slot of slots) if (!fieldValueSchema(slot.type).safeParse(values[slot.key]).success) throw new EditorPatchInvalid('invalid_value');
  return patch(baseModel, { op: 'add_block', sectionId: section.sectionId, index: section.blocks.length, kind, values });
}

export function removeBlockPatch(baseModel: ExactModelRef, blockId: string): SemanticPatch {
  return patch(baseModel, { op: 'remove_block', blockId });
}
