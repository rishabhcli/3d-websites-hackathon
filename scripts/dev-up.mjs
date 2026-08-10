import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fchmodSync,
  lstatSync,
  openSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  LOG_ROOT,
  PROJECT_NAME,
  REPOSITORY_ROOT,
  TMP_ROOT,
  createRunId,
  inspectService,
  processStartedAt,
  removeRecord,
  waitForHealthy,
  withLifecycleLock,
  writeServiceRecord,
} from './lib/dev-contract.mjs';
import { stopOwnedService } from './dev-down.mjs';
import { runHealth } from './dev-health.mjs';
import { runPreflight } from './dev-preflight.mjs';
import {
  ownedProcessGroupExists,
  spawnOwnedProcess,
  terminateOwnedProcess,
  waitForOwnedProcess,
} from './lib/owned-child-process.mjs';
import { assertVerificationLeaseAccess } from './lib/verification-lease.mjs';
import {
  releaseDirectOwnedChild,
  spawnDirectOwnedChild,
  terminateDirectOwnedChild,
  waitForDirectOwnedChildSpawn,
} from './lib/direct-child-ownership.mjs';

function packageManagerCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function openRepositoryLog(logPath) {
  const descriptor = openSync(
    logPath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = fstatSync(descriptor);
    const pathname = lstatSync(logPath);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !pathname.isFile() ||
      pathname.isSymbolicLink() ||
      pathname.nlink !== 1 ||
      opened.dev !== pathname.dev ||
      opened.ino !== pathname.ino
    ) {
      throw new Error(`${logPath} must be one stable, unlinked regular repository log file`);
    }
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

async function runPackageScript(script, { onTransientProcess } = {}) {
  let stdout = '';
  let stderr = '';
  const owned = spawnOwnedProcess(packageManagerCommand(), ['--silent', 'run', script], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, TMPDIR: TMP_ROOT, TMP: TMP_ROOT, TEMP: TMP_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onTransientProcess?.(owned);
  owned.child.stdout.on('data', (chunk) => {
    const value = chunk.toString('utf8');
    stdout += value;
    process.stdout.write(value);
  });
  owned.child.stderr.on('data', (chunk) => {
    const value = chunk.toString('utf8');
    stderr += value;
    process.stderr.write(value);
  });

  let result;
  try {
    result = await waitForOwnedProcess(owned);
    if (owned.terminationPromise) await owned.terminationPromise;
    if (ownedProcessGroupExists(owned)) {
      await terminateOwnedProcess(owned);
      throw new Error(`${script} left its exact owned process group running`);
    }
  } finally {
    onTransientProcess?.(null);
  }
  if (result.spawnError) {
    throw new Error(`${script} could not start: ${result.spawnError}`);
  }
  if (result.leakedDescendants) {
    throw new Error(`${script} leaked descendants; the exact group was terminated`);
  }
  if (result.exitCode !== 0 || result.signal) {
    throw new Error(
      `${script} failed before services were changed${result.signal ? ` from ${result.signal}` : ` with exit code ${String(result.exitCode)}`}\n${stdout}${stderr}`.trim(),
    );
  }
  if (stderr.trim().length > 0) {
    throw new Error(
      `${script} emitted stderr under the zero-warning contract before services were changed:\n${stderr}`.trim(),
    );
  }
}

async function startService(service) {
  const runId = createRunId();
  const isEvidence = service.kind === 'evidence';
  const script = isEvidence ? 'scripts/evidence-server.mjs' : 'scripts/vite-service.mjs';
  const arguments_ = [script];
  if (!isEvidence) {
    arguments_.push('--kind', service.kind === 'vite-preview' ? 'preview' : 'dev');
  }
  arguments_.push('--port', String(service.port), '--service', service.id, '--run-id', runId);

  const logPath = path.join(LOG_ROOT, `${service.id}.log`);
  const errorLogPath = path.join(LOG_ROOT, `${service.id}.stderr.log`);
  let log = null;
  let errorLog = null;
  let ownedChild;
  try {
    log = openRepositoryLog(logPath);
    errorLog = openRepositoryLog(errorLogPath);
    ownedChild = spawnDirectOwnedChild(process.execPath, arguments_, {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: {
        ...process.env,
        DEV_SERVICE_NAME: service.id,
        DEV_SERVICE_PORT: String(service.port),
        DEV_RUN_ID: runId,
        TMPDIR: TMP_ROOT,
        TMP: TMP_ROOT,
        TEMP: TMP_ROOT,
      },
      shell: false,
      stdio: ['ignore', log, errorLog],
    });
  } finally {
    if (log !== null) closeSync(log);
    if (errorLog !== null) closeSync(errorLog);
  }
  const childPid = await waitForDirectOwnedChildSpawn(ownedChild);

  let recordRegistered = false;
  let startedAt = '';
  try {
    for (let attempt = 0; attempt < 20 && startedAt.length === 0; attempt += 1) {
      startedAt = processStartedAt(childPid);
      if (startedAt.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (startedAt.length === 0) {
      throw new Error(`Could not fingerprint ${service.id} PID ${childPid}`);
    }

    const record = {
      schemaVersion: 1,
      project: PROJECT_NAME,
      repositoryRoot: REPOSITORY_ROOT,
      service: service.id,
      host: '127.0.0.1',
      port: service.port,
      pid: childPid,
      runId,
      commandMarker: script,
      processStartedAt: startedAt,
    };
    await writeServiceRecord(service, record);
    recordRegistered = true;
    await waitForHealthy(service, record);
    releaseDirectOwnedChild(ownedChild);
    console.log(`dev:up started ${service.id} PID ${childPid} on 127.0.0.1:${service.port}`);
    return record;
  } catch (error) {
    try {
      if (recordRegistered) {
        try {
          await stopOwnedService(service, { emit: false, expectedRunId: runId });
        } catch (recordCleanupError) {
          try {
            // The branded direct-child handle remains authoritative even when
            // ps/lsof or the just-written sidecar cannot be inspected.
            await terminateDirectOwnedChild(ownedChild);
          } catch (directCleanupError) {
            throw new Error(
              `${recordCleanupError instanceof Error ? recordCleanupError.message : String(recordCleanupError)}; direct-child fallback failed: ${directCleanupError instanceof Error ? directCleanupError.message : String(directCleanupError)}`,
            );
          }
        }
      } else {
        // A persisted fingerprint is additional ownership evidence, not a
        // prerequisite for cleaning the exact capability created here.
        await terminateDirectOwnedChild(ownedChild);
      }
      releaseDirectOwnedChild(ownedChild);
      await removeRecord(service.id);
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

export async function runUp({
  isInterrupted = () => false,
  onServiceStarted = () => {},
  onTransientProcess,
} = {}) {
  await assertVerificationLeaseAccess();
  return withLifecycleLock(async () => {
    await assertVerificationLeaseAccess();
    const services = await runPreflight({ allowOwnedUnhealthy: true });
    const inspections = await Promise.all(services.map((service) => inspectService(service)));
    const unhealthy = inspections.filter(({ state }) => state === 'unhealthy-owned');
    const missing = inspections.filter(
      ({ state }) => state === 'free' || state === 'unhealthy-owned',
    );

    // Complete every fallible artifact prerequisite before mutating an
    // existing owned service. A compiler or evidence failure must not turn an
    // unhealthy-but-owned process set into avoidable downtime.
    if (missing.some(({ service }) => service.id === 'vite-preview')) {
      await runPackageScript('build', { onTransientProcess });
    }
    if (missing.some(({ service }) => service.id === 'evidence-server'))
      await runPackageScript('evidence:generate', { onTransientProcess });

    if (isInterrupted()) throw new Error(`dev:up interrupted by ${String(isInterrupted())}`);

    for (const { service } of unhealthy) await stopOwnedService(service);

    const started = [];
    try {
      for (const { service } of missing) {
        if (isInterrupted()) throw new Error(`dev:up interrupted by ${String(isInterrupted())}`);
        const record = await startService(service);
        started.push({ service, runId: record.runId });
        onServiceStarted({ serviceId: service.id, runId: record.runId });
      }
      if (isInterrupted()) throw new Error(`dev:up interrupted by ${String(isInterrupted())}`);
      await runHealth({ timeoutMs: 30_000 });
      if (isInterrupted()) throw new Error(`dev:up interrupted by ${String(isInterrupted())}`);
      console.log('dev:up ok — all repository services are healthy');
      return {
        started: started.map(({ service, runId }) => ({ serviceId: service.id, runId })),
      };
    } catch (error) {
      const rollbackFailures = [];
      for (const { service, runId } of [...started].reverse()) {
        try {
          await stopOwnedService(service, { expectedRunId: runId });
        } catch (rollbackError) {
          rollbackFailures.push(
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          );
        }
      }
      const suffix = rollbackFailures.length
        ? `\nRollback failures:\n- ${rollbackFailures.join('\n- ')}`
        : '';
      throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let receivedSignal = null;
  let transientProcess = null;
  let termination = null;
  let terminationFailure = null;
  const beginTermination = () => {
    if (!receivedSignal || !transientProcess || termination) return;
    termination = terminateOwnedProcess(transientProcess, {
      initialSignal: receivedSignal,
    }).catch((error) => {
      terminationFailure = error instanceof Error ? error.message : String(error);
    });
  };
  const handleSignal = (signal) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    beginTermination();
  };
  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  runUp({
    isInterrupted: () => receivedSignal,
    onTransientProcess: (owned) => {
      transientProcess = owned;
      if (owned) beginTermination();
      else termination = null;
    },
  })
    .then(() => {
      if (terminationFailure) throw new Error(`dev:up termination failed: ${terminationFailure}`);
      if (receivedSignal) process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = receivedSignal === 'SIGINT' ? 130 : receivedSignal ? 143 : 1;
    })
    .finally(() => {
      process.removeListener('SIGINT', handleSigint);
      process.removeListener('SIGTERM', handleSigterm);
    });
}
