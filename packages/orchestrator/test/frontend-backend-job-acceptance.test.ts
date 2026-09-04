/**
 * Structural/control-plane checks for atomic candidate acceptance
 * (Phase 5g-2) that need no Mongo: refusing unsuccessful validation evidence
 * before anything is read, and the boundary test proving this module cannot
 * reach a model, the canonical workspace, or deployment/repair machinery.
 *
 * The transactional/atomic behaviour — re-proving the binding, accepting
 * the exact candidate, moving the job, rollback on partial failure — is
 * `frontend-backend-job-acceptance.integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRegistry } from '@statxai/workspace';
import type { JobEngine } from '@statxai/job-engine';
import type { StateStore } from '@statxai/state';
import type { FrontendBackendCandidateValidation } from '../src/job-validation/frontend-backend.js';
import {
  AcceptanceEvidenceNotAuthentic,
  acceptValidatedFrontendBackendCandidate,
} from '../src/job-acceptance/frontend-backend.js';

const binding = {
  projectId: 'proj_1',
  jobId: 'job_1',
  attempt: 1,
  candidate: { name: 'job-output/job_1/1/build-candidate', version: 1 },
  businessProfile: { name: 'business-profile', version: 1 },
  sitePlan: { name: 'site-plan', version: 1 },
};

/** Never went through `validateFrontendBackendCandidate` — not in its authenticity WeakSet, whatever `ok` says. */
function handBuiltValidation(ok: boolean): FrontendBackendCandidateValidation {
  return {
    binding,
    ok,
    compiled: { ok, durationMs: 1, output: ok ? '' : 'build failed', outDir: '/x' },
    gateRun: { passed: ok, findings: [], gatesRun: ['build'] },
  };
}

describe('evidence must be authentic — the exact object the real validator produced', () => {
  it('rejects a hand-built object without touching the store, registry, or engine, regardless of what it claims', async () => {
    const jobsFindOne = vi.fn();
    const registryResolve = vi.fn();
    const registryAccept = vi.fn();
    const engineAccept = vi.fn();
    const withTransaction = vi.fn();

    const deps = {
      store: { jobs: { findOne: jobsFindOne }, withTransaction } as unknown as StateStore,
      registry: { resolve: registryResolve, accept: registryAccept } as unknown as ArtifactRegistry,
      engine: { accept: engineAccept } as unknown as JobEngine,
    };

    // Checked before `ok` is even read — a hand-built `ok: false` object is
    // rejected the same way a hand-built `ok: true` one is (the "forged
    // pass" case gets its own dedicated, real-job proof in the integration
    // suite, where "candidate unaccepted / job validating / no audit" can
    // actually be checked against a database).
    for (const ok of [true, false]) {
      await expect(acceptValidatedFrontendBackendCandidate(handBuiltValidation(ok), deps)).rejects.toBeInstanceOf(
        AcceptanceEvidenceNotAuthentic,
      );
    }

    expect(jobsFindOne).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(registryResolve).not.toHaveBeenCalled();
    expect(registryAccept).not.toHaveBeenCalled();
    expect(engineAccept).not.toHaveBeenCalled();
  });
});

describe('the acceptance module cannot reach a model, the canonical workspace, or deployment/repair machinery', () => {
  it('does not import ProjectWorkspace, ModelClient, deployment APIs, or repair/skill machinery, and never calls requestRepair/release/block/commit', async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'job-acceptance', 'frontend-backend.ts'),
      'utf8',
    );

    for (const forbidden of [
      'ProjectWorkspace',
      'ModelClient',
      'reviewSite',
      'deploySite',
      'scaffoldSite',
      'buildAnchor',
      'buildPage',
      'routeBuild',
      'repairDefect',
    ]) {
      expect(src).not.toMatch(new RegExp(forbidden));
    }
    for (const call of ['.requestRepair(', '.release(', '.block(', '.commit(', '.writeSiteFiles(']) {
      expect(src).not.toContain(call);
    }
  });
});

describe('JobEngine.accept is always called guarded, never state-only', () => {
  it('the source supplies expectedAttempt and expectedOutputs on every deps.engine.accept call', async () => {
    // Behaviourally, the orchestrator's own binding re-check makes an
    // ungated `engine.accept` call unobservable in every constructible test
    // — nothing can invalidate that check between it and the call within
    // one transaction. This is redundancy working as intended (JobEngine's
    // own guard, proven independently in engine.test.ts, would still catch
    // a real staleness), not licence to drop the belt for the suspenders:
    // this structural check is what actually catches the call site
    // regressing to the state-only form, since no behavioural test can.
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'job-acceptance', 'frontend-backend.ts'),
      'utf8',
    );
    const call = /deps\.engine\.accept\(([\s\S]*?)\);/.exec(src);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('expectedAttempt');
    expect(call![1]).toContain('expectedOutputs');
  });
});
