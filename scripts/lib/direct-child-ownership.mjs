import { spawn } from 'node:child_process';

import { processStartedAt } from './dev-contract.mjs';

const directChildren = new WeakSet();

function assertCapability(owned) {
  if (!owned || typeof owned !== 'object' || !directChildren.has(owned) || owned.released) {
    throw new Error('DIRECT_CHILD_OWNERSHIP_REQUIRED: refusing to signal an unowned process');
  }
}

function isSettled(owned) {
  return owned.exited || owned.child.exitCode !== null || owned.child.signalCode !== null;
}

function assertCurrentIdentity(owned, expectedStartedAt) {
  if (isSettled(owned)) return false;
  if (owned.child.pid !== owned.pid || !Number.isSafeInteger(owned.pid) || owned.pid <= 1) {
    throw new Error('DIRECT_CHILD_IDENTITY_CHANGED: child PID no longer matches its capability');
  }

  if (expectedStartedAt !== null) {
    const observedStartedAt = processStartedAt(owned.pid);
    if (observedStartedAt.length === 0) return false;
    if (observedStartedAt !== expectedStartedAt) {
      throw new Error(
        `DIRECT_CHILD_IDENTITY_CHANGED: PID ${owned.pid} start fingerprint no longer matches`,
      );
    }
  }

  return true;
}

async function waitForExit(owned, timeoutMs) {
  if (isSettled(owned)) return true;
  let timer;
  const exited = await Promise.race([
    owned.exitPromise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return exited;
}

/**
 * Create a nonce-free but unforgeable in-process capability for one direct
 * child. Until Node observes and records the child's exit, POSIX cannot reuse
 * that unreaped direct-child PID; identity validation and child.kill() run in
 * the same synchronous turn. This is intentionally limited to a direct PID,
 * never a process group or discovered listener.
 */
export function spawnDirectOwnedChild(command, arguments_, options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('DIRECT_CHILD_COMMAND_INVALID');
  }
  if (!Array.isArray(arguments_) || arguments_.some((value) => typeof value !== 'string')) {
    throw new Error('DIRECT_CHILD_ARGUMENTS_INVALID');
  }
  if (options.shell !== undefined && options.shell !== false) {
    throw new Error('DIRECT_CHILD_SHELL_FORBIDDEN');
  }

  const child = spawn(command, arguments_, { ...options, shell: false });
  let resolveExit;
  const owned = {
    child,
    exitPromise: new Promise((resolve) => {
      resolveExit = resolve;
    }),
    exited: false,
    pid: null,
    released: false,
    terminationPromise: null,
  };
  directChildren.add(owned);

  owned.spawnPromise = new Promise((resolve, reject) => {
    child.once('spawn', () => {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
        reject(new Error('DIRECT_CHILD_PID_INVALID'));
        return;
      }
      owned.pid = child.pid;
      resolve(child.pid);
    });
    child.once('error', reject);
  });
  child.once('exit', (exitCode, signal) => {
    owned.exited = true;
    resolveExit({ exitCode, signal });
  });

  return owned;
}

export async function waitForDirectOwnedChildSpawn(owned) {
  assertCapability(owned);
  return owned.spawnPromise;
}

export function terminateDirectOwnedChild(
  owned,
  {
    expectedStartedAt = null,
    initialSignal = 'SIGTERM',
    graceMs = 5_000,
    killGraceMs = 2_000,
  } = {},
) {
  assertCapability(owned);
  if (
    expectedStartedAt !== null &&
    (typeof expectedStartedAt !== 'string' || expectedStartedAt.length === 0)
  ) {
    throw new Error('DIRECT_CHILD_FINGERPRINT_INVALID');
  }
  if (!['SIGINT', 'SIGTERM'].includes(initialSignal)) {
    throw new Error(`DIRECT_CHILD_SIGNAL_INVALID: ${initialSignal}`);
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error('DIRECT_CHILD_GRACE_INVALID');
  }
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1) {
    throw new Error('DIRECT_CHILD_KILL_GRACE_INVALID');
  }
  if (owned.terminationPromise) return owned.terminationPromise;

  const termination = (async () => {
    try {
      await owned.spawnPromise;
    } catch {
      await waitForExit(owned, killGraceMs);
      return;
    }
    if (!assertCurrentIdentity(owned, expectedStartedAt)) {
      await waitForExit(owned, killGraceMs);
      return;
    }
    if (!owned.child.kill(initialSignal) && !isSettled(owned)) {
      throw new Error(`DIRECT_CHILD_SIGNAL_FAILED: PID ${owned.pid} rejected ${initialSignal}`);
    }
    if (await waitForExit(owned, graceMs)) return;

    if (!assertCurrentIdentity(owned, expectedStartedAt)) {
      if (await waitForExit(owned, killGraceMs)) return;
      throw new Error(`DIRECT_CHILD_OWNERSHIP_LOST: PID ${owned.pid} vanished without exit`);
    }
    if (!owned.child.kill('SIGKILL') && !isSettled(owned)) {
      throw new Error(`DIRECT_CHILD_SIGNAL_FAILED: PID ${owned.pid} rejected SIGKILL`);
    }
    if (!(await waitForExit(owned, killGraceMs))) {
      throw new Error(`DIRECT_CHILD_STUCK: PID ${owned.pid} survived validated SIGKILL`);
    }
  })();
  owned.terminationPromise = termination.catch((error) => {
    owned.terminationPromise = null;
    throw error;
  });
  return owned.terminationPromise;
}

export function releaseDirectOwnedChild(owned) {
  assertCapability(owned);
  owned.released = true;
  directChildren.delete(owned);
  owned.child.unref();
}
