import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { link, lstat, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  DEV_ROOT,
  PROJECT_NAME,
  REPOSITORY_ROOT,
  ensureDevDirectories,
  isPidAlive,
  processStartedAt,
  withLifecycleLock,
} from './dev-contract.mjs';

const LEASE_PATH = path.join(DEV_ROOT, 'verification.lock');
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isLeaseRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.schemaVersion === 1 &&
    value.project === PROJECT_NAME &&
    value.repositoryRoot === REPOSITORY_ROOT &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 1 &&
    typeof value.processStartedAt === 'string' &&
    value.processStartedAt.length > 0 &&
    typeof value.token === 'string' &&
    tokenPattern.test(value.token) &&
    typeof value.command === 'string' &&
    value.command.length > 0 &&
    typeof value.createdAt === 'string'
  );
}

async function readLeaseRecord() {
  let metadata;
  try {
    metadata = await lstat(LEASE_PATH);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('VERIFICATION_LEASE_PATH_UNSAFE: expected a regular repository-local file');
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(LEASE_PATH, 'utf8'));
  } catch {
    throw new Error('VERIFICATION_LEASE_CORRUPT: owner cannot be proven');
  }
  if (!isLeaseRecord(parsed)) {
    throw new Error('VERIFICATION_LEASE_CORRUPT: record schema is invalid');
  }
  return parsed;
}

function isLiveLease(record) {
  if (!isPidAlive(record.pid)) return false;
  const observedStartedAt = processStartedAt(record.pid);
  if (observedStartedAt === record.processStartedAt) return true;
  if (observedStartedAt.length === 0 && isPidAlive(record.pid)) {
    throw new Error('VERIFICATION_LEASE_OWNER_UNCERTAIN: PID state cannot be proven stale');
  }
  return false;
}

async function removeStaleLease(record) {
  const current = await readLeaseRecord();
  if (!current) return;
  if (current.token !== record.token || current.pid !== record.pid) {
    throw new Error('VERIFICATION_LEASE_CHANGED: refusing to remove a replaced lease');
  }
  if (isLiveLease(current)) {
    throw new Error(`VERIFICATION_LEASE_BUSY: ${current.command} is active in PID ${current.pid}`);
  }
  await rm(LEASE_PATH);
}

export async function acquireVerificationLease(command) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('VERIFICATION_LEASE_COMMAND_INVALID');
  }
  await ensureDevDirectories();
  const inheritedToken = process.env['VERIFICATION_LEASE_TOKEN'];
  if (inheritedToken !== undefined) {
    const record = await readLeaseRecord();
    if (!record || inheritedToken !== record.token || !isLiveLease(record)) {
      throw new Error('VERIFICATION_LEASE_INHERITANCE_INVALID');
    }
    return { owned: false, record, previousToken: inheritedToken };
  }

  const { record, token } = await withLifecycleLock(async () => {
    const token = randomUUID();
    const record = {
      schemaVersion: 1,
      project: PROJECT_NAME,
      repositoryRoot: REPOSITORY_ROOT,
      pid: process.pid,
      processStartedAt: processStartedAt(process.pid),
      token,
      command,
      createdAt: new Date().toISOString(),
    };
    if (!record.processStartedAt) throw new Error('VERIFICATION_LEASE_FINGERPRINT_FAILED');

    while (true) {
      const temporaryPath = `${LEASE_PATH}.${process.pid}.${token}.tmp`;
      try {
        const handle = await open(temporaryPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(temporaryPath, LEASE_PATH);
        await rm(temporaryPath, { force: true });
        return { record, token };
      } catch (error) {
        await rm(temporaryPath, { force: true });
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
          throw error;
        }
        const existing = await readLeaseRecord();
        if (!existing) continue;
        if (isLiveLease(existing)) {
          throw new Error(
            `VERIFICATION_LEASE_BUSY: ${existing.command} is active in PID ${existing.pid}`,
          );
        }
        await removeStaleLease(existing);
      }
    }
  });

  process.env['VERIFICATION_LEASE_TOKEN'] = token;
  return { owned: true, record, previousToken: undefined };
}

export async function releaseVerificationLease(
  lease,
  { beforeRelease, beforeUnlink, onUnlinkFailure } = {},
) {
  if (!lease || typeof lease !== 'object') throw new Error('VERIFICATION_LEASE_REQUIRED');
  if (beforeRelease !== undefined && typeof beforeRelease !== 'function') {
    throw new Error('VERIFICATION_LEASE_FINALIZER_INVALID');
  }
  if (beforeUnlink !== undefined && typeof beforeUnlink !== 'function') {
    throw new Error('VERIFICATION_LEASE_UNLINK_GUARD_INVALID');
  }
  if (onUnlinkFailure !== undefined && typeof onUnlinkFailure !== 'function') {
    throw new Error('VERIFICATION_LEASE_UNLINK_RECOVERY_INVALID');
  }
  if (lease.owned) {
    const current = await readLeaseRecord();
    if (
      !current ||
      current.token !== lease.record.token ||
      current.pid !== lease.record.pid ||
      current.processStartedAt !== lease.record.processStartedAt
    ) {
      throw new Error('VERIFICATION_LEASE_RELEASE_REFUSED: ownership changed');
    }
    if (beforeRelease) await beforeRelease();
    if (beforeUnlink) beforeUnlink();
    try {
      rmSync(LEASE_PATH);
    } catch (error) {
      if (onUnlinkFailure) onUnlinkFailure();
      throw error;
    }
  } else if (beforeRelease) {
    await beforeRelease();
    if (beforeUnlink) beforeUnlink();
  }
  if (lease.previousToken === undefined) delete process.env['VERIFICATION_LEASE_TOKEN'];
  else process.env['VERIFICATION_LEASE_TOKEN'] = lease.previousToken;
}

export async function assertVerificationLeaseAccess() {
  const record = await readLeaseRecord();
  if (!record) return;
  if (!isLiveLease(record)) {
    await removeStaleLease(record);
    return;
  }
  if (process.env['VERIFICATION_LEASE_TOKEN'] !== record.token) {
    throw new Error(`VERIFICATION_LEASE_BUSY: ${record.command} is active in PID ${record.pid}`);
  }
}
