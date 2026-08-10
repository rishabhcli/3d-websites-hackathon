import { defineConfig, devices } from '@playwright/test';

const projectionBaseURL = 'http://127.0.0.1:4102';
const previewBaseURL = 'http://127.0.0.1:4101';
const chromiumLaunchArguments =
  process.platform === 'darwin' ? ['--use-gl=angle', '--use-angle=metal'] : [];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  outputDir: '.dev/reports/playwright-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '.dev/reports/playwright-html' }]],
  globalSetup: './scripts/playwright-global-setup.mjs',
  projects: [
    {
      name: 'projection-harness',
      testIgnore: '**/canvas-stage.spec.ts',
      use: { baseURL: projectionBaseURL },
    },
    {
      name: 'production-preview',
      use: { baseURL: previewBaseURL },
    },
  ],
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: chromiumLaunchArguments,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Video is not required for Tier-0 evidence; traces and failure screenshots
    // retain the deterministic browser diagnostics used by this gate.
    video: 'off',
  },
  webServer: {
    command: 'pnpm run dev:test-server:foreground',
    url: `${projectionBaseURL}/readyz`,
    reuseExistingServer: process.env['PLAYWRIGHT_REUSE_OWNED'] === '1',
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: 5_000,
    },
  },
});
