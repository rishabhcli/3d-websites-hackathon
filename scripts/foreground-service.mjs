import process from 'node:process';

import { stopOwnedService } from './dev-down.mjs';
import { runPreflight } from './dev-preflight.mjs';
import {
  PROJECT_NAME,
  REPOSITORY_ROOT,
  TMP_ROOT,
  createRunId,
  ensureDevDirectories,
  loadServices,
  processStartedAt,
  readRecord,
  removeRecord,
  withLifecycleLock,
  writeServiceRecord,
} from './lib/dev-contract.mjs';
import {
  releaseDirectOwnedChild,
  spawnDirectOwnedChild,
  terminateDirectOwnedChild,
  waitForDirectOwnedChildSpawn,
} from './lib/direct-child-ownership.mjs';
import { assertVerificationLeaseAccess } from './lib/verification-lease.mjs';

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const kind = readArgument('--kind');
const port = Number(readArgument('--port'));
const serviceId = readArgument('--service');
if (!['dev', 'preview'].includes(kind) || !Number.isInteger(port) || !serviceId) {
  throw new Error('foreground-service requires --kind dev|preview --port <integer> --service <id>');
}

await ensureDevDirectories();
await assertVerificationLeaseAccess();

const runId = createRunId();
const script = 'scripts/vite-service.mjs';
const arguments_ = [
  script,
  '--kind',
  kind,
  '--port',
  String(port),
  '--service',
  serviceId,
  '--run-id',
  runId,
];

const { ownedChild, service } = await withLifecycleLock(async () => {
  await assertVerificationLeaseAccess();
  await runPreflight({ emit: false });
  const service = (await loadServices()).find((candidate) => candidate.id === serviceId);
  if (!service || service.port !== port) {
    throw new Error('foreground service does not match ports.env');
  }

  const ownedChild = spawnDirectOwnedChild(process.execPath, arguments_, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, TMPDIR: TMP_ROOT, TMP: TMP_ROOT, TEMP: TMP_ROOT },
    stdio: 'inherit',
  });
  const childPid = await waitForDirectOwnedChildSpawn(ownedChild);
  let startedAt = '';
  try {
    for (let attempt = 0; attempt < 20 && startedAt.length === 0; attempt += 1) {
      startedAt = processStartedAt(childPid);
      if (startedAt.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (startedAt.length === 0) {
      throw new Error('foreground service could not fingerprint its child');
    }

    await writeServiceRecord(service, {
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
    });
    return { ownedChild, service };
  } catch (error) {
    try {
      await terminateDirectOwnedChild(ownedChild);
      releaseDirectOwnedChild(ownedChild);
      await removeRecord(service.id);
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; foreground child cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
});

async function removeOwnRecord() {
  const current = await readRecord(service);
  if (!current) return;
  if (current.runId !== runId || current.pid !== ownedChild.pid) {
    throw new Error('foreground service record changed; refusing to remove another owner record');
  }
  await removeRecord(service.id);
}

let receivedSignal = null;
let stoppingPromise = null;
function stop(signal) {
  if (stoppingPromise) return stoppingPromise;
  receivedSignal = signal;
  const attempt = (async () => {
    try {
      await stopOwnedService(service, { emit: false, expectedRunId: runId });
    } catch (ownershipError) {
      try {
        await terminateDirectOwnedChild(ownedChild);
        await removeOwnRecord();
      } catch (directCleanupError) {
        throw new Error(
          `${ownershipError instanceof Error ? ownershipError.message : String(ownershipError)}; direct-child fallback failed: ${directCleanupError instanceof Error ? directCleanupError.message : String(directCleanupError)}`,
        );
      }
    }
  })();
  stoppingPromise = attempt.catch((error) => {
    stoppingPromise = null;
    throw error;
  });
  return stoppingPromise;
}

let asynchronousStopError = null;
function requestStop(signal) {
  void stop(signal).catch(async (error) => {
    asynchronousStopError = error;
    try {
      // A transient record/inspection failure must not make the first signal
      // permanently disable exact direct-child cleanup.
      await terminateDirectOwnedChild(ownedChild);
    } catch (retryError) {
      asynchronousStopError = new Error(
        `${error instanceof Error ? error.message : String(error)}; retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
      );
    }
  });
}
const handleSigterm = () => {
  requestStop('SIGTERM');
};
const handleSigint = () => {
  requestStop('SIGINT');
};
process.on('SIGTERM', handleSigterm);
process.on('SIGINT', handleSigint);

let terminalError = null;
const exit = await ownedChild.exitPromise;
if (stoppingPromise) {
  try {
    await stoppingPromise;
  } catch (error) {
    terminalError = error;
  }
} else {
  try {
    await removeOwnRecord();
  } catch (error) {
    terminalError = error;
  }
}
if (asynchronousStopError) terminalError = asynchronousStopError;
releaseDirectOwnedChild(ownedChild);
process.removeListener('SIGTERM', handleSigterm);
process.removeListener('SIGINT', handleSigint);

if (terminalError) {
  console.error(terminalError instanceof Error ? terminalError.message : terminalError);
  process.exitCode = 1;
} else if (receivedSignal === 'SIGINT') {
  process.exitCode = 130;
} else if (receivedSignal === 'SIGTERM') {
  process.exitCode = 143;
} else if (typeof exit.exitCode === 'number') {
  process.exitCode = exit.exitCode;
} else {
  process.exitCode = exit.signal ? 1 : 0;
}
