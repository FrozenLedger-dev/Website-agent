import { defineConfig } from 'vitest/config';

/**
 * The suites that need no infrastructure.
 *
 * Four files connect to a real Mongo replica set, deliberately: the properties
 * they pin are transaction semantics, and mocking the driver would assert only
 * that the code calls the functions it calls. That makes them integration
 * tests, and the defect was never that they exist — it was that `pnpm test`
 * conflated them with the deterministic suites, so there was no way to run one
 * without provisioning the other.
 *
 * CI runs this config. `pnpm test` still runs everything, which is what a
 * developer with `pnpm db:up` running wants.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      'packages/state/test/budgets.test.ts',
      'packages/job-engine/test/engine.test.ts',
      'packages/workspace/test/workspace.test.ts',
      'packages/orchestrator/test/refusal.integration.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
