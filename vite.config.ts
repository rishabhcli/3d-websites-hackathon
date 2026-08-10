import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin, PluginOption } from 'vite';
import { createLogger, defineConfig, loadEnv } from 'vite';
import {
  collectBuildProvenance,
  computeBuildInputDigest,
  createProductionBuildContext,
  serializeProductionBuildContext,
  validateReleaseArtifacts,
} from './scripts/lib/build-integrity.mjs';
import type { ProductionBuildContext } from './scripts/lib/build-integrity.mjs';

const project = '3d-websites-hackathon';
const expectedServicePorts = new Map([
  ['vite-dev', 4100],
  ['vite-preview', 4101],
  ['projection-harness', 4102],
]);
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isManagedServiceEnvironment(service: string, port: number, runId: string): boolean {
  return expectedServicePorts.get(service) === port && runIdPattern.test(runId);
}

export function isForwardedBrowserDiagnosticAllowed({
  command,
  message,
  service,
  port,
  runId,
}: Readonly<{
  command: 'build' | 'serve';
  message: string;
  service: string;
  port: number;
  runId: string;
}>): boolean {
  return (
    command === 'serve' &&
    isManagedServiceEnvironment(service, port, runId) &&
    /^\[console\.(?:error|warn)\]/u.test(message)
  );
}

function digestFiles(files: readonly string[]): string {
  const digest = createHash('sha256');
  for (const file of files) digest.update(readFileSync(path.resolve(file)));
  return digest.digest('hex');
}

function buildContextPlugin(context: ProductionBuildContext): Plugin {
  return {
    name: 'repository-build-context',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-context.json',
        source: serializeProductionBuildContext(context),
      });
    },
  };
}

function readinessPlugin(): Plugin {
  const service = process.env['DEV_SERVICE_NAME'] ?? 'unmanaged';
  const port = Number(process.env['DEV_SERVICE_PORT'] ?? 0);
  const runId = process.env['DEV_RUN_ID'] ?? 'unmanaged';
  const managed = isManagedServiceEnvironment(service, port, runId);
  const artifactDigest = managed
    ? service === 'vite-preview'
      ? digestFiles(['dist/.vite/manifest.json', 'dist/build-integrity.json'])
      : digestFiles(['index.html', 'package.json'])
    : null;
  const identity = {
    schemaVersion: 1,
    project,
    service,
    host: '127.0.0.1',
    port,
    pid: process.pid,
    runId,
    artifactDigest,
  } as const;

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${String(port || 4100)}`)
      .pathname;
    if (pathname !== '/livez' && pathname !== '/readyz') {
      next();
      return;
    }
    const respond = (ready: boolean) => {
      response.statusCode = managed && ready ? 200 : 503;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.end(
        JSON.stringify({
          ...identity,
          status:
            managed && ready
              ? pathname === '/livez'
                ? 'alive'
                : 'ready'
              : managed
                ? 'stale'
                : 'misconfigured',
        }),
      );
    };
    if (managed && service === 'vite-preview' && pathname === '/readyz') {
      void validateReleaseArtifacts(process.cwd()).then(
        () => respond(true),
        () => respond(false),
      );
      return;
    }
    respond(managed);
  };

  return {
    name: 'repository-readiness',
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

function createStrictLogger(command: 'build' | 'serve') {
  const logger = createLogger();
  const reportWarning = logger.warn.bind(logger);
  logger.warn = (message, options) => {
    reportWarning(message, options);
    // Exact browser diagnostics are forwarded through managed development
    // servers and are failed by Playwright plus the verify-all log-range scan.
    // A build can never use that exception, even with forged DEV_SERVICE_* values.
    const service = process.env['DEV_SERVICE_NAME'] ?? '';
    const port = Number(process.env['DEV_SERVICE_PORT'] ?? 0);
    const runId = process.env['DEV_RUN_ID'] ?? '';
    if (!isForwardedBrowserDiagnosticAllowed({ command, message, service, port, runId })) {
      throw new Error(`VITE_WARNING_IS_FATAL: ${message}`);
    }
  };
  logger.warnOnce = (message, options) => logger.warn(message, options);
  return logger;
}

export default defineConfig(async ({ command, mode }) => {
  const plugins: PluginOption[] = [react()];
  let productionContext: ProductionBuildContext | null = null;
  if (command === 'build') {
    const environment = loadEnv(mode, process.cwd(), 'VITE_');
    const nodeEnvironment = process.env['NODE_ENV'];
    const environmentFileNodeEnvironment = process.env['VITE_USER_NODE_ENV'];
    if (
      (nodeEnvironment !== undefined && nodeEnvironment !== 'production') ||
      (environmentFileNodeEnvironment !== undefined &&
        environmentFileNodeEnvironment !== 'production')
    ) {
      throw new Error('BUILD_NODE_ENVIRONMENT_NOT_PRODUCTION');
    }
    const [provenance, sourceInputDigest] = await Promise.all([
      collectBuildProvenance(process.cwd()),
      computeBuildInputDigest(process.cwd()),
    ]);
    productionContext = createProductionBuildContext(mode, environment, {
      toolchain: provenance.toolchain,
      sourceInputDigest,
    });
    plugins.push(buildContextPlugin(productionContext));
  }
  plugins.push(readinessPlugin());

  return {
    base: '/',
    cacheDir: '.dev/cache/vite',
    customLogger: createStrictLogger(command),
    ...(productionContext === null
      ? {}
      : {
          define: {
            'import.meta.env.VITE_BUILD_REF': JSON.stringify(
              productionContext.environment.VITE_BUILD_REF,
            ),
            'import.meta.env.VITE_RUNTIME_SURFACE': JSON.stringify(
              productionContext.environment.VITE_RUNTIME_SURFACE,
            ),
          },
        }),
    plugins,
    server: {
      host: '127.0.0.1',
      port: 4100,
      strictPort: true,
      forwardConsole: {
        unhandledErrors: true,
        logLevels: ['error', 'warn'],
      },
      watch: {
        ignored: ['**/.dev/**'],
      },
    },
    preview: {
      host: '127.0.0.1',
      port: 4101,
      strictPort: true,
    },
    build: {
      assetsDir: 'assets',
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 900,
      manifest: true,
      license: {
        fileName: 'third-party-licenses.json',
      },
      sourcemap: false,
      target: 'es2022',
    },
  };
});
