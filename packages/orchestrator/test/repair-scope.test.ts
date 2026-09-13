/**
 * Explicit Luna repair write scope.
 *
 * What a repair invocation may rewrite is decided by the harness before Luna is
 * asked, as one frozen value — never inferred afterwards from what Luna was
 * shown or what it chose to return. These are the pure policy properties; the
 * phase-level proof (a real invocation, real writes, a real commit) lives in
 * `repair.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  REPAIR_SCOPE_POLICY,
  RepairScopeInvalid,
  partitionRepairOutput,
  repairTargetsFor,
  repairWriteScopeFor,
  type RepairScopePolicyEntry,
} from '../src/defects.js';

const SOURCES = ['app/page.tsx', 'app/about/page.tsx', 'app/layout.tsx', 'app/globals.css'];
const file = (path: string) => ({ path, contents: 'x' });

describe('the scope is decided before Luna is asked', () => {
  it('always makes the primary file explicitly writable', () => {
    const scope = repairWriteScopeFor('app/about/page.tsx', SOURCES, []);
    expect(scope.primaryPath).toBe('app/about/page.tsx');
    expect(scope.writablePaths).toEqual(['app/about/page.tsx']);
  });

  it('keeps today’s behaviour, explicitly: primary, layout and globals are writable', () => {
    const scope = repairWriteScopeFor('app/page.tsx', SOURCES);
    expect(scope.writablePaths).toEqual(['app/page.tsx', 'app/layout.tsx', 'app/globals.css']);
    expect(scope.contextPaths).toEqual(['app/page.tsx', 'app/layout.tsx', 'app/globals.css']);
    expect(REPAIR_SCOPE_POLICY.map((e) => [e.path, e.access])).toEqual([
      ['app/layout.tsx', 'write'],
      ['app/globals.css', 'write'],
    ]);
  });

  it('makes layout writable only when the policy says so', () => {
    const globalsOnly: RepairScopePolicyEntry[] = [{ path: 'app/globals.css', access: 'write' }];
    const scope = repairWriteScopeFor('app/page.tsx', SOURCES, globalsOnly);
    expect(scope.writablePaths).toEqual(['app/page.tsx', 'app/globals.css']);
    expect(scope.writablePaths).not.toContain('app/layout.tsx');
    expect(partitionRepairOutput(scope, [file('app/layout.tsx')]).permitted).toEqual([]);
  });

  it('makes globals writable only when the policy says so', () => {
    const layoutOnly: RepairScopePolicyEntry[] = [{ path: 'app/layout.tsx', access: 'write' }];
    const scope = repairWriteScopeFor('app/page.tsx', SOURCES, layoutOnly);
    expect(scope.writablePaths).toEqual(['app/page.tsx', 'app/layout.tsx']);
    expect(scope.writablePaths).not.toContain('app/globals.css');
    expect(partitionRepairOutput(scope, [file('app/globals.css')]).permitted).toEqual([]);
  });

  it('shows a context-only file without granting a write to it', () => {
    const readLayout: RepairScopePolicyEntry[] = [
      { path: 'app/layout.tsx', access: 'read' },
      { path: 'app/globals.css', access: 'write' },
    ];
    const scope = repairWriteScopeFor('app/page.tsx', SOURCES, readLayout);

    expect(scope.contextPaths).toContain('app/layout.tsx');
    expect(scope.writablePaths).not.toContain('app/layout.tsx');
    expect(partitionRepairOutput(scope, [file('app/layout.tsx')]).permitted).toEqual([]);
  });

  it('represents a primary-only repair when the project has no shell files', () => {
    const scope = repairWriteScopeFor('app/page.tsx', ['app/page.tsx', 'app/about/page.tsx']);
    expect(scope.companionPaths).toEqual([]);
    expect(scope.writablePaths).toEqual(['app/page.tsx']);
  });

  it('never grants a policy file the project does not have', () => {
    const scope = repairWriteScopeFor('app/page.tsx', ['app/page.tsx', 'app/layout.tsx']);
    expect(scope.writablePaths).toEqual(['app/page.tsx', 'app/layout.tsx']);
  });

  it('refuses a target that is not one of the project’s own source files', () => {
    expect(() => repairWriteScopeFor('app/invented/page.tsx', SOURCES)).toThrow(RepairScopeInvalid);
    expect(() => repairWriteScopeFor('../app/page.tsx', SOURCES)).toThrow(RepairScopeInvalid);
  });

  it('follows source order for companions, so what Luna is shown is unchanged', () => {
    const scope = repairWriteScopeFor('app/page.tsx', ['app/globals.css', 'app/page.tsx', 'app/layout.tsx']);
    expect(scope.contextPaths).toEqual(['app/page.tsx', 'app/globals.css', 'app/layout.tsx']);
  });

  it('repairs shell files through page scopes, not on their own, unless they are all a defect names', () => {
    expect(repairTargetsFor(['app/page.tsx', 'app/layout.tsx'])).toEqual(['app/page.tsx']);
    expect(repairTargetsFor(['app/layout.tsx'])).toEqual(['app/layout.tsx']);
  });
});

describe('Luna’s output cannot widen the scope', () => {
  it('refuses a returned file outside the writable set, and anything unexpected', () => {
    const scope = repairWriteScopeFor('app/page.tsx', SOURCES);
    const { permitted, refused } = partitionRepairOutput(scope, [
      file('app/page.tsx'),
      file('app/layout.tsx'),
      file('unexpected/file.ts'),
      file('app/about/page.tsx'),
    ]);

    expect(permitted.map((f) => f.path)).toEqual(['app/page.tsx', 'app/layout.tsx']);
    expect(refused.map((f) => f.path)).toEqual(['unexpected/file.ts', 'app/about/page.tsx']);
  });

  it('refuses traversal, absolute and alternate spellings of an authorised path', () => {
    const scope = repairWriteScopeFor('app/page.tsx', SOURCES);
    const { permitted } = partitionRepairOutput(scope, [
      file('../app/page.tsx'),
      file('/app/page.tsx'),
      file('app/./page.tsx'),
      file('app/../app/layout.tsx'),
      file('/etc/passwd'),
    ]);
    expect(permitted).toEqual([]);
  });

  it('is frozen: nothing downstream can add a path to it', () => {
    const scope = repairWriteScopeFor('app/page.tsx', SOURCES);
    const before = JSON.stringify(scope);

    expect(() => (scope.writablePaths as string[]).push('unexpected/file.ts')).toThrow();
    expect(() => {
      (scope as { writablePaths: readonly string[] }).writablePaths = ['unexpected/file.ts'];
    }).toThrow();
    partitionRepairOutput(scope, [file('unexpected/file.ts'), file('app/page.tsx')]);

    expect(JSON.stringify(scope)).toBe(before);
  });
});
