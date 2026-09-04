/**
 * Structural/control-plane fail-closed checks for isolated candidate
 * validation (Phase 5g-1) — everything that can be proven without Mongo, a
 * filesystem, or a real build: role, state, `executionOutputs` presence and
 * count, namespace binding, and pinned-input presence. Each of these must
 * fail before the registry is ever asked to resolve anything, which every
 * test here proves directly by asserting `resolve` was never called.
 *
 * The end-to-end deterministic-validation behaviour (real registry, real
 * isolated workspace, exact-version resolution, pass/fail reports,
 * cleanup) is `frontend-backend-job-validation.integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobDocument } from '@statxai/state';
import { jobOutputNamespace } from '@statxai/job-engine';
import type { ArtifactRegistry } from '@statxai/workspace';
import {
  CandidateValidationInputInvalid,
  CandidateValidationMissingOutputs,
  CandidateValidationNamespaceMismatch,
  CandidateValidationOutputCountMismatch,
  CandidateValidationRoleMismatch,
  CandidateValidationStateMismatch,
  validateFrontendBackendCandidate,
} from '../src/job-validation/frontend-backend.js';
import { FRONTEND_BACKEND_INPUT } from '../src/job-handlers/frontend-backend.js';

const JOB_ID = 'job_fb_validate_1';
const ATTEMPT = 1;
const NAMESPACE = jobOutputNamespace(JOB_ID, ATTEMPT);

function job(overrides: Partial<JobDocument> = {}): JobDocument {
  return {
    _id: JOB_ID,
    projectId: 'proj_1',
    role: 'frontend_backend',
    spec: {
      projectId: 'proj_1',
      jobId: JOB_ID,
      role: 'frontend_backend',
      objective: 'Build the site.',
      inputs: {
        [FRONTEND_BACKEND_INPUT.businessProfile]: { name: 'business-profile', version: 1 },
        [FRONTEND_BACKEND_INPUT.sitePlan]: { name: 'site-plan', version: 1 },
      },
      acceptanceCriteria: ['site files written'],
      allowedTools: [],
      output: ['app/page.tsx'],
    },
    state: 'validating',
    origin: { kind: 'plan' },
    dependsOn: [],
    attempt: ATTEMPT,
    maxAttempts: 3,
    lease: null,
    failure: null,
    executionOutputs: [{ name: `${NAMESPACE}build-candidate`, version: 1 }],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as JobDocument;
}

function deps(resolve: ReturnType<typeof vi.fn> = vi.fn()) {
  return {
    registry: { resolve } as unknown as ArtifactRegistry,
    validationWorkspacesRoot: '/does/not/matter/for/these/checks',
  };
}

describe('fail-closed structural checks, before any resolution', () => {
  it('rejects a job whose role is not frontend_backend', async () => {
    const resolve = vi.fn();
    await expect(validateFrontendBackendCandidate(job({ role: 'qa_review' }), deps(resolve))).rejects.toBeInstanceOf(
      CandidateValidationRoleMismatch,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['running', 'accepted', 'ready', 'failed'] as const)('rejects a job in state "%s"', async (state) => {
    const resolve = vi.fn();
    await expect(validateFrontendBackendCandidate(job({ state }), deps(resolve))).rejects.toBeInstanceOf(
      CandidateValidationStateMismatch,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a job with executionOutputs null (legacy or never-attached)', async () => {
    const resolve = vi.fn();
    await expect(validateFrontendBackendCandidate(job({ executionOutputs: null }), deps(resolve))).rejects.toBeInstanceOf(
      CandidateValidationMissingOutputs,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a job with an empty executionOutputs array', async () => {
    const resolve = vi.fn();
    await expect(validateFrontendBackendCandidate(job({ executionOutputs: [] }), deps(resolve))).rejects.toBeInstanceOf(
      CandidateValidationMissingOutputs,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a job with more than one executionOutputs ref, without picking one', async () => {
    const resolve = vi.fn();
    const twoRefs = job({
      executionOutputs: [
        { name: `${NAMESPACE}build-candidate`, version: 1 },
        { name: `${NAMESPACE}extra`, version: 1 },
      ],
    });
    await expect(validateFrontendBackendCandidate(twoRefs, deps(resolve))).rejects.toBeInstanceOf(
      CandidateValidationOutputCountMismatch,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a ref not namespaced under this exact job and attempt', async () => {
    const resolve = vi.fn();
    const wrongNamespace = job({
      executionOutputs: [{ name: `${jobOutputNamespace('some_other_job', ATTEMPT)}build-candidate`, version: 1 }],
    });
    await expect(validateFrontendBackendCandidate(wrongNamespace, deps(resolve))).rejects.toBeInstanceOf(
      CandidateValidationNamespaceMismatch,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a ref namespaced under a different attempt of the same job', async () => {
    const resolve = vi.fn();
    const wrongAttempt = job({
      executionOutputs: [{ name: `${jobOutputNamespace(JOB_ID, ATTEMPT + 1)}build-candidate`, version: 1 }],
    });
    await expect(validateFrontendBackendCandidate(wrongAttempt, deps(resolve))).rejects.toBeInstanceOf(
      CandidateValidationNamespaceMismatch,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a job missing a required pinned input, once namespace checks out but before the candidate resolves', async () => {
    const resolve = vi.fn();
    const missingInput = job();
    delete (missingInput.spec.inputs as Record<string, unknown>)[FRONTEND_BACKEND_INPUT.sitePlan];
    await expect(validateFrontendBackendCandidate(missingInput, deps(resolve))).rejects.toBeInstanceOf(
      CandidateValidationInputInvalid,
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('the validator never touches job-lifecycle or acceptance authority', () => {
  it('does not import JobEngine, ModelClient, or deployment APIs, and never calls acceptance/repair methods', async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'job-validation', 'frontend-backend.ts'),
      'utf8',
    );

    expect(src).not.toMatch(/JobEngine/);
    expect(src).not.toMatch(/ModelClient/);
    expect(src).not.toMatch(/reviewSite|deploySite/);
    for (const call of [
      '.accept(',
      '.submitForValidation(',
      '.requestRepair(',
      '.block(',
      '.release(',
      '.heartbeat(',
      '.reclaimExpiredLeases(',
      '.fail(',
    ]) {
      expect(src).not.toContain(call);
    }
  });
});
