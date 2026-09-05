/**
 * The one production `frontend_backend` `JobSpec` factory (Phase 5j).
 *
 * Pure-function properties only — no Mongo, no filesystem. The factory's
 * interaction with a real registry (exact ref vs. a newer competing version,
 * threaded value/ref correspondence) is covered by
 * `frontend-backend-build-boundary.integration.test.ts` instead, since that
 * needs a real `ArtifactRegistry`.
 */
import { describe, expect, it } from 'vitest';
import { contentHash } from '@statxai/workspace';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import { FRONTEND_BACKEND_INPUT } from '../src/job-handlers/frontend-backend.js';

const REF_V1 = { name: 'business-profile', version: 1 };
const PLAN_V1 = { name: 'site-plan', version: 1 };

const INPUT = {
  projectId: 'proj_5j_unit',
  businessProfileRef: REF_V1,
  sitePlanRef: PLAN_V1,
};

describe('createFrontendBackendJobSpec — shape', () => {
  it('produces the fixed frontend_backend job conventions', () => {
    const spec = createFrontendBackendJobSpec(INPUT);

    expect(spec.role).toBe('frontend_backend');
    expect(spec.objective).toBe('Build the site from the approved plan.');
    expect(spec.acceptanceCriteria).toEqual(['site files written from the approved plan']);
    expect(spec.allowedTools).toEqual([]);
    expect(spec.output).toEqual(['app/']);
    expect(spec.projectId).toBe(INPUT.projectId);
  });

  it('pins the inputs under the exact keys Phase 5i requires', () => {
    const spec = createFrontendBackendJobSpec(INPUT);
    expect(spec.inputs[FRONTEND_BACKEND_INPUT.businessProfile]).toEqual(REF_V1);
    expect(spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan]).toEqual(PLAN_V1);
    expect(Object.keys(spec.inputs)).toHaveLength(2);
  });

  it('the output identity is the same fixed literal across different projects and refs — never parameterised', () => {
    const a = createFrontendBackendJobSpec(INPUT);
    const b = createFrontendBackendJobSpec({
      projectId: 'a-completely-different-project',
      businessProfileRef: { name: 'business-profile', version: 7 },
      sitePlanRef: { name: 'site-plan', version: 9 },
    });
    expect(a.output).toEqual(['app/']);
    expect(b.output).toEqual(['app/']);
  });

  it('the jobId is namespaced with the documented "frontend-backend-" prefix', () => {
    const spec = createFrontendBackendJobSpec(INPUT);
    expect(spec.jobId.startsWith('frontend-backend-')).toBe(true);
  });
});

describe('createFrontendBackendJobSpec — deterministic identity', () => {
  it('the same input always produces the exact same JobSpec, including jobId', () => {
    const a = createFrontendBackendJobSpec(INPUT);
    const b = createFrontendBackendJobSpec(INPUT);
    expect(a).toEqual(b);
    expect(a.jobId).toBe(b.jobId);
  });

  it('jobId is exactly frontend-backend- + contentHash of the JobSpec identity (jobId excluded)', () => {
    const spec = createFrontendBackendJobSpec(INPUT);
    const { jobId, ...identity } = spec;
    expect(jobId).toBe(`frontend-backend-${contentHash(identity)}`);
  });

  it('a changed projectId changes the jobId', () => {
    const a = createFrontendBackendJobSpec(INPUT);
    const b = createFrontendBackendJobSpec({ ...INPUT, projectId: 'a-different-project' });
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('a changed businessProfileRef version changes the jobId', () => {
    const a = createFrontendBackendJobSpec(INPUT);
    const b = createFrontendBackendJobSpec({ ...INPUT, businessProfileRef: { ...REF_V1, version: 2 } });
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('a changed businessProfileRef name changes the jobId', () => {
    const a = createFrontendBackendJobSpec(INPUT);
    const b = createFrontendBackendJobSpec({ ...INPUT, businessProfileRef: { ...REF_V1, name: 'a-different-name' } });
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('a changed sitePlanRef version changes the jobId', () => {
    const a = createFrontendBackendJobSpec(INPUT);
    const b = createFrontendBackendJobSpec({ ...INPUT, sitePlanRef: { ...PLAN_V1, version: 2 } });
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('a changed sitePlanRef name changes the jobId', () => {
    const a = createFrontendBackendJobSpec(INPUT);
    const b = createFrontendBackendJobSpec({ ...INPUT, sitePlanRef: { ...PLAN_V1, name: 'a-different-name' } });
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('swapping which ref is which changes the jobId — the two inputs are not interchangeable', () => {
    const a = createFrontendBackendJobSpec({
      projectId: 'proj_5j_swap',
      businessProfileRef: { name: 'shared-name', version: 1 },
      sitePlanRef: { name: 'shared-name', version: 2 },
    });
    const b = createFrontendBackendJobSpec({
      projectId: 'proj_5j_swap',
      businessProfileRef: { name: 'shared-name', version: 2 },
      sitePlanRef: { name: 'shared-name', version: 1 },
    });
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('the same input reproduces the same job identity across repeated calls — the basis for Phase 5i job reuse', () => {
    const ids = Array.from({ length: 5 }, () => createFrontendBackendJobSpec(INPUT).jobId);
    expect(new Set(ids).size).toBe(1);
  });
});

describe('createFrontendBackendJobSpec — excludes runtime state from identity', () => {
  it('carries no field beyond the fixed JobSpec surface — no createdAt, workerId, attempt, or lease-shaped field', () => {
    const spec = createFrontendBackendJobSpec(INPUT);
    expect(Object.keys(spec).sort()).toEqual(
      ['acceptanceCriteria', 'allowedTools', 'inputs', 'jobId', 'objective', 'output', 'projectId', 'role'].sort(),
    );
  });
});
