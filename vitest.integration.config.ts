import { defineConfig } from 'vitest/config';

/**
 * The suites that need the Mongo replica set.
 *
 * The complement of `vitest.unit.config.ts`, so the two together run the whole
 * inventory exactly once. They are integration tests by intent: the properties
 * they pin are transaction semantics and end-to-end orchestration, and a mocked
 * driver would assert only that the code calls the functions it calls.
 *
 * `pnpm db:up` provides the replica set locally; CI starts the same
 * docker-compose service.
 */
export default defineConfig({
  test: {
    include: [
      // Anything named for what it is. A new Mongo-backed suite lands in this
      // job by its filename rather than by being remembered here — the two
      // lists silently disagreeing would put a suite needing a replica set into
      // the job that provisions nothing.
      'packages/*/test/**/*.integration.test.ts',
      // Older suites, named before the convention existed.
      'packages/state/test/budgets.test.ts',
      'packages/job-engine/test/engine.test.ts',
      'packages/workspace/test/workspace.test.ts',
    ],
    // One Mongo deployment is shared, so parallel files would race on
    // collection state.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
