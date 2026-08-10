import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ownedProcesses = new WeakSet();
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
const GUARDIAN_PATH = fileURLToPath(new URL('./owned-command-guardian.mjs', import.meta.url));
const allowedStdio = new Set(['ignore', 'inherit', 'pipe']);
const PROCESS_PROBE_TIMEOUT_MS = 10_000;

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertOwnedProcess(owned) {
  if (!owned || typeof owned !== 'object' || !ownedProcesses.has(owned)) {
    throw new Error('OWNED_PROCESS_REQUIRED: refusing to signal an unregistered process');
  }
}

function assertSupportedPlatform() {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new Error(
      `OWNED_PROCESS_GROUP_UNSUPPORTED: ${process.platform}; supported hosts are macOS and Linux`,
    );
  }
}

function normalizeStdio(stdio) {
  const values = Array.isArray(stdio) ? stdio : [stdio ?? 'pipe', stdio ?? 'pipe', stdio ?? 'pipe'];
  if (values.length !== 3 || values.some((value) => !allowedStdio.has(value))) {
    throw new Error('OWNED_PROCESS_STDIO_INVALID: use exactly ignore, inherit, or pipe');
  }
  return [...values, 'ipc'];
}

function processStartedAt(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    shell: false,
    timeout: PROCESS_PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  if (result.status === 1 && result.stdout === '' && result.stderr === '') return null;
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    result.stderr !== '' ||
    result.stdout.trim().length === 0 ||
    result.stdout.trim().includes('\n')
  ) {
    const detail = result.error ?? (result.stderr || `exit ${String(result.status)}`);
    throw new Error(`OWNED_PROCESS_FINGERPRINT_FAILED: PID ${pid}: ${safeMessage(detail)}`);
  }
  return result.stdout.trim();
}

function processCommand(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    shell: false,
    timeout: PROCESS_PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  if (result.status === 1 && result.stdout === '' && result.stderr === '') return null;
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    result.stderr !== '' ||
    result.stdout.trim().length === 0 ||
    result.stdout.trim().includes('\n')
  ) {
    const detail = result.error ?? (result.stderr || `exit ${String(result.status)}`);
    throw new Error(`OWNED_PROCESS_COMMAND_FAILED: PID ${pid}: ${safeMessage(detail)}`);
  }
  return result.stdout.trim();
}

function processGroupMembers(processGroupId) {
  const arguments_ =
    process.platform === 'linux'
      ? ['-e', '-o', 'pid=,pgid=,stat=']
      : ['-o', 'pid=,pgid=,stat=', '-g', String(processGroupId)];
  const result = spawnSync('ps', arguments_, {
    encoding: 'utf8',
    shell: false,
    timeout: PROCESS_PROBE_TIMEOUT_MS,
    maxBuffer: process.platform === 'linux' ? 4 * 1024 * 1024 : 1024 * 1024,
  });
  if (
    result.status === 1 &&
    result.signal === null &&
    typeof result.stdout === 'string' &&
    result.stdout.trim().length === 0 &&
    typeof result.stderr === 'string' &&
    result.stderr.trim().length === 0
  ) {
    return [];
  }
  if (result.error || result.signal || result.status !== 0 || result.stderr !== '') {
    const detail = result.error ?? (result.stderr || `exit ${String(result.status)}`);
    throw new Error(
      `OWNED_PROCESS_GROUP_PS_FAILED: PGID ${processGroupId}: ${safeMessage(detail)}`,
    );
  }
  const members = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) throw new Error(`OWNED_PROCESS_GROUP_PS_MALFORMED: ${JSON.stringify(line)}`);
    if (Number(match[2]) === processGroupId) {
      members.push({ pid: Number(match[1]), state: match[3] });
    }
  }
  return members;
}

function hasRunnableGroupMember(owned, { excludeGuardian = false } = {}) {
  const processGroupId = owned.processGroupId;
  if (processGroupId === null) return false;
  return processGroupMembers(processGroupId).some(
    ({ pid, state }) =>
      !state.startsWith('Z') && (!excludeGuardian || pid !== owned.processGroupId),
  );
}

function assertGuardianIdentity(owned) {
  if (owned.guardianClosed || owned.processGroupId === null || owned.processStartedAt === null) {
    return false;
  }
  const observed = processStartedAt(owned.processGroupId);
  if (observed === null) return false;
  if (observed !== owned.processStartedAt) {
    throw new Error(
      `OWNED_PROCESS_GUARDIAN_REUSED: PID ${owned.processGroupId} fingerprint changed; refusing signal`,
    );
  }
  const command = processCommand(owned.processGroupId);
  if (
    command === null ||
    !command.includes(GUARDIAN_PATH) ||
    !command.includes(`--run-id ${owned.runId}`) ||
    !owned.child.connected
  ) {
    throw new Error(
      `OWNED_PROCESS_GUARDIAN_REUSED: PID ${owned.processGroupId} nonce-bound command or IPC channel changed`,
    );
  }
  return true;
}

async function waitForCondition(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

async function waitForPromise(promise, timeoutMs) {
  let timer;
  const timed = await Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return timed;
}

async function sendGuardianMessage(owned, message, timeoutMs = 2_000) {
  if (owned.guardianClosed || !owned.child.connected) {
    throw new Error('OWNED_PROCESS_GUARDIAN_CHANNEL_CLOSED');
  }
  let timer;
  const result = await Promise.race([
    new Promise((resolve) => {
      owned.child.send({ ...message, runId: owned.runId }, (error) => {
        resolve(error ? { ok: false, error: safeMessage(error) } : { ok: true });
      });
    }),
    new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: `guardian IPC exceeded ${timeoutMs}ms` }),
        timeoutMs,
      );
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!result.ok) throw new Error(`OWNED_PROCESS_GUARDIAN_IPC_FAILED: ${result.error}`);
}

async function terminateGroupBySpawnCapability(
  owned,
  { initialSignal = 'SIGTERM', graceMs = 5_000, killGraceMs = 2_000 } = {},
) {
  assertOwnedProcess(owned);
  if (owned.guardianClosed) return;
  if (
    owned.processGroupId === null ||
    owned.child.pid !== owned.processGroupId ||
    owned.child.exitCode !== null ||
    owned.child.signalCode !== null
  ) {
    throw new Error('OWNED_PROCESS_SPAWN_CAPABILITY_LOST: refusing group signal');
  }

  // The persistent guardian is the original group leader. While this exact,
  // unreaped ChildProcess capability is live, its PGID cannot be reused.
  owned.child.kill(initialSignal);
  if (await waitForPromise(owned.guardianClosePromise, graceMs)) return;
  if (
    owned.guardianClosed ||
    owned.child.pid !== owned.processGroupId ||
    owned.child.exitCode !== null ||
    owned.child.signalCode !== null
  ) {
    throw new Error('OWNED_PROCESS_SPAWN_CAPABILITY_LOST: refusing SIGKILL escalation');
  }
  process.kill(-owned.processGroupId, 'SIGKILL');
  if (!(await waitForPromise(owned.guardianClosePromise, killGraceMs))) {
    throw new Error('OWNED_PROCESS_GROUP_STUCK: spawn-capability escalation timed out');
  }
}

async function sendRelease(owned) {
  if (owned.guardianClosed) return;
  if (!assertGuardianIdentity(owned)) {
    throw new Error('OWNED_PROCESS_GUARDIAN_MISSING: cannot release an unverified guardian');
  }
  if (hasRunnableGroupMember(owned, { excludeGuardian: true })) {
    throw new Error('OWNED_PROCESS_RELEASE_REFUSED: runnable descendants remain');
  }
  if (!owned.releaseRequested) {
    owned.releaseRequested = true;
    await sendGuardianMessage(owned, { type: 'release' });
  }
  if (await waitForPromise(owned.guardianClosePromise, 2_000)) return;

  if (!assertGuardianIdentity(owned)) {
    if (hasRunnableGroupMember(owned)) {
      throw new Error('OWNED_PROCESS_RELEASE_LOST_OWNERSHIP: guardian vanished with live members');
    }
    return;
  }
  process.kill(-owned.processGroupId, 'SIGKILL');
  if (!(await waitForPromise(owned.guardianClosePromise, 2_000))) {
    throw new Error('OWNED_PROCESS_GUARDIAN_STUCK: release escalation did not close guardian');
  }
}

/**
 * Spawn one transient command behind a persistent, nonce-bound POSIX group
 * guardian. The guardian remains the original group leader until the parent
 * explicitly releases or kills the group, preventing PGID reuse while the
 * signalling capability is live.
 */
export function spawnOwnedProcess(command, arguments_, options = {}) {
  assertSupportedPlatform();
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('OWNED_PROCESS_COMMAND_INVALID');
  }
  if (!Array.isArray(arguments_) || arguments_.some((value) => typeof value !== 'string')) {
    throw new Error('OWNED_PROCESS_ARGUMENTS_INVALID');
  }
  if (options.shell !== undefined && options.shell !== false) {
    throw new Error('OWNED_PROCESS_SHELL_FORBIDDEN');
  }
  if (options.detached !== undefined && options.detached !== true) {
    throw new Error('OWNED_PROCESS_GROUP_REQUIRED');
  }

  const runId = randomUUID();
  const payload = Buffer.from(JSON.stringify({ command, arguments_ }), 'utf8').toString(
    'base64url',
  );
  const child = spawn(process.execPath, [GUARDIAN_PATH, '--run-id', runId], {
    ...options,
    env: {
      ...(options.env ?? process.env),
      CODEX_OWNED_COMMAND_PAYLOAD: payload,
      CODEX_OWNED_COMMAND_RUN_ID: runId,
    },
    detached: true,
    shell: false,
    stdio: normalizeStdio(options.stdio),
  });

  let guardianSpawnError = null;
  let commandResult = null;
  let resolveCommandResult;
  let resolveGuardianClose;
  const commandResultPromise = new Promise((resolve) => {
    resolveCommandResult = resolve;
  });
  const guardianClosePromise = new Promise((resolve) => {
    resolveGuardianClose = resolve;
  });

  const owned = {
    child,
    commandResultPromise,
    guardianClosePromise,
    guardianClosed: false,
    processGroupId: null,
    processStartedAt: null,
    releaseRequested: false,
    runId,
    targetSettled: false,
    terminationPromise: null,
    waitPromise: null,
  };
  ownedProcesses.add(owned);

  owned.spawnPromise = new Promise((resolve, reject) => {
    child.once('spawn', () => {
      void (async () => {
        if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
          throw new Error('OWNED_PROCESS_PID_INVALID');
        }
        owned.processGroupId = child.pid;
        owned.processStartedAt = processStartedAt(child.pid);
        if (owned.processStartedAt === null) throw new Error('guardian exited before fingerprint');
        await sendGuardianMessage(owned, { type: 'start' });
        resolve();
      })().catch(async (error) => {
        guardianSpawnError = safeMessage(error);
        let cleanupFailure = null;
        try {
          await sendGuardianMessage(owned, { type: 'abort' }, 500);
          if (!(await waitForPromise(owned.guardianClosePromise, 2_000))) {
            await terminateGroupBySpawnCapability(owned, {
              graceMs: 2_000,
              killGraceMs: 2_000,
            });
          }
        } catch (cleanupError) {
          cleanupFailure = safeMessage(cleanupError);
        }
        if (cleanupFailure) {
          guardianSpawnError = `${guardianSpawnError}; guardian startup cleanup failed: ${cleanupFailure}`;
        }
        reject(new Error(guardianSpawnError));
      });
    });
    child.once('error', (error) => {
      guardianSpawnError = safeMessage(error);
      reject(error);
    });
  });

  child.on('message', (message) => {
    if (!message || typeof message !== 'object' || message.runId !== runId) return;
    if (message.type === 'target-result' && !owned.targetSettled) {
      const validExitCode = message.exitCode === null || Number.isInteger(message.exitCode);
      const validSignal = message.signal === null || typeof message.signal === 'string';
      const validSpawnError = message.spawnError === null || typeof message.spawnError === 'string';
      owned.targetSettled = true;
      commandResult =
        validExitCode && validSignal && validSpawnError
          ? {
              exitCode: message.exitCode,
              signal: message.signal,
              spawnError: message.spawnError,
            }
          : {
              exitCode: null,
              signal: null,
              spawnError: 'owned guardian emitted a malformed target result',
            };
      resolveCommandResult(commandResult);
    }
  });
  child.once('close', (exitCode, signal) => {
    owned.guardianClosed = true;
    if (!owned.targetSettled) {
      owned.targetSettled = true;
      commandResult = {
        exitCode: null,
        signal,
        spawnError:
          guardianSpawnError ??
          `owned guardian closed before target result (exit ${String(exitCode)})`,
      };
      resolveCommandResult(commandResult);
    }
    resolveGuardianClose({ exitCode, signal });
  });

  return owned;
}

export function terminateOwnedProcess(
  owned,
  { initialSignal = 'SIGTERM', graceMs = 5_000, killGraceMs = 2_000 } = {},
) {
  assertOwnedProcess(owned);
  if (!['SIGINT', 'SIGTERM'].includes(initialSignal)) {
    throw new Error(`OWNED_PROCESS_INITIAL_SIGNAL_INVALID: ${initialSignal}`);
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error('OWNED_PROCESS_GRACE_INVALID');
  }
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1) {
    throw new Error('OWNED_PROCESS_KILL_GRACE_INVALID');
  }
  if (owned.terminationPromise) return owned.terminationPromise;

  owned.terminationPromise = (async () => {
    try {
      await owned.spawnPromise;
    } catch {
      if (!(await waitForPromise(owned.guardianClosePromise, killGraceMs))) {
        await terminateGroupBySpawnCapability(owned, { graceMs, killGraceMs });
      }
      return;
    }
    if (!assertGuardianIdentity(owned)) {
      if (hasRunnableGroupMember(owned)) {
        throw new Error('OWNED_PROCESS_OWNERSHIP_LOST: guardian absent with live group members');
      }
      return;
    }

    process.kill(owned.processGroupId, initialSignal);
    const readyToRelease = await waitForCondition(
      () =>
        owned.guardianClosed ||
        (owned.targetSettled && !hasRunnableGroupMember(owned, { excludeGuardian: true })),
      graceMs,
    );
    if (readyToRelease && !owned.guardianClosed) {
      await sendRelease(owned);
      return;
    }
    if (owned.guardianClosed) {
      if (hasRunnableGroupMember(owned)) {
        throw new Error('OWNED_PROCESS_OWNERSHIP_LOST: guardian exited before descendants');
      }
      return;
    }

    if (!assertGuardianIdentity(owned)) {
      throw new Error('OWNED_PROCESS_GUARDIAN_REUSED: refusing SIGKILL escalation');
    }
    process.kill(-owned.processGroupId, 'SIGKILL');
    if (!(await waitForPromise(owned.guardianClosePromise, killGraceMs))) {
      throw new Error(
        `OWNED_PROCESS_GROUP_STUCK: PGID ${owned.processGroupId} survived validated SIGKILL`,
      );
    }
    if (hasRunnableGroupMember(owned)) {
      throw new Error(
        `OWNED_PROCESS_GROUP_STUCK: PGID ${owned.processGroupId} retains runnable members`,
      );
    }
  })();
  return owned.terminationPromise;
}

export function waitForOwnedProcess(
  owned,
  { timeoutMs = 10 * 60_000, timeoutTermination = {} } = {},
) {
  assertOwnedProcess(owned);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('OWNED_PROCESS_TIMEOUT_INVALID');
  }
  if (owned.waitPromise) return owned.waitPromise;

  owned.waitPromise = (async () => {
    try {
      try {
        await owned.spawnPromise;
      } catch {
        if (!(await waitForPromise(owned.guardianClosePromise, 2_000))) {
          await terminateGroupBySpawnCapability(owned, { graceMs: 2_000, killGraceMs: 2_000 });
        }
        return owned.commandResultPromise;
      }

      let timer;
      const outcome = await Promise.race([
        owned.commandResultPromise.then((result) => ({ type: 'result', result })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome.type === 'timeout') {
        await terminateOwnedProcess(owned, timeoutTermination);
        throw new Error(`OWNED_PROCESS_TIMEOUT: command exceeded ${timeoutMs}ms`);
      }

      let leakedDescendants = false;
      if (owned.terminationPromise) {
        await owned.terminationPromise;
      } else if (!owned.guardianClosed) {
        leakedDescendants = hasRunnableGroupMember(owned, { excludeGuardian: true });
        if (leakedDescendants) await terminateOwnedProcess(owned);
        else await sendRelease(owned);
      }
      await owned.guardianClosePromise;
      return { ...outcome.result, leakedDescendants };
    } catch (error) {
      try {
        await terminateGroupBySpawnCapability(owned);
      } catch (cleanupError) {
        throw new Error(
          `${safeMessage(error)}; owned-group cleanup failed: ${safeMessage(cleanupError)}`,
        );
      }
      throw error;
    }
  })();
  return owned.waitPromise;
}

export function ownedProcessGroupExists(owned) {
  assertOwnedProcess(owned);
  return hasRunnableGroupMember(owned);
}
