import { defineConfig } from 'vitest/config';

/**
 * The suites that need no infrastructure.
 *
 * Four files connect to a real Mongo replica set, deliberately: the properties
 * they pin are transaction semantics and end-to-end orchestration, and mocking
 * the driver would assert only that the code calls the functions it calls.
 *
 * They run in CI too, as a separate job driven by `vitest.integration.config.ts`.
 * The split exists so the two signals stay readable and so a developer without
 * a replica set can still run the deterministic half.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The exact complement of `vitest.integration.config.ts`. Keep the two in
    // step: a suite in neither list never runs, and one in both runs twice.
    exclude: [
      '**/node_modules/**',
      'packages/*/test/**/*.integration.test.ts',
      'packages/state/test/budgets.test.ts',
      'packages/job-engine/test/engine.test.ts',
      'packages/workspace/test/workspace.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
