/**
 * Structural checks for the frontend_backend lifecycle coordinator (Phase
 * 5i) that need no Mongo: it composes the existing production boundaries by
 * calling them, never by reimplementing them, never touches `runProject`,
 * and never reaches Sol, Luna, or deployment.
 *
 * The actual lifecycle behaviour — ensure/enqueue, exact-job claim scoping,
 * state-driven resume, one-worker-attempt boundedness, validation/acceptance/
 * promotion composition — is `frontend-backend-job-lifecycle.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'job-lifecycle',
  'frontend-backend.ts',
);

describe('the lifecycle coordinator does not wrap or replace runProject', () => {
  it('does not import runProject or the direct orchestrator module', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');
    expect(src).not.toContain('runProject');
    expect(src).not.toMatch(/orchestrator\.js/);
  });
});

describe('the lifecycle coordinator has no Sol, Luna, or deployment authority', () => {
  it('does not import or reference Sol routing/adjudication/replan, Luna repair, or deployment', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');

    for (const forbidden of [
      'sol-plan',
      'sol-route',
      'sol-adjudicate',
      'sol-replan',
      'sol-approve',
      'routeBuild',
      'adjudicate',
      'replan',
      'createLunaHandler',
      'LunaRepairHandler',
      'requestRepair',
      'deploySite',
      'DeployResult',
      'hosting_release',
      'ReleaseAuthorization',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

describe('the lifecycle coordinator never transitions a job by raw write', () => {
  it('does not call store.jobs.updateOne/insertOne/findOneAndUpdate, registry.accept, or engine.accept directly', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');

    for (const call of [
      'jobs.updateOne(',
      'jobs.insertOne(',
      'jobs.findOneAndUpdate(',
      'registry.accept(',
      'engine.accept(',
      'engine.submitForValidation(',
      'engine.fail(',
      'engine.requestRepair(',
      'engine.block(',
      'engine.release(',
    ]) {
      expect(src).not.toContain(call);
    }
  });
});

describe('claimableRoles is fixed to frontend_backend alone', () => {
  it('constructs its JobRunner with exactly one claimable role, not the tier ceiling', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');
    expect(src).toContain('claimableRoles: [ROLE]');
    // Never spreads the tier's full role set (rolesForTier) into the runner.
    expect(src).not.toMatch(/rolesForTier/);
  });
});

describe('the lifecycle coordinator does not duplicate 5h’s Git publication', () => {
  it('does not import ProjectWorkspace or call Git-write primitives directly', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');
    expect(src).not.toContain('ProjectWorkspace');
    expect(src).not.toContain('scaffoldSite');
    expect(src).not.toContain('.commit(');
    expect(src).not.toContain('.writeSiteFiles(');
  });
});

describe('successful validation evidence never becomes lifecycle output', () => {
  it('the lifecycle result type does not expose a validation/binding field on success', async () => {
    const src = await readFile(MODULE_PATH, 'utf8');
    // The 'promoted' branch's own fields, spelled out, prove nothing named
    // exactly "validation" or "binding" ever appears in the result union —
    // `validationWorkspacesRoot` (a dependency, not a result field) must not
    // false-positive here, so the check is for the exact field name only.
    expect(src).not.toMatch(/readonly validation[?:]/);
    expect(src).not.toMatch(/readonly binding[?:]/);
  });
});
