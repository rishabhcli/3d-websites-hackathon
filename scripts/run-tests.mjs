import path from 'node:path';
import process from 'node:process';
import { REPOSITORY_ROOT, TMP_ROOT } from './lib/dev-contract.mjs';
import { runDown } from './dev-down.mjs';
import { runUp } from './dev-up.mjs';
import {
  ownedProcessGroupExists,
  spawnOwnedProcess,
  terminateOwnedProcess,
  waitForOwnedProcess,
} from './lib/owned-child-process.mjs';
import { acquireVerificationLease, releaseVerificationLease } from './lib/verification-lease.mjs';

const launchedRunIds = new Map();
const verificationLease = await acquireVerificationLease('pnpm run test');
let owned = null;
let termination = null;
let terminationFailure = null;
let signal = null;
let exitCode = 1;
let failure = null;

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function beginTermination() {
  if (!signal || !owned || termination) return;
  termination = terminateOwnedProcess(owned, { initialSignal: signal }).catch((error) => {
    terminationFailure = safeMessage(error);
  });
}

function forwardSignal(receivedSignal) {
  if (signal) return;
  signal = receivedSignal;
  beginTermination();
}

const handleSigint = () => forwardSignal('SIGINT');
const handleSigterm = () => forwardSignal('SIGTERM');
process.on('SIGINT', handleSigint);
process.on('SIGTERM', handleSigterm);

try {
  const upResult = await runUp({
    isInterrupted: () => signal,
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
  if (signal) throw new Error(`TEST_INTERRUPTED_BEFORE_RUN: ${signal}`);
  const vitestCli = path.join(REPOSITORY_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  owned = spawnOwnedProcess(process.execPath, [vitestCli, 'run', ...process.argv.slice(2)], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, TMPDIR: TMP_ROOT, TMP: TMP_ROOT, TEMP: TMP_ROOT },
    stdio: 'inherit',
  });
  beginTermination();
  const result = await waitForOwnedProcess(owned);
  if (termination) await termination;
  if (result.leakedDescendants || (!signal && ownedProcessGroupExists(owned))) {
    await terminateOwnedProcess(owned);
    throw new Error('TEST_PROCESS_LEAK: Vitest left its exact owned process group running');
  }
  if (result.spawnError && !signal) throw new Error(`TEST_SPAWN_FAILED: ${result.spawnError}`);
  if (result.signal && !signal) {
    throw new Error(`TEST_CHILD_SIGNALLED: Vitest terminated from ${result.signal}`);
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
        `${safeMessage(failure)}; exact test-process cleanup failed: ${safeMessage(cleanupError)}`,
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
        `test cleanup targeted only exact owned runs started by this command: ${[...launched].sort().join(', ')}`,
      );
    } catch (error) {
      failure = new Error(
        `${failure ? `${safeMessage(failure)}; ` : ''}test cleanup failed: ${safeMessage(error)}`,
      );
    }
  }
  owned = null;
  if (termination) await termination;
  try {
    await releaseVerificationLease(verificationLease);
  } catch (error) {
    failure = new Error(
      `${failure ? `${safeMessage(failure)}; ` : ''}verification lease release failed: ${safeMessage(error)}`,
    );
  }
  process.removeListener('SIGINT', handleSigint);
  process.removeListener('SIGTERM', handleSigterm);
}

if (terminationFailure) {
  console.error(`TEST_TERMINATION_FAILED: ${terminationFailure}`);
  process.exit(1);
}
if (failure) {
  console.error(safeMessage(failure));
  process.exit(1);
}
if (signal === 'SIGINT') process.exit(130);
if (signal) process.exit(143);
process.exit(exitCode);
