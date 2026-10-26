import { defineConfig } from 'vitest/config';

// End-to-end tests on a private local network, run by scripts/e2e.sh. The
// files share one network and run one after another.
export default defineConfig({
  test: {
    include: ['packages/sdk/e2e/**/*.e2e.test.ts'],
    globalSetup: ['packages/sdk/e2e/setup.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
