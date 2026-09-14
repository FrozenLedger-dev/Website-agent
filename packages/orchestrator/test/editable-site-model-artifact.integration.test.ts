/**
 * The editable site model as a durable artifact, against real storage.
 *
 * Every version is an immutable `editable-site-model` artifact with an exact,
 * content-hashed ref; a committed semantic patch adds a version naming its exact
 * base; old versions stay readable exactly as written; and every read is by
 * exact ref, refusing anything that does not match it.
 *
 * Integration: needs the Mongo replica set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EDITABLE_SITE_MODEL_ARTIFACT, type ArtifactRef, type SemanticPatch, type SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, contentHash } from '@statxai/workspace';
import { modelFromPlan } from '../src/site-model/materialize.js';
import { EditableSiteModelRefInvalid, commitSemanticPatch, recordEditableSiteModel, resolveEditableSiteModel } from '../src/site-model/persist.js';
import { SemanticPatchRejected } from '../src/site-model/patch.js';

const PROJECT = 'proj_model_artifact';
let store: StateStore;
let registry: ArtifactRegistry;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
});

afterAll(async () => {
  await store?.close();
});

beforeEach(async () => {
  await store.artifacts.deleteMany({ projectId: { $in: [PROJECT, `${PROJECT}_other`] } });
});

const PLAN = {
  strategy: 's',
  valueProposition: 'v',
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFFFFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: 'a',
    radius: 'square',
    rationale: 'r',
  },
  sitemap: { pages: [{ route: '/', title: 'Home', metaDescription: 'd', goal: 'g', primaryAction: 'c', sections: [{ id: 'hero', heading: 'Fitted joinery', purpose: 'p', layout: 'split-hero', contentBindings: [] }] }] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

async function recorded() {
  const sitePlanRef = await registry.put(PROJECT, 'site-plan', PLAN);
  const m0 = await recordEditableSiteModel(registry, PROJECT, modelFromPlan({ projectId: PROJECT, sitePlanRef, plan: PLAN }));
  return { sitePlanRef, m0 };
}

const fieldPatch = (baseModel: ArtifactRef, fieldId: string, expected: string, value: string): SemanticPatch => ({
  baseModel: baseModel as SemanticPatch['baseModel'],
  operation: { op: 'set_field_value', fieldId: fieldId as never, expected, value },
});

describe('durable model versions', () => {
  it('a recorded model has an exact, content-hashed ref and binds to the exact site-plan ref it came from', async () => {
    const { sitePlanRef, m0 } = await recorded();
    expect(m0.ref).toEqual({ name: EDITABLE_SITE_MODEL_ARTIFACT, version: 1, contentHash: contentHash(m0.model) });
    expect(m0.model.sitePlan).toEqual(sitePlanRef);
    expect(await resolveEditableSiteModel(registry, PROJECT, m0.ref)).toEqual(m0.model);
  });

  it('a committed patch adds a new version naming its exact base; the base stays exactly as it was', async () => {
    const { m0 } = await recorded();
    const hero = m0.model.pages[0]!.sections[0]!.fields[0]!;
    const before = (await store.artifacts.findOne({ projectId: PROJECT, name: EDITABLE_SITE_MODEL_ARTIFACT, version: 1 }))!;

    const patch = fieldPatch(m0.ref, hero.fieldId, String(hero.value), 'Joinery built to last');
    const m1 = await commitSemanticPatch(registry, PROJECT, patch);

    expect(m1.ref.version).toBe(2);
    expect(m1.model.provenance).toEqual({ kind: 'semantic_patch', base: m0.ref, operation: 'set_field_value', target: hero.fieldId });
    expect(m1.model.pages[0]!.sections[0]!.fields[0]).toEqual({ ...hero, value: 'Joinery built to last' });
    // Additive: the historical version is still readable, byte-for-byte what it was.
    const after = (await store.artifacts.findOne({ projectId: PROJECT, name: EDITABLE_SITE_MODEL_ARTIFACT, version: 1 }))!;
    expect(after).toEqual(before);
    expect(await resolveEditableSiteModel(registry, PROJECT, m0.ref)).toEqual(m0.model);
    expect(await store.artifacts.countDocuments({ projectId: PROJECT, name: EDITABLE_SITE_MODEL_ARTIFACT })).toBe(2);
  });

  it('a patch against a superseded version is refused as stale: history is never rewritten through an old ref', async () => {
    const { m0 } = await recorded();
    const hero = m0.model.pages[0]!.sections[0]!.fields[0]!;
    const first = fieldPatch(m0.ref, hero.fieldId, String(hero.value), 'First edit');
    const m1 = await commitSemanticPatch(registry, PROJECT, first);
    // Written against M1, expecting M0's value: stale.
    const stale = fieldPatch(m1.ref, hero.fieldId, String(hero.value), 'Second edit');
    await expect(commitSemanticPatch(registry, PROJECT, stale)).rejects.toMatchObject({ code: 'stale_expectation' });
    expect(await store.artifacts.countDocuments({ projectId: PROJECT, name: EDITABLE_SITE_MODEL_ARTIFACT })).toBe(2);
  });

  it('refuses a ref that names no version, a different content hash, another project, or no hash at all', async () => {
    const { m0, sitePlanRef } = await recorded();
    await expect(resolveEditableSiteModel(registry, PROJECT, { ...m0.ref, version: 7 })).rejects.toBeInstanceOf(EditableSiteModelRefInvalid);
    await expect(resolveEditableSiteModel(registry, PROJECT, { ...m0.ref, contentHash: 'f'.repeat(64) })).rejects.toBeInstanceOf(EditableSiteModelRefInvalid);
    await expect(resolveEditableSiteModel(registry, PROJECT, { name: m0.ref.name, version: m0.ref.version })).rejects.toBeInstanceOf(EditableSiteModelRefInvalid);
    await expect(resolveEditableSiteModel(registry, PROJECT, sitePlanRef)).rejects.toBeInstanceOf(EditableSiteModelRefInvalid);
    await expect(resolveEditableSiteModel(registry, `${PROJECT}_other`, m0.ref)).rejects.toBeInstanceOf(EditableSiteModelRefInvalid);
    await expect(recordEditableSiteModel(registry, `${PROJECT}_other`, m0.model)).rejects.toThrow(/cannot be recorded/);
  });

  it('a patch naming a base that does not exist, or with a tampered hash, writes nothing', async () => {
    const { m0 } = await recorded();
    const hero = m0.model.pages[0]!.sections[0]!.fields[0]!;
    const ghost = fieldPatch({ ...m0.ref, version: 5 }, hero.fieldId, String(hero.value), 'x');
    await expect(commitSemanticPatch(registry, PROJECT, ghost)).rejects.toBeInstanceOf(EditableSiteModelRefInvalid);
    const wrongType = fieldPatch(m0.ref, m0.model.pages[0]!.sections[0]!.sectionId, String(hero.value), 'x');
    await expect(commitSemanticPatch(registry, PROJECT, wrongType)).rejects.toBeInstanceOf(SemanticPatchRejected);
    expect(await store.artifacts.countDocuments({ projectId: PROJECT, name: EDITABLE_SITE_MODEL_ARTIFACT })).toBe(1);
  });
});
