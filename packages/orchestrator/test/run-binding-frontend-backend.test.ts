/**
 * Durable active frontend/backend build binding (Phase 5k) — pure-function
 * properties only. No Mongo, no filesystem: identity/hash determinism and
 * stored-spec integrity checking are exercised directly here; the durable
 * lookup/prepare/commit/finalize sequence needs a real `StateStore` and
 * `ProjectWorkspace` and is covered by
 * `frontend-backend-build-binding.integration.test.ts` instead.
 */
import { describe, expect, it } from 'vitest';
import type { ArtifactRef, JobSpec } from '@statxai/contracts';
import type { FrontendBackendBuildBindingDocument } from '@statxai/state';
import { contentHash } from '@statxai/workspace';
import {
  bindingMarker,
  computeBindingId,
  computeJobSpecHash,
  computeRunIntentHash,
  parseStoredJobSpec,
  specificationCommitMessage,
  verifyBindingConsistency,
  FrontendBackendBuildBindingCorrupt,
} from '../src/run-binding/frontend-backend.js';

const PROFILE = {
  businessName: 'Harrowgate Joinery',
  industry: 'Joinery',
  location: 'Harrogate',
  audience: 'Homeowners',
  services: [{ name: 'Wardrobes', description: 'Fitted wardrobes.' }],
  differentiators: ['Two joiners'],
  contact: { email: 'workshop@harrowgatejoinery.co.uk', phone: '01423 887 214' },
  tone: 'Warm',
  goals: ['Enquiries'],
};

const PROFILE_REF: ArtifactRef = { name: 'business-profile', version: 1, contentHash: 'a'.repeat(64) };
const PLAN_REF: ArtifactRef = { name: 'site-plan', version: 1, contentHash: 'b'.repeat(64) };

const SPEC: JobSpec = {
  projectId: 'proj_5k_unit',
  jobId: 'job_frontend_backend_deadbeef',
  role: 'frontend_backend',
  objective: 'Build the site from the approved plan.',
  inputs: { businessProfile: PROFILE_REF, sitePlan: PLAN_REF },
  acceptanceCriteria: ['site files written from the approved plan'],
  allowedTools: [],
  output: ['app/'],
};

const now = new Date();
const BINDING: FrontendBackendBuildBindingDocument = {
  _id: 'frontend-backend-build-binding-fixture',
  projectId: 'proj_5k_unit',
  status: 'prepared',
  runIntentHash: computeRunIntentHash({ projectId: 'proj_5k_unit', profile: PROFILE as never }),
  businessProfile: PROFILE_REF,
  sitePlan: PLAN_REF,
  jobSpec: SPEC,
  jobSpecHash: computeJobSpecHash(SPEC),
  jobId: SPEC.jobId,
  specificationBaseCommit: null,
  specificationCommitSha: null,
  promotionId: null,
  promotionCommitSha: null,
  createdAt: now,
  updatedAt: now,
};

describe('computeRunIntentHash', () => {
  it('is deterministic for the same projectId + canonical profile', () => {
    const a = computeRunIntentHash({ projectId: 'proj_a', profile: PROFILE as never });
    const b = computeRunIntentHash({ projectId: 'proj_a', profile: PROFILE as never });
    expect(a).toBe(b);
  });

  it('changes when projectId changes', () => {
    const a = computeRunIntentHash({ projectId: 'proj_a', profile: PROFILE as never });
    const b = computeRunIntentHash({ projectId: 'proj_b', profile: PROFILE as never });
    expect(a).not.toBe(b);
  });

  it('changes when the profile content changes', () => {
    const a = computeRunIntentHash({ projectId: 'proj_a', profile: PROFILE as never });
    const b = computeRunIntentHash({ projectId: 'proj_a', profile: { ...PROFILE, businessName: 'Different Co' } as never });
    expect(a).not.toBe(b);
  });

  it('two raw payloads that parse to the same canonical profile hash the same — property key order does not matter', () => {
    const reordered = Object.fromEntries(Object.entries(PROFILE).reverse());
    const a = computeRunIntentHash({ projectId: 'proj_a', profile: PROFILE as never });
    const b = computeRunIntentHash({ projectId: 'proj_a', profile: reordered as never });
    expect(a).toBe(b);
  });
});

describe('computeBindingId', () => {
  it('is deterministic from projectId + runIntentHash + jobSpecHash', () => {
    const identity = { projectId: 'p', runIntentHash: 'r', jobSpecHash: 'j' };
    expect(computeBindingId(identity)).toBe(computeBindingId({ ...identity }));
  });

  it('changes when any one field changes', () => {
    const base = { projectId: 'p', runIntentHash: 'r', jobSpecHash: 'j' };
    const a = computeBindingId(base);
    expect(computeBindingId({ ...base, projectId: 'p2' })).not.toBe(a);
    expect(computeBindingId({ ...base, runIntentHash: 'r2' })).not.toBe(a);
    expect(computeBindingId({ ...base, jobSpecHash: 'j2' })).not.toBe(a);
  });

  it('is namespaced with the documented "frontend-backend-build-" prefix', () => {
    expect(computeBindingId({ projectId: 'p', runIntentHash: 'r', jobSpecHash: 'j' }).startsWith('frontend-backend-build-')).toBe(true);
  });

  it('is exactly frontend-backend-build- + contentHash of the identity — no clock, no randomness', () => {
    const identity = { projectId: 'p', runIntentHash: 'r', jobSpecHash: 'j' };
    expect(computeBindingId(identity)).toBe(`frontend-backend-build-${contentHash(identity)}`);
  });
});

describe('computeJobSpecHash', () => {
  it('is the same for the same exact spec', () => {
    expect(computeJobSpecHash(SPEC)).toBe(computeJobSpecHash({ ...SPEC }));
  });

  it('changes if any field of the spec changes, including jobId itself', () => {
    const a = computeJobSpecHash(SPEC);
    expect(computeJobSpecHash({ ...SPEC, jobId: 'job_frontend_backend_different' })).not.toBe(a);
    expect(computeJobSpecHash({ ...SPEC, objective: 'Different.' })).not.toBe(a);
  });
});

describe('bindingMarker / specificationCommitMessage', () => {
  it('the marker is an exact, grep-stable line', () => {
    expect(bindingMarker('abc123')).toBe('Statx-Build-Binding-Id: abc123');
  });

  it('the commit message carries the human subject and the exact marker as its own line', () => {
    const message = specificationCommitMessage('abc123');
    expect(message.split('\n')).toContain('Statx-Build-Binding-Id: abc123');
    expect(message.startsWith('Harness: specification')).toBe(true);
  });
});

describe('parseStoredJobSpec', () => {
  it('parses a well-formed stored spec through the real JobSpec contract', () => {
    const parsed = parseStoredJobSpec(BINDING);
    expect(parsed).toEqual(SPEC);
  });

  it('fails closed on a spec that does not parse — missing required field', () => {
    const corrupt: FrontendBackendBuildBindingDocument = {
      ...BINDING,
      jobSpec: { ...SPEC, acceptanceCriteria: [] } as JobSpec, // acceptanceCriteria requires min(1)
    };
    expect(() => parseStoredJobSpec(corrupt)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('fails closed on a spec that is not even an object', () => {
    const corrupt: FrontendBackendBuildBindingDocument = { ...BINDING, jobSpec: 'not a spec' as unknown as JobSpec };
    expect(() => parseStoredJobSpec(corrupt)).toThrow(FrontendBackendBuildBindingCorrupt);
  });
});

describe('verifyBindingConsistency', () => {
  it('accepts a binding whose stored spec genuinely agrees with it', () => {
    expect(() => verifyBindingConsistency(BINDING, SPEC)).not.toThrow();
  });

  it('rejects a jobSpecHash that does not match the stored spec content', () => {
    const corrupt: FrontendBackendBuildBindingDocument = { ...BINDING, jobSpecHash: 'tampered' };
    expect(() => verifyBindingConsistency(corrupt, SPEC)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('rejects binding.jobId disagreeing with spec.jobId', () => {
    const corrupt: FrontendBackendBuildBindingDocument = { ...BINDING, jobId: 'job_frontend_backend_tampered' };
    expect(() => verifyBindingConsistency(corrupt, SPEC)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('rejects binding.projectId disagreeing with spec.projectId', () => {
    const corrupt: FrontendBackendBuildBindingDocument = { ...BINDING, projectId: 'a-different-project' };
    expect(() => verifyBindingConsistency(corrupt, SPEC)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('rejects a spec whose role is not frontend_backend', () => {
    const wrongRoleSpec: JobSpec = { ...SPEC, role: 'something_else' as JobSpec['role'] };
    expect(() => verifyBindingConsistency(BINDING, wrongRoleSpec)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('rejects binding.businessProfile disagreeing with the spec businessProfile input', () => {
    const corrupt: FrontendBackendBuildBindingDocument = {
      ...BINDING,
      businessProfile: { name: 'business-profile', version: 99 },
    };
    expect(() => verifyBindingConsistency(corrupt, SPEC)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('rejects binding.sitePlan disagreeing with the spec sitePlan input', () => {
    const corrupt: FrontendBackendBuildBindingDocument = {
      ...BINDING,
      sitePlan: { name: 'site-plan', version: 99 },
    };
    expect(() => verifyBindingConsistency(corrupt, SPEC)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('a spec missing its businessProfile input entirely is rejected', () => {
    const restInputs = Object.fromEntries(Object.entries(SPEC.inputs).filter(([key]) => key !== 'businessProfile'));
    const missingInput: JobSpec = { ...SPEC, inputs: restInputs };
    expect(() => verifyBindingConsistency(BINDING, missingInput)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('ArtifactRef equality is exact-field, not object identity — an equivalent but distinct object still matches', () => {
    const equivalentSpec: JobSpec = {
      ...SPEC,
      inputs: {
        businessProfile: { name: PROFILE_REF.name, version: PROFILE_REF.version, contentHash: PROFILE_REF.contentHash },
        sitePlan: { name: PLAN_REF.name, version: PLAN_REF.version, contentHash: PLAN_REF.contentHash },
      },
    };
    expect(equivalentSpec.inputs.businessProfile).not.toBe(BINDING.businessProfile);
    expect(() => verifyBindingConsistency(BINDING, equivalentSpec)).not.toThrow();
  });
});
