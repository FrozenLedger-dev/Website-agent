/**
 * The editable site model as a durable artifact.
 *
 * Every version is an immutable `editable-site-model` artifact with an exact
 * ref; a new version never overwrites an old one, and its provenance names the
 * exact version (or plan) it came from. Every read is by exact ref, verified
 * against its content hash — never "the latest model".
 */
import { EDITABLE_SITE_MODEL_ARTIFACT, EditableSiteModel, type ArtifactRef, type SemanticPatch } from '@statxai/contracts';
import type { ArtifactRegistry } from '@statxai/workspace';
import { applySemanticPatch } from './patch.js';

/** A model ref that does not resolve to exactly the model it names. */
export class EditableSiteModelRefInvalid extends Error {
  constructor(ref: ArtifactRef, detail: string) {
    super(`${ref.name}@${ref.version} is not a usable editable site model: ${detail}`);
    this.name = 'EditableSiteModelRefInvalid';
  }
}

/** Record one model version. Validated before it is written; the ref carries its content hash. */
export async function recordEditableSiteModel(
  registry: ArtifactRegistry,
  projectId: string,
  model: EditableSiteModel,
): Promise<{ readonly ref: ArtifactRef; readonly model: EditableSiteModel }> {
  const valid = EditableSiteModel.parse(model);
  if (valid.projectId !== projectId) throw new Error(`editable site model for "${valid.projectId}" cannot be recorded under "${projectId}"`);
  const ref = await registry.put(projectId, EDITABLE_SITE_MODEL_ARTIFACT, valid);
  return { ref, model: valid };
}

/** Resolve exactly the model a ref names, proven by name, content hash, schema and project. */
export async function resolveEditableSiteModel(registry: ArtifactRegistry, projectId: string, ref: ArtifactRef): Promise<EditableSiteModel> {
  if (ref.name !== EDITABLE_SITE_MODEL_ARTIFACT) throw new EditableSiteModelRefInvalid(ref, 'not an editable-site-model ref');
  if (!ref.contentHash) throw new EditableSiteModelRefInvalid(ref, 'the ref carries no content hash');
  const doc = await registry.getDocument(projectId, ref);
  if (!doc) throw new EditableSiteModelRefInvalid(ref, 'no such version');
  if (doc.contentHash !== ref.contentHash) throw new EditableSiteModelRefInvalid(ref, 'the stored content does not match the ref');
  const parsed = EditableSiteModel.safeParse(doc.data);
  if (!parsed.success) throw new EditableSiteModelRefInvalid(ref, 'the stored content is not a valid model');
  if (parsed.data.projectId !== projectId) throw new EditableSiteModelRefInvalid(ref, 'it belongs to another project');
  return parsed.data;
}

/** Apply one semantic patch to the exact version it names, and record the result as a new version. The base is never rewritten. */
export async function commitSemanticPatch(
  registry: ArtifactRegistry,
  projectId: string,
  patch: SemanticPatch,
): Promise<{ readonly ref: ArtifactRef; readonly model: EditableSiteModel }> {
  const base = await resolveEditableSiteModel(registry, projectId, patch.baseModel);
  const next = applySemanticPatch({ baseRef: patch.baseModel, base, patch });
  return recordEditableSiteModel(registry, projectId, next);
}
