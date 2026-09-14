/**
 * Semantic-edit identity, offline: the intent id, the job spec and job id, the
 * job origin and the source snapshot contract — each deterministic from exact
 * immutable inputs, each distinct from every other kind of build, and none
 * carrying a person, session or time.
 */
import { describe, expect, it } from 'vitest';
import { JobOrigin, SEMANTIC_EDIT_SOURCE_LIMITS, SEMANTIC_EDIT_SOURCE_SCHEMA_VERSION, SemanticEditSource, VISUAL_REFINEMENT_SOURCE_LIMITS } from '@statxai/contracts';
import { contentHash } from '@statxai/workspace';
import { createFrontendBackendJobSpec, createFrontendBackendSemanticEditJobSpec, createFrontendBackendVisualRefinementJobSpec } from '../src/job-specs/frontend-backend.js';
import { FRONTEND_BACKEND_INPUT, isSemanticEditSpec, isVisualRefinementSpec } from '../src/job-handlers/frontend-backend.js';
import { semanticEditIntentId } from '../src/semantic-edit/apply.js';

const ref = (name: string, version: number, hash: string) => ({ name, version, contentHash: hash.repeat(64).slice(0, 64) });
const profile = ref('business-profile', 1, 'a');
const plan = ref('site-plan', 1, 'b');
const m0 = ref('editable-site-model', 1, 'c');
const m1 = ref('editable-site-model', 2, 'd');
const m2 = ref('editable-site-model', 3, 'e');
const source1 = ref('semantic-edit-source', 1, 'f');
const source2 = ref('semantic-edit-source', 2, '9');

const edit = (over: Partial<Parameters<typeof createFrontendBackendSemanticEditJobSpec>[0]> = {}) =>
  createFrontendBackendSemanticEditJobSpec({ projectId: 'proj_x', businessProfileRef: profile, sitePlanRef: plan, semanticEditSourceRef: source1, baseEditableSiteModelRef: m0, editableSiteModelRef: m1, ...over });

describe('semantic-edit intent identity', () => {
  const identity = { projectId: 'proj_x', sourceDraftId: 'canonical-draft-1', predecessorBindingId: 'frontend-backend-build-b0', baseEditableSiteModel: m0, patchDigest: 'a'.repeat(64) };

  it('is deterministic, well-formed, and changes with every input', () => {
    expect(semanticEditIntentId(identity)).toBe(semanticEditIntentId({ ...identity, baseEditableSiteModel: { ...m0 } }));
    expect(semanticEditIntentId(identity)).toMatch(/^semantic-edit-[a-f0-9]{64}$/);
    for (const [key, value] of [
      ['projectId', 'proj_y'],
      ['sourceDraftId', 'canonical-draft-2'],
      ['predecessorBindingId', 'frontend-backend-build-b1'],
      ['baseEditableSiteModel', m1],
      ['patchDigest', 'b'.repeat(64)],
    ] as const) {
      expect(semanticEditIntentId({ ...identity, [key]: value }), key).not.toBe(semanticEditIntentId(identity));
    }
    // A timestamp or session riding along changes nothing, because nothing else is read.
    expect(semanticEditIntentId({ ...identity, requestedAt: new Date(), sessionId: 's' } as typeof identity)).toBe(semanticEditIntentId(identity));
  });
});

describe('semantic-edit job spec', () => {
  it('is deterministic, pins the exact source, base and result, and grants no more than a build', () => {
    const spec = edit();
    expect(edit()).toEqual(spec);
    expect(spec.jobId).toMatch(/^job_frontend_backend_[a-f0-9]{64}$/);
    expect(spec.inputs).toEqual({
      [FRONTEND_BACKEND_INPUT.businessProfile]: profile,
      [FRONTEND_BACKEND_INPUT.sitePlan]: plan,
      [FRONTEND_BACKEND_INPUT.semanticEditSource]: source1,
      [FRONTEND_BACKEND_INPUT.baseEditableSiteModel]: m0,
      [FRONTEND_BACKEND_INPUT.editableSiteModel]: m1,
    });
    expect(spec.allowedTools).toEqual(['filesystem', 'test_runner']);
    expect(spec.output).toEqual(['app/']);
    expect(isSemanticEditSpec(spec)).toBe(true);
    expect(isVisualRefinementSpec(spec)).toBe(false);
    expect(JSON.stringify(spec)).not.toMatch(/customer|session|token|Date|createdAt/i);
  });

  it('is distinct from the initial build, a refinement, and another edit — and B1 differs from B2', () => {
    const initial = createFrontendBackendJobSpec({ projectId: 'proj_x', businessProfileRef: profile, sitePlanRef: plan, editableSiteModelRef: m1 });
    const refinement = createFrontendBackendVisualRefinementJobSpec({ projectId: 'proj_x', businessProfileRef: profile, sitePlanRef: plan, editableSiteModelRef: m1, visualRefinementSourceRef: source1, visualQualityReviewRef: ref('visual-quality-review', 1, '1'), screenshotSetRef: ref('screenshot-set', 1, '2') });
    const b1 = edit();
    const b2 = edit({ semanticEditSourceRef: source2, baseEditableSiteModelRef: m1, editableSiteModelRef: m2 });
    const ids = [initial.jobId, refinement.jobId, b1.jobId, b2.jobId, edit({ editableSiteModelRef: m2 }).jobId, edit({ semanticEditSourceRef: source2 }).jobId, edit({ baseEditableSiteModelRef: m2 }).jobId];
    expect(new Set(ids).size).toBe(ids.length);
    expect(b1.objective).not.toBe(initial.objective);
    expect(b1.objective).not.toBe(refinement.objective);
  });

  it('refuses a ref without its exact content hash', () => {
    expect(() => edit({ editableSiteModelRef: { name: 'editable-site-model', version: 2 } })).toThrow(/content hash/);
    expect(() => edit({ semanticEditSourceRef: { name: 'semantic-edit-source', version: 1 } })).toThrow(/content hash/);
  });
});

describe('semantic-edit job origin', () => {
  const intentId = `semantic-edit-${'a'.repeat(64)}`;

  it('is its own kind, carrying only the intent id', () => {
    expect(JobOrigin.parse({ kind: 'semantic_edit', intentId })).toEqual({ kind: 'semantic_edit', intentId });
    expect(JobOrigin.safeParse({ kind: 'semantic_edit', intentId, customerUserId: 'cu_1' }).success).toBe(false);
    expect(JobOrigin.safeParse({ kind: 'semantic_edit', intentId, sessionId: 's' }).success).toBe(false);
    expect(JobOrigin.safeParse({ kind: 'semantic_edit', intentId: 'not-an-intent' }).success).toBe(false);
    expect(JobOrigin.safeParse({ kind: 'semantic_edit' }).success).toBe(false);
  });

  it('is never a replan or a visual refinement', () => {
    const parsed = JobOrigin.parse({ kind: 'semantic_edit', intentId });
    expect(parsed.kind).not.toBe('replan');
    expect(parsed.kind).not.toBe('visual_refine');
    expect(JobOrigin.safeParse({ kind: 'replan', intentId }).success).toBe(false);
    expect(JobOrigin.safeParse({ kind: 'visual_refine', intentId }).success).toBe(false);
  });
});

describe('semantic-edit source snapshot', () => {
  const files = [{ path: 'app/page.tsx', contents: 'x' }];
  const valid = {
    schemaVersion: SEMANTIC_EDIT_SOURCE_SCHEMA_VERSION,
    projectId: 'proj_x',
    intentId: `semantic-edit-${'a'.repeat(64)}`,
    sourceDraftId: 'canonical-draft-1',
    predecessorBindingId: 'frontend-backend-build-b0',
    promotionId: 'promotion-1',
    promotionCommitSha: 'a'.repeat(40),
    sourceCommit: 'b'.repeat(40),
    baseEditableSiteModel: m0,
    editableSiteModel: m1,
    patch: { baseModel: m0, operation: { op: 'set_field_value', fieldId: 'fld_0123456789abcdef', expected: 'H', value: 'New' } },
    files,
    filesDigest: contentHash(files),
  };

  it('binds the project, intent, draft, predecessor, promotion, commit, both models, the patch and a digest — strictly', () => {
    expect(SemanticEditSource.parse(valid)).toEqual(valid);
    for (const key of ['intentId', 'sourceDraftId', 'predecessorBindingId', 'promotionCommitSha', 'sourceCommit', 'baseEditableSiteModel', 'editableSiteModel', 'patch', 'filesDigest'] as const) {
      const missing: Record<string, unknown> = { ...valid };
      delete missing[key];
      expect(SemanticEditSource.safeParse(missing).success, key).toBe(false);
    }
    expect(SemanticEditSource.safeParse({ ...valid, sessionId: 's' }).success).toBe(false);
    expect(SemanticEditSource.safeParse({ ...valid, editableSiteModel: { ...m1, name: 'site-plan' } }).success).toBe(false);
  });

  it('uses the proven source bounds, and refuses more files than they allow', () => {
    expect(SEMANTIC_EDIT_SOURCE_LIMITS).toEqual(VISUAL_REFINEMENT_SOURCE_LIMITS);
    const many = Array.from({ length: SEMANTIC_EDIT_SOURCE_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `app/p${i}.tsx`, contents: '' }));
    expect(SemanticEditSource.safeParse({ ...valid, files: many, filesDigest: contentHash(many) }).success).toBe(false);
  });
});
