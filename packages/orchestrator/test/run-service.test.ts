/**
 * Phase 5l — activation config, pure-function properties only. No Mongo, no
 * filesystem, no `runProject` call: `parseFrontendBackendExecutionMode` is
 * exercised directly here; the durable rollback-conflict guard and the
 * real production-caller wiring need a real `StateStore`/`ProjectWorkspace`
 * and are covered by `run-service.integration.test.ts` instead.
 */
import { describe, expect, it } from 'vitest';
import {
  InvalidFrontendBackendExecutionModeConfig,
  WorkspaceRootsCollide,
  assertDistinctWorkspaceRoots,
  parseFrontendBackendExecutionMode,
  resolveFrontendBackendExecutionMode,
} from '../src/run-service.js';

describe('parseFrontendBackendExecutionMode', () => {
  it('accepts "legacy_direct"', () => {
    expect(parseFrontendBackendExecutionMode('legacy_direct')).toBe('legacy_direct');
  });

  it('accepts "job_lifecycle"', () => {
    expect(parseFrontendBackendExecutionMode('job_lifecycle')).toBe('job_lifecycle');
  });

  it('tolerates surrounding whitespace, e.g. a trailing newline from an env file', () => {
    expect(parseFrontendBackendExecutionMode('job_lifecycle\n')).toBe('job_lifecycle');
    expect(parseFrontendBackendExecutionMode('  legacy_direct  ')).toBe('legacy_direct');
  });

  it.each(['legacy', 'job', 'true', 'JOB_LIFECYCLE', 'Job_Lifecycle', 'LEGACY_DIRECT', '', 'job-lifecycle'])(
    'fails closed on %j rather than silently choosing a mode',
    (raw) => {
      expect(() => parseFrontendBackendExecutionMode(raw)).toThrow(InvalidFrontendBackendExecutionModeConfig);
    },
  );

  it('the thrown error names the exact invalid value', () => {
    expect(() => parseFrontendBackendExecutionMode('sorta_job_lifecycle')).toThrow(/sorta_job_lifecycle/);
  });
});

describe('resolveFrontendBackendExecutionMode', () => {
  it('unset config resolves to the production default, job_lifecycle', () => {
    expect(resolveFrontendBackendExecutionMode(undefined)).toBe('job_lifecycle');
  });

  it('explicit "job_lifecycle" resolves to job_lifecycle', () => {
    expect(resolveFrontendBackendExecutionMode('job_lifecycle')).toBe('job_lifecycle');
  });

  it('explicit "legacy_direct" resolves to the rollback value, legacy_direct', () => {
    expect(resolveFrontendBackendExecutionMode('legacy_direct')).toBe('legacy_direct');
  });

  it('an invalid explicit value is never silently mapped to either mode — it throws', () => {
    expect(() => resolveFrontendBackendExecutionMode('nope')).toThrow(InvalidFrontendBackendExecutionModeConfig);
  });
});

describe('assertDistinctWorkspaceRoots', () => {
  it('fails closed when two differently-written configs resolve to the same canonical directory', () => {
    // Relative-vs-absolute, and a redundant "./" segment — two operator
    // mistakes that look different in an env file but name the same
    // directory once resolved.
    expect(() => assertDistinctWorkspaceRoots('/data/workspaces', '/data/./workspaces')).toThrow(WorkspaceRootsCollide);
    expect(() => assertDistinctWorkspaceRoots('/data/workspaces', '/data/workspaces')).toThrow(WorkspaceRootsCollide);
  });

  it('the thrown error names the exact colliding directory', () => {
    expect(() => assertDistinctWorkspaceRoots('/data/workspaces', '/data/workspaces')).toThrow(/\/data\/workspaces/);
  });

  it('two genuinely distinct roots never throw', () => {
    expect(() => assertDistinctWorkspaceRoots('/data/workspaces', '/data/validation-workspaces')).not.toThrow();
  });
});
