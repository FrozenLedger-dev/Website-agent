/**
 * Structural checks for canonical candidate promotion (Phase 5h) that need
 * no Mongo: the module cannot reach a model, deployment/release APIs, or
 * job/acceptance-lifecycle mutation, and never reruns deterministic
 * validation.
 *
 * The replay-safe promotion sequence itself — prepared/committed receipts,
 * Git marker recovery, base-commit conflicts, crash/retry convergence — is
 * `frontend-backend-job-promotion.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'job-promotion', 'frontend-backend.ts');

describe('the promotion module cannot reach a model, deployment, validation, or job/acceptance mutation', () => {
  it('does not import ModelClient, deployment APIs, or validation/gate primitives, and never calls acceptance/job-transition/repair methods', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');

    for (const forbidden of [
      'ModelClient',
      'reviewSite',
      'deploySite',
      'DeployResult',
      'hosting_release',
      'runDeterministicGates',
      'evaluateSite',
      'routeBuild',
      'buildAnchor',
      'buildPage',
      'repairDefect',
    ]) {
      expect(src).not.toMatch(new RegExp(forbidden));
    }

    for (const call of [
      '.accept(',
      '.submitForValidation(',
      '.requestRepair(',
      '.block(',
      '.release(',
      '.claim(',
      '.heartbeat(',
    ]) {
      expect(src).not.toContain(call);
    }
  });
});

describe('promotion never asks JobEngine to change job state', () => {
  it('does not import JobEngine', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');
    expect(src).not.toMatch(/JobEngine/);
  });
});

describe('the direct git-reset compensation path is never used', () => {
  it('does not call a hard reset/checkout as post-failure compensation', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');
    expect(src).not.toContain("'reset'");
    expect(src).not.toContain('"reset"');
    expect(src).not.toContain('--hard');
  });
});
