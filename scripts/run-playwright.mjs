import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_ROOT,
  ensureDevDirectories,
  inspectService,
  loadServices,
} from './lib/dev-contract.mjs';
import { runDown } from './dev-down.mjs';
import { runUp } from './dev-up.mjs';
import {
  ownedProcessGroupExists,
  spawnOwnedProcess,
  terminateOwnedProcess,
  waitForOwnedProcess,
} from './lib/owned-child-process.mjs';
import { acquireVerificationLease, releaseVerificationLease } from './lib/verification-lease.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
await ensureDevDirectories();
const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const arguments_ = process.argv.slice(2);
const childEnvironment = { ...process.env };
delete childEnvironment['FORCE_COLOR'];
delete childEnvironment['NO_COLOR'];
const launchedRunIds = new Map();
let owned = null;
let termination = null;
let terminationFailure = null;
let receivedSignal = null;
let exitCode = 1;
let failure = null;
const verificationLease =
  arguments_[0] === 'test' ? await acquireVerificationLease('pnpm run test:e2e') : null;

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function beginTermination() {
  if (!receivedSignal || !owned || termination) return;
  termination = terminateOwnedProcess(owned, { initialSignal: receivedSignal }).catch((error) => {
    terminationFailure = safeMessage(error);
  });
}

function handleSignal(signal) {
  if (receivedSignal) return;
  receivedSignal = signal;
  beginTermination();
}

const handleSigint = () => handleSignal('SIGINT');
const handleSigterm = () => handleSignal('SIGTERM');
process.on('SIGINT', handleSigint);
process.on('SIGTERM', handleSigterm);

try {
  if (arguments_[0] === 'test') {
    const upResult = await runUp({
      isInterrupted: () => receivedSignal,
      onServiceStarted: ({ serviceId, runId }) => launchedRunIds.set(serviceId, runId),
      onTransientProcess: (transient) => {
        owned = transient;
        if (transient) beginTermination();
        else termination = null;
      },
    });
    for (const started of upResult.started) {
      launchedRunIds.set(started.serviceId, started.runId);
    }
    if (receivedSignal) throw new Error(`PLAYWRIGHT_INTERRUPTED_BEFORE_RUN: ${receivedSignal}`);

    const requiredServices = new Set(['projection-harness', 'vite-preview']);
    for (const service of await loadServices()) {
      if (!requiredServices.has(service.id)) continue;
      const inspection = await inspectService(service);
      if (inspection.state !== 'healthy-owned') {
        throw new Error(`PLAYWRIGHT_SERVICE_NOT_OWNED: ${service.id} (${inspection.state})`);
      }
      requiredServices.delete(service.id);
    }
    if (requiredServices.size > 0) {
      throw new Error(`PLAYWRIGHT_SERVICE_MISSING: ${[...requiredServices].sort().join(', ')}`);
    }
    childEnvironment['PLAYWRIGHT_REUSE_OWNED'] = '1';
  }

  owned = spawnOwnedProcess(process.execPath, [cli, ...arguments_], {
    cwd: root,
    env: {
      ...childEnvironment,
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.dev', 'cache', 'ms-playwright'),
      TMPDIR: PROFILE_ROOT,
      TMP: PROFILE_ROOT,
      TEMP: PROFILE_ROOT,
    },
    stdio: 'inherit',
  });
  beginTermination();
  const result = await waitForOwnedProcess(owned);
  if (termination) await termination;
  if (result.leakedDescendants || (!receivedSignal && ownedProcessGroupExists(owned))) {
    await terminateOwnedProcess(owned);
    throw new Error('PLAYWRIGHT_PROCESS_LEAK: CLI left its exact owned process group running');
  }
  if (result.spawnError && !receivedSignal) {
    throw new Error(`PLAYWRIGHT_SPAWN_FAILED: ${result.spawnError}`);
  }
  if (result.signal && !receivedSignal) {
    throw new Error(`PLAYWRIGHT_CHILD_SIGNALLED: CLI terminated from ${result.signal}`);
  }
  exitCode = typeof result.exitCode === 'number' ? result.exitCode : 1;
  owned = null;
  termination = null;
} catch (error) {
  failure = error;
  if (termination) await termination;
  if (owned) {
    try {
      await terminateOwnedProcess(owned);
    } catch (cleanupError) {
      failure = new Error(
        `${safeMessage(failure)}; exact Playwright-process cleanup failed: ${safeMessage(cleanupError)}`,
      );
    }
  }
  owned = null;
  termination = null;
} finally {
  const launched = new Set(launchedRunIds.keys());
  if (launched.size > 0) {
    try {
      await runDown({ emit: false, only: launched, expectedRunIds: launchedRunIds });
      console.log(
        `Playwright cleanup targeted only exact owned runs started by this command: ${[...launched].sort().join(', ')}`,
      );
    } catch (error) {
      failure = new Error(
        `${failure ? `${safeMessage(failure)}; ` : ''}Playwright cleanup failed: ${safeMessage(error)}`,
      );
    }
  }
  owned = null;
  if (termination) await termination;
  if (verificationLease) {
    try {
      await releaseVerificationLease(verificationLease);
    } catch (error) {
      failure = new Error(
        `${failure ? `${safeMessage(failure)}; ` : ''}verification lease release failed: ${safeMessage(error)}`,
      );
    }
  }
  process.removeListener('SIGINT', handleSigint);
  process.removeListener('SIGTERM', handleSigterm);
}

if (terminationFailure) {
  console.error(`PLAYWRIGHT_TERMINATION_FAILED: ${terminationFailure}`);
  process.exit(1);
}
if (failure) {
  console.error(safeMessage(failure));
  process.exit(1);
}
if (receivedSignal === 'SIGINT') process.exit(130);
if (receivedSignal) process.exit(143);
process.exit(exitCode);
