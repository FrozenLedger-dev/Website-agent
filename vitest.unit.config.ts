import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The suites that need no infrastructure.
 *
 * The suites excluded below connect to a real Mongo replica set, deliberately:
 * the properties they pin are transaction semantics and end-to-end
 * orchestration, and mocking the driver would assert only that the code calls
 * the functions it calls. Anything named `*.integration.test.ts` is one of
 * them, plus three older suites named before that convention existed.
 *
 * They run in CI too, as a separate job driven by `vitest.integration.config.ts`.
 * The split exists so the two signals stay readable and so a developer without
 * a replica set can still run the deterministic half.
 */
export default defineConfig({
  // `apps/console` resolves its own imports through Next's `@/*` path alias.
  // A route module under test imports `@/lib/auth`, so the runner has to
  // resolve it the same way the framework does. The trailing slash matters:
  // a bare `@` prefix would also capture every `@statxai/*` package.
  resolve: {
    alias: { '@/': `${fileURLToPath(new URL('./apps/console', import.meta.url))}/` },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // The exact complement of `vitest.integration.config.ts`. Keep the two in
    // step: a suite in neither list never runs, and one in both runs twice.
    exclude: [
      '**/node_modules/**',
      'packages/*/test/**/*.integration.test.ts',
      'apps/*/test/**/*.integration.test.ts',
      'packages/state/test/budgets.test.ts',
      'packages/job-engine/test/engine.test.ts',
      'packages/workspace/test/workspace.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
