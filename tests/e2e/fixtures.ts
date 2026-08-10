import { expect, test as base, type Page, type Request, type TestInfo } from '@playwright/test';

const QUIESCENCE_TIMEOUT_MS = 5_000;
const QUIET_WINDOW_MS = 500;

interface NetworkActivity {
  readonly activeRequests: Set<Request>;
  version: number;
}

function networkSnapshot(network: NetworkActivity): {
  readonly activeRequestCount: number;
  readonly version: number;
} {
  return { activeRequestCount: network.activeRequests.size, version: network.version };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForPageQuiescence(page: Page, network: NetworkActivity): Promise<void> {
  if (page.isClosed()) return;

  await page.waitForLoadState('load', { timeout: QUIESCENCE_TIMEOUT_MS });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const beforeQuietWindow = networkSnapshot(network);
    if (beforeQuietWindow.activeRequestCount === 0) {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await page.waitForTimeout(QUIET_WINDOW_MS);

      const afterQuietWindow = networkSnapshot(network);
      if (
        afterQuietWindow.activeRequestCount === 0 &&
        afterQuietWindow.version === beforeQuietWindow.version
      ) {
        return;
      }
    } else {
      await page.waitForTimeout(50);
    }
  }

  const finalSnapshot = networkSnapshot(network);
  throw new Error(
    `Page did not reach quiescence within ${QUIESCENCE_TIMEOUT_MS.toString()}ms; ` +
      `${finalSnapshot.activeRequestCount.toString()} request(s) remain active`,
  );
}

async function attachDiagnostics(
  testInfo: TestInfo,
  diagnostics: readonly string[],
): Promise<void> {
  await testInfo.attach('browser-diagnostics.txt', {
    body: Buffer.from(`${diagnostics.join('\n')}\n`, 'utf8'),
    contentType: 'text/plain',
  });
}

interface AutomaticFixtures {
  readonly browserDiagnosticsGate: undefined;
}

export const test = base.extend<AutomaticFixtures>({
  browserDiagnosticsGate: [
    async ({ page }, use, testInfo) => {
      const diagnostics: string[] = [];
      const network: NetworkActivity = { activeRequests: new Set(), version: 0 };

      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          diagnostics.push(`console.${message.type()}: ${message.text()}`);
        }
      });
      page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
      page.on('request', (request) => {
        network.activeRequests.add(request);
        network.version += 1;
      });
      page.on('requestfinished', (request) => {
        network.activeRequests.delete(request);
        network.version += 1;
      });
      page.on('requestfailed', (request) => {
        network.activeRequests.delete(request);
        network.version += 1;
        const reason = request.failure()?.errorText ?? 'unknown failure';
        diagnostics.push(`requestfailed: ${request.method()} ${request.url()} (${reason})`);
      });

      await use(undefined);

      if (!page.isClosed()) {
        try {
          await waitForPageQuiescence(page, network);
        } catch (error) {
          diagnostics.push(`quiescence: ${describeError(error)}`);
        }

        try {
          // Closing the page while the listeners are still attached flushes errors that
          // otherwise arrive after the final assertion in the test body.
          await page.close({ runBeforeUnload: false });
        } catch (error) {
          diagnostics.push(`page-close: ${describeError(error)}`);
        }
      }

      if (diagnostics.length > 0) {
        await attachDiagnostics(testInfo, diagnostics);
      }
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
