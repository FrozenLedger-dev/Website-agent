/**
 * The handler owns no part of the job lifecycle.
 *
 * `JobRunner` (5c) already never hands a `JobHandler` its `JobEngine`, so this
 * cannot happen by accident through the type system — but nothing stops a
 * future edit from routing a `JobEngine` reference in through a handler's own
 * `deps` object instead, which would compile fine and only show up as a
 * behaviour change at runtime. Reading the handler's source back, the same
 * technique `policy-boundary.test.ts` uses for the policy/orchestrator split,
 * catches that before it ships.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HANDLER_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'job-handlers',
  'frontend-backend.ts',
);

describe('the frontend_backend handler never transitions a job itself', () => {
  it('does not import JobEngine, and does not call any job-lifecycle method', async () => {
    const src = await readFile(HANDLER_SRC, 'utf8');

    expect(src).not.toMatch(/JobEngine/);
    for (const method of ['submitForValidation', 'accept', 'requestRepair', 'block', 'release']) {
      // `.fail(` is checked separately below: FrontendBackendInputInvalid and
      // FrontendBackendRoleMismatch messages don't use the word, but a plain
      // substring check on `.fail(` alone is enough and stays specific to a
      // method call, not prose.
      expect(src).not.toMatch(new RegExp(`\\.${method}\\(`));
    }
    expect(src).not.toMatch(/\.fail\(/);
  });
});
