import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `apps/console` resolves its own imports through Next's `@/*` path alias;
  // the runner has to resolve them the same way. The trailing slash keeps the
  // alias from also capturing every `@statxai/*` package.
  resolve: {
    alias: { '@/': `${fileURLToPath(new URL('./apps/console', import.meta.url))}/` },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Integration tests share one Mongo deployment; running files in parallel
    // would let them race on collection state.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
