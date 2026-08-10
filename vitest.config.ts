import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.dev/cache/vitest',
  test: {
    coverage: {
      enabled: false,
      include: [
        'src/camera/stations.ts',
        'src/runtimeConfig.ts',
        'src/scenes/**/*.ts',
        'src/sculpture/**/*.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: '.dev/reports/coverage',
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    environment: 'node',
    fileParallelism: false,
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,mjs}'],
    passWithNoTests: false,
    maxWorkers: 1,
    reporters: ['default'],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    sequence: {
      concurrent: false,
    },
    testTimeout: 10_000,
  },
});
