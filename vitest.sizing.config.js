import { defineConfig } from 'vitest/config';

// Local measurements on a private local network: keeper sizing and read
// overhead, run by scripts/keeper-sizing.sh and scripts/read-overhead.sh
// through scripts/e2e.sh. Never part of CI or test:e2e. The guard refuses
// any network but the local one before the e2e setup makes any account.
export default defineConfig({
  test: {
    include: ['packages/sdk/sizing/**/*.sizing.ts'],
    globalSetup: [
      'packages/sdk/sizing/local-only.ts',
      'packages/sdk/e2e/setup.ts',
    ],
    fileParallelism: false,
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 300_000,
  },
});
