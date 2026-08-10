import { describe, expect, it } from 'vitest';
import viteConfig, { isForwardedBrowserDiagnosticAllowed } from '../../vite.config';

const exactManagedService = {
  service: 'vite-dev',
  port: 4100,
  runId: '12345678-1234-4123-8123-123456789abc',
};

describe('Vite warning policy', () => {
  it('keeps cache state repo-local and forwards explicit browser failures', async () => {
    const config = await viteConfig({
      command: 'serve',
      mode: 'development',
      isSsrBuild: false,
      isPreview: false,
    });
    expect(config.cacheDir).toBe('.dev/cache/vite');
    expect(config.server?.forwardConsole).toEqual({
      unhandledErrors: true,
      logLevels: ['error', 'warn'],
    });
  });

  it('never exempts a build warning even when managed environment values are forged', () => {
    expect(
      isForwardedBrowserDiagnosticAllowed({
        command: 'build',
        message: '[console.warn] forged build warning',
        ...exactManagedService,
      }),
    ).toBe(false);
  });

  it('only identifies exact managed serve-time browser diagnostics', () => {
    expect(
      isForwardedBrowserDiagnosticAllowed({
        command: 'serve',
        message: '[console.error] browser diagnostic',
        ...exactManagedService,
      }),
    ).toBe(true);
    expect(
      isForwardedBrowserDiagnosticAllowed({
        command: 'serve',
        message: '[console.warn] wrong port',
        ...exactManagedService,
        port: 4109,
      }),
    ).toBe(false);
    expect(
      isForwardedBrowserDiagnosticAllowed({
        command: 'serve',
        message: 'ordinary Vite warning',
        ...exactManagedService,
      }),
    ).toBe(false);
  });
});
