import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  createWriteStream,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  PROJECT_NAME,
  LOG_ROOT,
  REPORT_ROOT,
  REPOSITORY_ROOT,
  TMP_ROOT,
  ensureDevDirectories,
  loadServices,
  writeJsonAtomic,
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

const reportPath = path.join(REPORT_ROOT, 'verify-all.json');
const logPath = path.join(REPORT_ROOT, 'verify-all.log');
const report = {
  schemaVersion: 1,
  project: PROJECT_NAME,
  command: 'pnpm run verify-all',
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: 'running',
  steps: [],
  cleanup: null,
};

let activeOwnedProcess = null;
let activeTermination = null;
let terminationFailure = null;
let terminationSignal = null;
let deferredFinalSignal = null;
let committingLeaseRelease = false;
let log;
let logFailure = null;

function packageManagerCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeLog(value) {
  process.stdout.write(value);
  if (log && !log.destroyed && !log.writableEnded) log.write(value);
}

function createSafeReportLog() {
  const temporaryPath = `${logPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1) {
      throw new Error('verify-all temporary log is not one regular repository file');
    }
    fchmodSync(descriptor, 0o600);
    renameSync(temporaryPath, logPath);
    const pathname = lstatSync(logPath);
    if (
      !pathname.isFile() ||
      pathname.isSymbolicLink() ||
      pathname.nlink !== 1 ||
      pathname.dev !== opened.dev ||
      pathname.ino !== opened.ino
    ) {
      throw new Error('verify-all report log identity changed during atomic publication');
    }
    const stream = createWriteStream(logPath, { fd: descriptor, autoClose: true });
    descriptor = null;
    return stream;
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (unlinkError) {
      if (!(
        unlinkError &&
        typeof unlinkError === 'object' &&
        'code' in unlinkError &&
        unlinkError.code === 'ENOENT'
      )) {
        throw new Error(
          `${safeMessage(error)}; temporary log cleanup failed: ${safeMessage(unlinkError)}`,
        );
      }
    }
    throw error;
  }
}

async function persistReport() {
  await writeJsonAtomic(reportPath, report);
}

function environmentWith(overrides = {}) {
  const environment = { ...process.env, TMPDIR: TMP_ROOT, TMP: TMP_ROOT, TEMP: TMP_ROOT };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

async function snapshotServiceLogOffsets() {
  const offsets = new Map();
  for (const service of await loadServices()) {
    for (const [stream, suffix] of [
      ['stdout', '.log'],
      ['stderr', '.stderr.log'],
    ]) {
      const logFile = path.join(LOG_ROOT, `${service.id}${suffix}`);
      try {
        const metadata = await lstat(logFile);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
          throw new Error(`${service.id} ${stream} log is not one regular unlinked file`);
        }
        offsets.set(`${service.id}:${stream}`, {
          exists: true,
          path: logFile,
          dev: metadata.dev,
          ino: metadata.ino,
          size: metadata.size,
        });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
        offsets.set(`${service.id}:${stream}`, {
          exists: false,
          path: logFile,
          dev: null,
          ino: null,
          size: 0,
        });
      }
    }
  }
  return offsets;
}

function sameLogSnapshot(left, right) {
  return (
    left?.exists === right?.exists &&
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.size === right?.size
  );
}

async function readStableLog(serviceId, stream, baseline) {
  let handle;
  try {
    handle = await open(baseline.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`${serviceId} ${stream} log is missing during warning verification`);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    const pathname = await lstat(baseline.path);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !pathname.isFile() ||
      pathname.isSymbolicLink() ||
      pathname.nlink !== 1 ||
      opened.dev !== pathname.dev ||
      opened.ino !== pathname.ino ||
      (baseline.exists && (opened.dev !== baseline.dev || opened.ino !== baseline.ino))
    ) {
      throw new Error(`${serviceId} ${stream} log identity changed during verification`);
    }
    const body = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) {
      throw new Error(`${serviceId} ${stream} log inode changed while it was read`);
    }
    return body;
  } finally {
    await handle.close();
  }
}

async function assertNoServiceWarnings(offsets) {
  const warningPattern =
    /\[console\.(?:error|warn)\]|VITE_WARNING_IS_FATAL|(?:^|\n)(?:\(node:\d+\) )?[^\n]*Warning:/u;
  for (const service of await loadServices()) {
    for (const [stream, suffix] of [
      ['stdout', '.log'],
      ['stderr', '.stderr.log'],
    ]) {
      const baseline = offsets.get(`${service.id}:${stream}`);
      if (!baseline) throw new Error(`${service.id} ${stream} log baseline is missing`);
      const body = await readStableLog(service.id, stream, baseline);
      if (body.byteLength < baseline.size) {
        throw new Error(`${service.id} ${stream} log was truncated during verification`);
      }
      const appended = body.subarray(baseline.size).toString('utf8');
      if (stream === 'stderr' && appended.trim().length > 0) {
        throw new Error(
          `${service.id} emitted stderr under the zero-warning contract: ${JSON.stringify(appended.trim().slice(0, 512))}`,
        );
      }
      const warning = stream === 'stdout' ? warningPattern.exec(appended)?.[0] : null;
      if (warning) {
        throw new Error(`${service.id} emitted a zero-warning violation: ${warning.trim()}`);
      }
    }
  }
}

async function assertServiceLogsQuiescentAndWarningFree(offsets) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await snapshotServiceLogOffsets();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stableEndpoint = await snapshotServiceLogOffsets();
    const initiallyStable = [...stableEndpoint.entries()].every(([serviceId, snapshot]) =>
      sameLogSnapshot(before.get(serviceId), snapshot),
    );
    if (!initiallyStable) continue;

    await assertNoServiceWarnings(offsets);
    const afterScan = await snapshotServiceLogOffsets();
    const scanCoveredStableEndpoint = [...afterScan.entries()].every(([serviceId, snapshot]) =>
      sameLogSnapshot(stableEndpoint.get(serviceId), snapshot),
    );
    if (scanCoveredStableEndpoint) return;
  }
  throw new Error('Service logs did not quiesce before the zero-warning decision');
}

function beginActiveTermination() {
  if (!terminationSignal || !activeOwnedProcess || activeTermination) return;
  activeTermination = terminateOwnedProcess(activeOwnedProcess, {
    initialSignal: terminationSignal,
    graceMs: 45_000,
    killGraceMs: 5_000,
  }).catch((error) => {
    terminationFailure = safeMessage(error);
  });
}

function observeTransientProcess(owned) {
  activeOwnedProcess = owned;
  if (owned) beginActiveTermination();
  else activeTermination = null;
}

async function runCommand({
  id,
  display,
  command,
  arguments_,
  environment = {},
  expectedStdout = null,
}) {
  if (terminationSignal) throw new Error(`Verification interrupted by ${terminationSignal}`);

  const step = {
    id,
    command: display,
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    status: 'running',
    exitCode: null,
    signal: null,
  };
  report.steps.push(step);
  await persistReport();
  writeLog(`\n=== ${display} ===\n`);

  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let owned;
  try {
    owned = spawnOwnedProcess(command, arguments_, {
      cwd: REPOSITORY_ROOT,
      env: environmentWith(environment),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    owned = null;
    const result = { exitCode: null, signal: null, spawnError: safeMessage(error) };
    step.completedAt = new Date().toISOString();
    step.durationMs = Date.now() - startedAt;
    step.status = 'failed';
    step.reason = `Could not start ${display}: ${result.spawnError}`;
    await persistReport();
    throw new Error(step.reason);
  }

  activeOwnedProcess = owned;
  owned.child.stdout.on('data', (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
    log.write(chunk);
  });
  owned.child.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
    log.write(chunk);
  });
  beginActiveTermination();
  let result = null;
  let commandFailure = null;
  let descendantFailure = null;
  try {
    result = await waitForOwnedProcess(owned);
    if (activeTermination) await activeTermination;
    if (!terminationSignal && ownedProcessGroupExists(owned)) {
      descendantFailure = `${display} left processes in its exact owned process group`;
      try {
        await terminateOwnedProcess(owned);
      } catch (error) {
        descendantFailure = `${descendantFailure}; cleanup failed: ${safeMessage(error)}`;
      }
    }
  } catch (error) {
    commandFailure = safeMessage(error);
    try {
      await terminateOwnedProcess(owned);
    } catch (cleanupError) {
      commandFailure = `${commandFailure}; exact child cleanup failed: ${safeMessage(cleanupError)}`;
    }
  } finally {
    if (activeTermination) {
      try {
        await activeTermination;
      } catch (terminationError) {
        commandFailure = commandFailure
          ? `${commandFailure}; signal cleanup failed: ${safeMessage(terminationError)}`
          : `signal cleanup failed: ${safeMessage(terminationError)}`;
      }
    }
    activeOwnedProcess = null;
    activeTermination = null;

    step.completedAt = new Date().toISOString();
    step.durationMs = Date.now() - startedAt;
    step.exitCode = result?.exitCode ?? null;
    step.signal = result?.signal ?? null;
    const outputMatches = expectedStdout === null || stdout.trim() === expectedStdout;
    const stderrIsEmpty = stderr.trim().length === 0;
    step.status =
      commandFailure === null &&
      result?.exitCode === 0 &&
      result.signal === null &&
      result.spawnError === null &&
      result.leakedDescendants === false &&
      terminationFailure === null &&
      descendantFailure === null &&
      terminationSignal === null &&
      outputMatches &&
      stderrIsEmpty
        ? 'passed'
        : 'failed';
    if (commandFailure) {
      step.reason = `${display} execution failed: ${commandFailure}`;
    } else if (result?.spawnError) {
      step.reason = `Could not start ${display}: ${result.spawnError}`;
    } else if (result?.leakedDescendants) {
      step.reason = `${display} leaked descendants; its exact group was terminated`;
    } else if (terminationFailure) {
      step.reason = `Could not terminate ${display}: ${terminationFailure}`;
    } else if (descendantFailure) {
      step.reason = descendantFailure;
    } else if (!outputMatches) {
      step.reason = `Expected stdout ${JSON.stringify(expectedStdout)}, received ${JSON.stringify(stdout.trim())}`;
    } else if (!stderrIsEmpty) {
      step.reason = `Command emitted stderr under the zero-warning contract: ${JSON.stringify(stderr.trim())}`;
    }
    await persistReport();
  }

  if (step.status !== 'passed') {
    throw new Error(
      step.reason ??
        `${display} failed${result?.signal ? ` from ${result.signal}` : ` with exit code ${String(result?.exitCode)}`}`,
    );
  }
  if (terminationSignal) throw new Error(`Verification interrupted by ${terminationSignal}`);
}

function runPackageScript(id, script, options = {}) {
  return runCommand({
    id,
    display: options.display ?? `pnpm run ${script}`,
    command: packageManagerCommand(),
    arguments_: ['--silent', 'run', script],
    environment: options.environment,
  });
}

async function runInternalStep({ id, display, operation }) {
  const step = {
    id,
    command: display,
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    status: 'running',
    exitCode: null,
    signal: null,
  };
  report.steps.push(step);
  await persistReport();
  writeLog(`\n=== ${display} ===\n`);
  const startedAt = Date.now();
  try {
    const result = await operation();
    if (terminationSignal) throw new Error(`Verification interrupted by ${terminationSignal}`);
    step.status = 'passed';
    step.exitCode = 0;
    return result;
  } catch (error) {
    step.status = 'failed';
    step.exitCode = 1;
    step.reason = safeMessage(error);
    throw error;
  } finally {
    step.completedAt = new Date().toISOString();
    step.durationMs = Date.now() - startedAt;
    await persistReport();
  }
}

async function assertToolchain() {
  const packageJson = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  );
  const expectedNode = `v${await readFile(path.join(REPOSITORY_ROOT, '.node-version'), 'utf8').then(
    (value) => value.trim(),
  )}`;
  const packageManagerMatch = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(String(packageJson.packageManager));
  if (!packageManagerMatch) {
    throw new Error('package.json packageManager must be an exact pnpm semantic version');
  }
  const expectedPnpm = packageManagerMatch[1];
  if (process.version !== expectedNode) {
    throw new Error(
      `TOOLCHAIN_NODE_MISMATCH: expected ${expectedNode}, received ${process.version}`,
    );
  }
  await runCommand({
    id: 'toolchain',
    display: `pnpm --version (expected ${expectedPnpm})`,
    command: packageManagerCommand(),
    arguments_: ['--version'],
    expectedStdout: expectedPnpm,
  });
}

async function cleanupLaunchedServices(launchedRunIds) {
  if (launchedRunIds.size === 0) {
    report.cleanup = {
      status: 'passed',
      services: [],
      message: 'No service was started or replaced.',
    };
    return;
  }

  const services = [...launchedRunIds.keys()].sort();
  await runDown({
    emit: false,
    only: new Set(services),
    expectedRunIds: launchedRunIds,
  });
  report.cleanup = {
    status: 'passed',
    services,
    message: 'Targeted only exact service run IDs returned by this verify-all invocation.',
  };
  writeLog(`\nverify-all cleanup stopped only: ${services.join(', ')}\n`);
}

function handleSignal(signal) {
  if (committingLeaseRelease) {
    deferredFinalSignal ??= signal;
    return;
  }
  if (terminationSignal) return;
  terminationSignal = signal;
  report.status = 'interrupted';
  report.error = `Verification interrupted by ${signal}`;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  writeLog(`\nverify-all received ${signal}; stopping the active child before owned cleanup\n`);
  beginActiveTermination();
}

const verificationLease = await acquireVerificationLease('pnpm run verify-all');
await ensureDevDirectories();
log = createSafeReportLog();
log.on('error', (error) => {
  logFailure = safeMessage(error);
});
const launchedRunIds = new Map();
const serviceLogOffsets = await snapshotServiceLogOffsets();
let failure = null;

const handleSigint = () => handleSignal('SIGINT');
const handleSigterm = () => handleSignal('SIGTERM');
process.on('SIGINT', handleSigint);
process.on('SIGTERM', handleSigterm);

try {
  await assertToolchain();
  await runPackageScript('dev-preflight', 'dev:preflight');
  const upResult = await runInternalStep({
    id: 'dev-up',
    display: 'pnpm run dev:up',
    operation: () =>
      runUp({
        isInterrupted: () => terminationSignal,
        onServiceStarted: ({ serviceId, runId }) => launchedRunIds.set(serviceId, runId),
        onTransientProcess: observeTransientProcess,
      }),
  });
  for (const started of upResult.started) {
    launchedRunIds.set(started.serviceId, started.runId);
  }
  await runPackageScript('dev-health-initial', 'dev:health');
  await runPackageScript('static-checks', 'check');
  await runPackageScript('tests', 'test');
  await runPackageScript('build', 'build');
  await runCommand({
    id: 'dependency-audit',
    display: 'pnpm audit --audit-level high',
    command: packageManagerCommand(),
    arguments_: ['audit', '--audit-level', 'high'],
  });
  await runPackageScript('sbom', 'sbom:generate');
  await runPackageScript('evidence', 'evidence:generate');
  await runPackageScript('browser-tests', 'test:e2e', {
    display: 'PLAYWRIGHT_REUSE_OWNED=1 pnpm run test:e2e',
    environment: { PLAYWRIGHT_REUSE_OWNED: '1' },
  });
  await runPackageScript('dev-health-final', 'dev:health');
  await runCommand({
    id: 'diff-check',
    display: 'git diff --check',
    command: 'git',
    arguments_: ['diff', '--check'],
  });
  await runCommand({
    id: 'tracked-clean',
    display: 'git diff --exit-code -- .',
    command: 'git',
    arguments_: ['diff', '--exit-code', '--', '.'],
  });
  await runCommand({
    id: 'untracked-clean',
    display: 'git ls-files --others --exclude-standard',
    command: 'git',
    arguments_: ['ls-files', '--others', '--exclude-standard'],
    expectedStdout: '',
  });
  await runCommand({
    id: 'complete-status-clean',
    display: 'git status --porcelain=v1 --untracked-files=all',
    command: 'git',
    arguments_: ['status', '--porcelain=v1', '--untracked-files=all'],
    expectedStdout: '',
  });
  await runInternalStep({
    id: 'service-log-warnings',
    display: 'quiesce and scan final service log append ranges for warnings',
    operation: () => assertServiceLogsQuiescentAndWarningFree(serviceLogOffsets),
  });
  if (terminationSignal) throw new Error(`Verification interrupted by ${terminationSignal}`);
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = terminationSignal ? 'interrupted' : 'failed';
  report.error = safeMessage(error);
  process.exitCode = terminationSignal === 'SIGINT' ? 130 : terminationSignal ? 143 : 1;
} finally {
  try {
    await cleanupLaunchedServices(launchedRunIds);
  } catch (cleanupError) {
    const message = safeMessage(cleanupError);
    report.cleanup = { status: 'failed', services: [], message };
    report.status = 'failed';
    report.error = failure ? `${safeMessage(failure)}; cleanup failed: ${message}` : message;
    process.exitCode = 1;
  }
  try {
    await assertServiceLogsQuiescentAndWarningFree(serviceLogOffsets);
  } catch (warningError) {
    const message = safeMessage(warningError);
    report.status = 'failed';
    report.error = report.error ? `${report.error}; final log scan failed: ${message}` : message;
    process.exitCode = 1;
  }
  await new Promise((resolve) => log.end(resolve));
  if (logFailure) {
    report.status = 'failed';
    report.error = report.error
      ? `${report.error}; verification log failed: ${logFailure}`
      : `Verification log failed: ${logFailure}`;
    process.exitCode = 1;
  }
  if (terminationSignal && report.status === 'passed') {
    report.status = 'interrupted';
    report.error = `Verification interrupted by ${terminationSignal}`;
    process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
  }
  report.completedAt = new Date().toISOString();
  const persistSignalStableReport = async () => {
    while (true) {
      const signalBeforePersist = terminationSignal;
      await persistReport();
      if (terminationSignal === signalBeforePersist) return;
      report.status = 'interrupted';
      report.error = `Verification interrupted by ${terminationSignal}`;
      process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
    }
  };
  try {
    await releaseVerificationLease(verificationLease, {
      beforeRelease: persistSignalStableReport,
      beforeUnlink: () => {
        committingLeaseRelease = true;
      },
      onUnlinkFailure: () => {
        committingLeaseRelease = false;
        if (deferredFinalSignal) handleSignal(deferredFinalSignal);
        deferredFinalSignal = null;
      },
    });
  } catch (leaseError) {
    const message = safeMessage(leaseError);
    report.status = 'failed';
    report.error = report.error
      ? `${report.error}; verification lease release failed: ${message}`
      : `Verification lease release failed: ${message}`;
    process.exitCode = 1;
    // A release failure leaves the lease in place. Persist the failure while
    // that lease still excludes other writers; never write after an unlock.
    await persistSignalStableReport();
  }
  committingLeaseRelease = false;
  deferredFinalSignal = null;
  process.removeListener('SIGINT', handleSigint);
  process.removeListener('SIGTERM', handleSigterm);
}

if (report.status === 'passed') {
  console.log(`verify-all passed; machine-readable report: ${reportPath}`);
} else {
  console.error(`verify-all ${report.status}: ${report.error ?? 'unknown failure'}`);
}
