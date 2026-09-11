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
  /**
   * Phase 5n narrows this test's original premise rather than dropping it:
   * promotion now legitimately imports `JobEngine` (as a type only) and
   * calls exactly one method on it — `acquirePromotionFence`, which never
   * touches `job.state` at all, only the separate `promotionFence` field.
   * Every actual state-mutating method (already covered by the sibling
   * describe block above: `.accept(`, `.submitForValidation(`,
   * `.requestRepair(`, `.block(`, `.release(`, `.claim(`, `.heartbeat(`)
   * must still never appear here, and neither must the generic
   * `.supersede(`/`.supersedeAcceptedBeforePromotion(` — promotion reads
   * and fences a job; it never supersedes one itself.
   */
  it('imports JobEngine only as a type, and calls only acquirePromotionFence on it — never a state-mutating method', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');
    expect(src).toContain("type JobEngine } from '@statxai/job-engine'");
    expect(src).toContain('.acquirePromotionFence(');
    for (const call of ['.supersede(', '.supersedeAcceptedBeforePromotion(']) {
      expect(src).not.toContain(call);
    }
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
