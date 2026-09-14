/**
 * Semantic patches: exact model + one validated operation → exact new model.
 *
 * Pure. No store, registry, workspace, model or clock: the same base, base ref
 * and patch always produce the same result, and the base is never touched —
 * the result is a new model whose provenance names the exact base it came from.
 * Nothing here writes source, builds or deploys; applying a new model to code
 * is later work.
 *
 * Every refusal is a typed code, decided before anything is produced:
 *
 * - `base_mismatch`      the patch was written against a different model version;
 * - `invalid_patch`      the patch is not a valid operation at all;
 * - `wrong_target_type`  the target is a real ID of the wrong kind for the operation;
 * - `unknown_target`     no such object in the base;
 * - `stale_expectation`  the value the author saw is no longer the value there;
 * - `invalid_value`      the new value does not satisfy its type;
 * - `invariant_violation` the result would not be a valid model.
 */
import {
  DesignTokens,
  EditableSiteModel,
  SUPPORTED_BLOCKS,
  SectionId,
  SemanticPatch,
  SiteAsset,
  SiteField,
  type ArtifactRef,
  type SiteBlock,
  type SiteField as SiteFieldType,
} from '@statxai/contracts';
import { contentHash } from '@statxai/workspace';
import { IdentityAllocator, derivedId, usedIds } from './identity.js';

export type SemanticPatchRejection =
  | 'base_mismatch'
  | 'invalid_patch'
  | 'wrong_target_type'
  | 'unknown_target'
  | 'stale_expectation'
  | 'invalid_value'
  | 'invariant_violation';

export class SemanticPatchRejected extends Error {
  constructor(
    readonly code: SemanticPatchRejection,
    detail: string,
  ) {
    super(`semantic patch rejected (${code}): ${detail}`);
    this.name = 'SemanticPatchRejected';
  }
}

const reject = (code: SemanticPatchRejection, detail: string) => new SemanticPatchRejected(code, detail);
const same = (a: unknown, b: unknown) => contentHash(a) === contentHash(b);
const ID_SCHEMAS = { pg: 'page', sec: 'section', blk: 'block', fld: 'field', ast: 'asset' } as const;

/** Which ID each operation targets, and the kinds it accepts there. */
const TARGETS: Record<string, { readonly field: string; readonly kinds: readonly string[] }> = {
  set_field_value: { field: 'fieldId', kinds: ['fld'] },
  set_asset: { field: 'assetId', kinds: ['ast'] },
  set_visibility: { field: 'targetId', kinds: ['sec', 'blk'] },
  move_section: { field: 'sectionId', kinds: ['sec'] },
  set_section_layout: { field: 'sectionId', kinds: ['sec'] },
  add_block: { field: 'sectionId', kinds: ['sec'] },
  remove_block: { field: 'blockId', kinds: ['blk'] },
};

function sameExactRef(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.name === b.name && a.version === b.version && a.contentHash !== undefined && a.contentHash === b.contentHash;
}

function locateSection(model: EditableSiteModel, sectionId: string) {
  for (const page of model.pages) {
    const index = page.sections.findIndex((s) => s.sectionId === sectionId);
    if (index >= 0) return { page, section: page.sections[index]!, index };
  }
  return null;
}

function locateBlock(model: EditableSiteModel, blockId: string) {
  for (const page of model.pages) {
    for (const section of page.sections) {
      const index = section.blocks.findIndex((b) => b.blockId === blockId);
      if (index >= 0) return { section, block: section.blocks[index]!, index };
    }
  }
  return null;
}

function locateField(model: EditableSiteModel, fieldId: string): SiteFieldType | null {
  for (const page of model.pages) {
    for (const field of page.fields) if (field.fieldId === fieldId) return field;
    for (const section of page.sections) {
      for (const field of section.fields) if (field.fieldId === fieldId) return field;
      for (const block of section.blocks) for (const field of block.fields) if (field.fieldId === fieldId) return field;
    }
  }
  return null;
}

function tokenGet(design: EditableSiteModel['design'], path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], design);
}

function tokenSet(design: EditableSiteModel['design'], path: string, value: string): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, design as unknown as Record<string, unknown>);
  parent[last] = value;
}

export function applySemanticPatch(input: {
  /** The exact ref the base was resolved from. */
  readonly baseRef: ArtifactRef;
  readonly base: EditableSiteModel;
  readonly patch: unknown;
}): EditableSiteModel {
  const raw = input.patch as { operation?: { op?: string } & Record<string, unknown> };
  const target = raw?.operation?.op ? TARGETS[raw.operation.op] : undefined;
  if (target) {
    const id = raw.operation![target.field];
    const prefix = typeof id === 'string' ? id.slice(0, id.indexOf('_')) : '';
    if (prefix in ID_SCHEMAS && !target.kinds.includes(prefix)) {
      throw reject('wrong_target_type', `${raw.operation!.op} targets a ${target.kinds.join(' or ')}, not a ${ID_SCHEMAS[prefix as keyof typeof ID_SCHEMAS]} (${String(id)})`);
    }
  }
  const parsed = SemanticPatch.safeParse(input.patch);
  if (!parsed.success) throw reject('invalid_patch', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const patch = parsed.data;
  if (!sameExactRef(patch.baseModel, input.baseRef)) {
    throw reject('base_mismatch', `the patch was written against ${patch.baseModel.name}@${patch.baseModel.version}, not ${input.baseRef.name}@${input.baseRef.version}`);
  }

  const model = structuredClone(input.base);
  const operation = patch.operation;
  let targetId: string;

  switch (operation.op) {
    case 'set_field_value': {
      targetId = operation.fieldId;
      const field = locateField(model, operation.fieldId);
      if (!field) throw reject('unknown_target', `no field ${operation.fieldId}`);
      if (!same(field.value, operation.expected)) throw reject('stale_expectation', `field ${operation.fieldId} no longer has the expected value`);
      const next = SiteField.safeParse({ ...field, value: operation.value });
      if (!next.success) throw reject('invalid_value', `field ${operation.fieldId} is ${field.type}: ${next.error.issues[0]?.message ?? 'invalid'}`);
      field.value = next.data.value as never;
      break;
    }
    case 'set_asset': {
      targetId = operation.assetId;
      const asset = model.assets.find((a) => a.assetId === operation.assetId);
      if (!asset) throw reject('unknown_target', `no asset slot ${operation.assetId}`);
      if (!same(asset.source, operation.expected)) throw reject('stale_expectation', `asset slot ${operation.assetId} no longer has the expected source`);
      const next = SiteAsset.shape.source.safeParse(operation.source);
      if (!next.success) throw reject('invalid_value', 'the asset source is invalid');
      // The slot is the identity; only what fills it changes.
      asset.source = next.data;
      break;
    }
    case 'set_visibility': {
      targetId = operation.targetId;
      const found = SectionId.safeParse(operation.targetId).success ? locateSection(model, operation.targetId)?.section : locateBlock(model, operation.targetId)?.block;
      if (!found) throw reject('unknown_target', `no section or block ${operation.targetId}`);
      found.visibility = operation.visibility;
      break;
    }
    case 'move_section': {
      targetId = operation.sectionId;
      const found = locateSection(model, operation.sectionId);
      if (!found) throw reject('unknown_target', `no section ${operation.sectionId}`);
      if (operation.toIndex >= found.page.sections.length) throw reject('invalid_value', `index ${operation.toIndex} is outside ${found.page.route}`);
      const [moved] = found.page.sections.splice(found.index, 1);
      found.page.sections.splice(operation.toIndex, 0, moved!);
      break;
    }
    case 'set_section_layout': {
      targetId = operation.sectionId;
      const found = locateSection(model, operation.sectionId);
      if (!found) throw reject('unknown_target', `no section ${operation.sectionId}`);
      if (found.section.layout !== operation.expected) throw reject('stale_expectation', `section ${operation.sectionId} is no longer ${operation.expected}`);
      found.section.layout = operation.layout;
      break;
    }
    case 'set_design_token': {
      targetId = operation.token;
      if (tokenGet(model.design, operation.token) !== operation.expected) throw reject('stale_expectation', `${operation.token} is no longer ${operation.expected}`);
      tokenSet(model.design, operation.token, operation.value);
      const next = DesignTokens.safeParse(model.design);
      if (!next.success) throw reject('invalid_value', `${operation.token}: ${next.error.issues[0]?.message ?? 'invalid'}`);
      break;
    }
    case 'add_block': {
      targetId = operation.sectionId;
      const found = locateSection(model, operation.sectionId);
      if (!found) throw reject('unknown_target', `no section ${operation.sectionId}`);
      if (operation.index > found.section.blocks.length) throw reject('invalid_value', `index ${operation.index} is outside section ${operation.sectionId}`);
      const template = SUPPORTED_BLOCKS[operation.kind];
      const given = Object.keys(operation.values).sort();
      const wanted = template.map((f) => f.key).sort();
      if (given.join() !== wanted.join()) throw reject('invalid_value', `a ${operation.kind} block takes exactly ${wanted.join(', ')}`);

      // Minted under the lineage's own ledger: never an existing ID, never a retired one.
      const ids = new IdentityAllocator(model.projectId, model.identity);
      for (const id of usedIds(model)) ids.keep(id);
      const blockId = ids.mint('blk');
      const fields: SiteFieldType[] = [];
      for (const slot of template) {
        const fieldId = derivedId(model.projectId, 'fld', blockId, slot.key);
        const next = SiteField.safeParse({ fieldId, key: slot.key, type: slot.type, value: operation.values[slot.key] });
        if (!next.success) throw reject('invalid_value', `${operation.kind}.${slot.key}: ${next.error.issues[0]?.message ?? 'invalid'}`);
        fields.push(next.data);
      }
      const block: SiteBlock = { blockId, kind: operation.kind, visibility: 'visible', fields };
      found.section.blocks.splice(operation.index, 0, block);
      model.identity.minted = ids.minted;
      targetId = blockId;
      break;
    }
    case 'remove_block': {
      targetId = operation.blockId;
      const found = locateBlock(model, operation.blockId);
      if (!found) throw reject('unknown_target', `no block ${operation.blockId}`);
      found.section.blocks.splice(found.index, 1);
      // Retired with everything it carried: none of these IDs will ever name anything again.
      model.identity.retired = [...model.identity.retired, found.block.blockId, ...found.block.fields.map((f) => f.fieldId)].sort();
      break;
    }
    default: {
      const exhaustive: never = operation;
      throw reject('invalid_patch', `unsupported operation ${String((exhaustive as { op: string }).op)}`);
    }
  }

  model.provenance = { kind: 'semantic_patch', base: input.baseRef, operation: operation.op, target: targetId };
  const result = EditableSiteModel.safeParse(model);
  if (!result.success) throw reject('invariant_violation', result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

