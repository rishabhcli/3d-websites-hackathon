import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  chmod,
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildInputDigest, readBuildIntegrityStamp } from './build-integrity.mjs';
import { validateEvidenceManifest } from './evidence-integrity.mjs';

export const PROJECT_NAME = '3d-websites-hackathon';
export const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEV_ROOT = path.join(REPOSITORY_ROOT, '.dev');
export const PID_ROOT = path.join(DEV_ROOT, 'pids');
export const LOG_ROOT = path.join(DEV_ROOT, 'logs');
export const TMP_ROOT = path.join(DEV_ROOT, 'tmp');
export const CACHE_ROOT = path.join(DEV_ROOT, 'cache');
export const PROFILE_ROOT = path.join(DEV_ROOT, 'pw-profile');
export const REPORT_ROOT = path.join(DEV_ROOT, 'reports');
export const LOCK_PATH = path.join(DEV_ROOT, 'lifecycle.lock');
export const PORT_RANGE = Object.freeze(Array.from({ length: 10 }, (_, index) => 4100 + index));

const serviceDefinitions = Object.freeze([
  { key: 'PORT_0', id: 'vite-dev', kind: 'vite-dev' },
  { key: 'PORT_1', id: 'vite-preview', kind: 'vite-preview' },
  { key: 'PORT_2', id: 'projection-harness', kind: 'vite-dev' },
  { key: 'PORT_3', id: 'evidence-server', kind: 'evidence' },
]);

function parsePortLine(line, lineNumber) {
  const withoutComment = line.split('#', 1)[0]?.trim() ?? '';
  if (withoutComment.length === 0) return null;
  const match = /^(PORT_[0-3])\s*=\s*(\d+)\s*$/.exec(withoutComment);
  if (!match) {
    throw new Error(`ports.env:${lineNumber}: expected PORT_n=<integer>`);
  }
  return { key: match[1], port: Number(match[2]) };
}

export function parsePortConfiguration(source) {
  const entries = source
    .split(/\r?\n/u)
    .map((line, index) => parsePortLine(line, index + 1))
    .filter((entry) => entry !== null);
  const ports = new Map(entries.map((entry) => [entry.key, entry.port]));
  const expectedKeys = serviceDefinitions.map(({ key }) => key);

  if (
    entries.length !== expectedKeys.length ||
    ports.size !== expectedKeys.length ||
    expectedKeys.some((key) => !ports.has(key))
  ) {
    throw new Error('ports.env must declare PORT_0 through PORT_3 exactly once');
  }

  const values = [...ports.values()];
  if (new Set(values).size !== values.length) {
    throw new Error('ports.env contains duplicate allocated ports');
  }
  for (const port of values) {
    if (!Number.isInteger(port) || !PORT_RANGE.includes(port)) {
      throw new Error(`Allocated port ${port} is outside the exclusive 4100-4109 block`);
    }
  }

  return serviceDefinitions.map((definition) => ({
    ...definition,
    port: ports.get(definition.key),
  }));
}

export async function loadServices() {
  const source = await readFile(path.join(REPOSITORY_ROOT, 'ports.env'), 'utf8');
  return parsePortConfiguration(source);
}

export async function ensureDevDirectories() {
  const repositoryRealPath = await realpath(REPOSITORY_ROOT);
  for (const directory of [
    DEV_ROOT,
    PID_ROOT,
    LOG_ROOT,
    TMP_ROOT,
    CACHE_ROOT,
    PROFILE_ROOT,
    REPORT_ROOT,
  ]) {
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`${directory} must be a real directory, not a symlink or file`);
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
        throw error;
      await mkdir(directory, { recursive: false, mode: 0o700 });
    }
    await chmod(directory, 0o700);
    const resolved = await realpath(directory);
    if (!resolved.startsWith(`${repositoryRealPath}${path.sep}`)) {
      throw new Error(`${directory} resolves outside this repository`);
    }
  }
}

export function recordPath(serviceId) {
  return path.join(PID_ROOT, `${serviceId}.json`);
}

export function pidPath(serviceId) {
  return path.join(PID_ROOT, `${serviceId}.pid`);
}

export async function writeJsonAtomic(destination, value) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function writeServiceRecord(service, record) {
  await writeJsonAtomic(recordPath(service.id), record);
  await writePidSidecarAtomic(service.id, record.pid);
}

async function writePidSidecarAtomic(serviceId, pid) {
  const temporary = `${pidPath(serviceId)}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${pid}\n`, { mode: 0o600 });
  await rename(temporary, pidPath(serviceId));
}

export async function readRecord(service) {
  let raw;
  let handle;
  try {
    const pathname = recordPath(service.id);
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const linked = await lstat(pathname);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      linked.nlink !== 1 ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new Error('ownership JSON is not one stable regular repository file');
    }
    raw = await handle.readFile({ encoding: 'utf8' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      // The JSON record is the sole authority. A sidecar without it cannot
      // authorize a signal and is safe to discard.
      await rm(pidPath(service.id), { force: true });
      return null;
    }
    throw new Error(`Unsafe ownership record for ${service.id}: ${String(error)}`);
  } finally {
    if (handle) await handle.close();
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isOwnershipRecord(parsed, service, null)) {
      throw new Error('record schema or repository identity does not match');
    }
    let sidecarMatches = false;
    try {
      const metadata = await lstat(pidPath(service.id));
      if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1) {
        const rawPid = await readFile(pidPath(service.id), 'utf8');
        sidecarMatches = Number(rawPid.trim()) === parsed.pid;
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (!sidecarMatches) await writePidSidecarAtomic(service.id, parsed.pid);
    return parsed;
  } catch (error) {
    throw new Error(`Unsafe ownership record for ${service.id}: ${String(error)}`);
  }
}

export function isOwnershipRecord(parsed, service, rawPid) {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    parsed.schemaVersion === 1 &&
    parsed.project === PROJECT_NAME &&
    parsed.repositoryRoot === REPOSITORY_ROOT &&
    parsed.service === service.id &&
    parsed.host === '127.0.0.1' &&
    parsed.port === service.port &&
    Number.isSafeInteger(parsed.pid) &&
    parsed.pid > 1 &&
    (rawPid === null || Number(rawPid.trim()) === parsed.pid) &&
    typeof parsed.runId === 'string' &&
    parsed.runId.length >= 8 &&
    typeof parsed.commandMarker === 'string' &&
    parsed.commandMarker.length > 0 &&
    typeof parsed.processStartedAt === 'string' &&
    parsed.processStartedAt.length > 0
  );
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function execText(command, arguments_, { allowAbsent = false, allowEmpty = false } = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (
    allowAbsent &&
    result.status === 1 &&
    result.signal === null &&
    result.stdout === '' &&
    result.stderr === ''
  ) {
    return '';
  }
  const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (
    !result.error &&
    result.signal === null &&
    result.status === 0 &&
    result.stderr === '' &&
    (allowEmpty || output.length > 0)
  ) {
    return output;
  }
  const detail = result.error
    ? result.error.message
    : result.stderr ||
      `exit ${String(result.status)}${result.signal ? ` signal ${result.signal}` : ''}`;
  throw new Error(`${command} inspection failed: ${detail}`);
}

export function processCommand(pid) {
  return execText('ps', ['-p', String(pid), '-o', 'command='], { allowAbsent: true });
}

export function processStartedAt(pid) {
  return execText('ps', ['-p', String(pid), '-o', 'lstart='], { allowAbsent: true });
}

export function processWorkingDirectory(pid) {
  const output = execText('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    allowAbsent: true,
  });
  const pathname = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith('n'))
    ?.slice(1);
  return pathname ? path.resolve(pathname) : '';
}

export function parseLsofListeners(output) {
  if (typeof output !== 'string' || output.length === 0) {
    throw new Error(
      'lsof listener inspection returned no parseable output after a successful exit',
    );
  }
  const details = [];
  let pid = null;
  let command = '';
  let sawFileDescriptor = false;
  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      if (!/^\d+$/u.test(value)) throw new Error(`lsof returned an invalid PID field: ${line}`);
      pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error(`lsof returned an unsafe PID field: ${line}`);
      }
      command = '';
      sawFileDescriptor = false;
    } else if (field === 'c') {
      if (!Number.isSafeInteger(pid) || pid <= 1 || value.length === 0) {
        throw new Error(`lsof returned a command field without a valid process: ${line}`);
      }
      command = value;
    } else if (field === 'f') {
      if (!Number.isSafeInteger(pid) || pid <= 1 || value.length === 0) {
        throw new Error(`lsof returned a file field without a valid process: ${line}`);
      }
      sawFileDescriptor = true;
    } else if (field === 'n') {
      if (!Number.isSafeInteger(pid) || pid <= 1 || command.length === 0 || value.length === 0) {
        throw new Error(`lsof returned a listener field without valid process context: ${line}`);
      }
      details.push({ pid, command, address: value });
      sawFileDescriptor = false;
    } else {
      throw new Error(`lsof returned an unexpected field: ${line}`);
    }
  }
  if (details.length === 0) {
    throw new Error(
      `lsof listener inspection returned no listener records${sawFileDescriptor ? ' after a file descriptor' : ''}`,
    );
  }
  return details;
}

export function interpretLsofListenerResult({ status, signal, error, stdout, stderr }) {
  const standardOutput = typeof stdout === 'string' ? stdout : '';
  const standardError = typeof stderr === 'string' ? stderr : '';
  if (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `lsof listener inspection could not execute${code ? ` (${code})` : ''}: ${message}`,
    );
  }
  if (signal !== null) {
    throw new Error(`lsof listener inspection terminated by signal ${signal ?? '<unknown>'}`);
  }
  if (status === 1 && standardOutput.length === 0 && standardError.length === 0) {
    return [];
  }
  if (status !== 0) {
    throw new Error(
      `lsof listener inspection failed with exit ${String(status)}${standardError ? `: ${standardError.trim()}` : ''}`,
    );
  }
  if (standardError.length > 0) {
    throw new Error(`lsof listener inspection emitted diagnostics: ${standardError.trim()}`);
  }
  return parseLsofListeners(standardOutput);
}

export function listenerDetails(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Cannot inspect invalid TCP port ${String(port)}`);
  }
  const result = spawnSync('lsof', ['-nP', '-Fpcn', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return interpretLsofListenerResult(result);
}

export function listenerPids(port) {
  return new Set(listenerDetails(port).map(({ pid }) => pid));
}

export function validateRecordProcess(record, { requireListener = true } = {}) {
  if (!isPidAlive(record.pid)) {
    return { ok: false, reason: 'recorded PID is not alive' };
  }
  const command = processCommand(record.pid);
  if (!command.includes(record.commandMarker) || !command.includes(record.runId)) {
    return { ok: false, reason: `PID command fingerprint differs: ${command || '<unreadable>'}` };
  }
  const startedAt = processStartedAt(record.pid);
  if (startedAt !== record.processStartedAt) {
    return { ok: false, reason: 'PID start time differs; possible PID reuse' };
  }
  const cwd = processWorkingDirectory(record.pid);
  if (cwd !== REPOSITORY_ROOT) {
    return { ok: false, reason: `PID cwd differs: ${cwd || '<unreadable>'}` };
  }
  if (requireListener) {
    const listeners = listenerDetails(record.port);
    if (
      listeners.length === 0 ||
      listeners.some(
        (listener) =>
          listener.pid !== record.pid || listener.address !== `127.0.0.1:${record.port}`,
      )
    ) {
      return {
        ok: false,
        reason: `listener identity/address differs: ${listeners.map(({ pid, address }) => `${pid}@${address}`).join(', ') || '<none>'}`,
      };
    }
  }
  return { ok: true, reason: 'owned process fingerprint matches' };
}

async function expectedArtifactDigest(service) {
  const relativeFiles =
    service.kind === 'vite-preview'
      ? ['dist/.vite/manifest.json', 'dist/build-integrity.json']
      : service.kind === 'evidence'
        ? ['evidence/tier0/manifest.json']
        : ['index.html', 'package.json'];
  const digest = createHash('sha256');
  for (const relativeFile of relativeFiles) {
    digest.update(await readFile(path.join(REPOSITORY_ROOT, relativeFile)));
  }
  return digest.digest('hex');
}

async function probeServedArtifact(service, signal) {
  const baseUrl = `http://127.0.0.1:${service.port}`;
  const rootResponse = await fetch(`${baseUrl}/`, {
    cache: 'no-store',
    signal,
  });
  const rootBody = await rootResponse.text();
  if (!rootResponse.ok || !rootBody.includes('data-project="3d-websites-hackathon"')) {
    return { ok: false, reason: 'served root does not contain the repository application marker' };
  }

  if (service.kind === 'evidence') {
    const manifestResponse = await fetch(`${baseUrl}/tier0/manifest.json`, {
      cache: 'no-store',
      signal,
    });
    if (
      !manifestResponse.ok ||
      !manifestResponse.headers.get('content-type')?.startsWith('application/json')
    ) {
      return { ok: false, reason: 'evidence manifest is not readable JSON' };
    }
    const manifest = await manifestResponse.json();
    return manifest.schemaVersion === 1 && manifest.project === PROJECT_NAME
      ? { ok: true }
      : { ok: false, reason: 'evidence manifest identity is invalid' };
  }

  const assetPath =
    service.kind === 'vite-preview'
      ? /<script[^>]+src="([^"]+)"/u.exec(rootBody)?.[1]
      : '/src/main.tsx';
  if (!assetPath)
    return { ok: false, reason: 'served application does not reference an entry asset' };
  const assetResponse = await fetch(new URL(assetPath, `${baseUrl}/`), {
    cache: 'no-store',
    signal,
  });
  const assetBody = await assetResponse.text();
  if (
    !assetResponse.ok ||
    !assetResponse.headers.get('content-type')?.includes('javascript') ||
    assetBody.length === 0
  ) {
    return { ok: false, reason: 'served application entry asset is unreadable' };
  }
  return { ok: true };
}

export async function readHealth(service, record, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/readyz`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: `readiness returned HTTP ${response.status}` };
    }
    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      return { ok: false, reason: 'readiness did not return JSON' };
    }
    const body = await response.json();
    const expected = {
      schemaVersion: 1,
      project: PROJECT_NAME,
      service: service.id,
      host: '127.0.0.1',
      port: service.port,
      pid: record.pid,
      runId: record.runId,
      status: 'ready',
    };
    for (const [key, value] of Object.entries(expected)) {
      if (body[key] !== value) {
        return { ok: false, reason: `readiness identity mismatch at ${key}` };
      }
    }
    if (typeof body.artifactDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(body.artifactDigest)) {
      return { ok: false, reason: 'readiness artifact digest is missing or malformed' };
    }
    if (service.kind === 'vite-preview') {
      const stamp = await readBuildIntegrityStamp(REPOSITORY_ROOT);
      if (stamp.inputDigest !== (await computeBuildInputDigest(REPOSITORY_ROOT))) {
        return { ok: false, reason: 'preview was built from stale source or dependency inputs' };
      }
    }
    if (service.kind === 'evidence') await validateEvidenceManifest(REPOSITORY_ROOT);
    if (body.artifactDigest !== (await expectedArtifactDigest(service))) {
      return { ok: false, reason: 'readiness describes a stale local build artifact' };
    }
    const artifactProbe = await probeServedArtifact(service, controller.signal);
    if (!artifactProbe.ok) return artifactProbe;
    return { ok: true, body };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectService(service, { requireHealth = true } = {}) {
  const record = await readRecord(service);
  const listeners = listenerDetails(service.port);
  if (listeners.length === 0) {
    if (!record) return { state: 'free', service };
    if (!isPidAlive(record.pid)) {
      return { state: 'stale-record', service, record };
    }
    return {
      state: 'unsafe-record',
      service,
      record,
      reason: 'recorded process is alive but allocated port is not listening',
    };
  }
  if (!record) {
    return {
      state: 'foreign-listener',
      service,
      reason: `listener(s): ${listeners.map(({ pid, address }) => `${pid}@${address}`).join(', ') || 'unavailable'}`,
    };
  }
  const ownership = validateRecordProcess(record);
  if (!ownership.ok) {
    return { state: 'foreign-listener', service, record, reason: ownership.reason };
  }
  if (!requireHealth) return { state: 'owned', service, record };
  const health = await readHealth(service, record);
  return health.ok
    ? { state: 'healthy-owned', service, record, health: health.body }
    : { state: 'unhealthy-owned', service, record, reason: health.reason };
}

export async function assertGitIgnored() {
  const sentinel = path.join(DEV_ROOT, 'ignore-check');
  await writeFile(sentinel, 'ignored\n');
  const relative = path.relative(REPOSITORY_ROOT, sentinel);
  try {
    const provenance = execText('git', ['check-ignore', '-v', '--', relative]);
    if (!provenance.startsWith('.gitignore:') && !provenance.includes('/.gitignore:')) {
      throw new Error(`.dev ignore rule is not repository-local: ${provenance}`);
    }
    const tracked = execText('git', ['ls-files', '--', '.dev'], { allowEmpty: true });
    if (tracked.length > 0) throw new Error(`.dev contains tracked files: ${tracked}`);
  } catch {
    throw new Error('.dev/ is not ignored by Git');
  } finally {
    await rm(sentinel, { force: true });
  }
}

export async function assertRepositoryFiles() {
  for (const relative of ['package.json', 'pnpm-lock.yaml', 'ports.env', '.gitignore']) {
    await access(path.join(REPOSITORY_ROOT, relative), constants.R_OK);
  }
}

export async function removeRecord(serviceId) {
  await Promise.all([
    rm(recordPath(serviceId), { force: true }),
    rm(pidPath(serviceId), { force: true }),
  ]);
}

async function acquireLifecycleLock() {
  await ensureDevDirectories();
  const ownerStartedAt = processStartedAt(process.pid);
  if (ownerStartedAt.length === 0) {
    throw new Error('Development lifecycle lock owner fingerprint is unavailable');
  }
  const lockRecord = `${JSON.stringify({
    schemaVersion: 1,
    project: PROJECT_NAME,
    repositoryRoot: REPOSITORY_ROOT,
    pid: process.pid,
    processStartedAt: ownerStartedAt,
    createdAt: new Date().toISOString(),
  })}\n`;
  const temporaryLockPath = `${LOCK_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const temporaryHandle = await open(temporaryLockPath, 'wx', 0o600);
    try {
      await temporaryHandle.writeFile(lockRecord);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await link(temporaryLockPath, LOCK_PATH);
    await rm(temporaryLockPath, { force: true });
    return open(LOCK_PATH, 'r');
  } catch (error) {
    await rm(temporaryLockPath, { force: true });
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
    let holderPid = 0;
    let holderStartedAt = '';
    let parsedLock = false;
    try {
      const metadata = await lstat(LOCK_PATH);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('unsafe lifecycle lock path');
      }
      const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
      if (
        !lock ||
        typeof lock !== 'object' ||
        lock.schemaVersion !== 1 ||
        lock.project !== PROJECT_NAME ||
        lock.repositoryRoot !== REPOSITORY_ROOT ||
        !Number.isSafeInteger(lock.pid) ||
        lock.pid <= 1 ||
        typeof lock.processStartedAt !== 'string' ||
        lock.processStartedAt.length === 0 ||
        typeof lock.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(lock.createdAt))
      ) {
        throw new Error('invalid lifecycle lock schema');
      }
      holderPid = lock.pid;
      holderStartedAt = lock.processStartedAt;
      parsedLock = true;
    } catch {
      // A concurrent writer may not have flushed the lock body yet. Fail closed instead of deleting it.
    }
    if (!parsedLock)
      throw new Error('Development lifecycle lock exists but its owner cannot be proven');
    if (Number.isSafeInteger(holderPid) && holderPid > 1 && isPidAlive(holderPid)) {
      const observedStartedAt = processStartedAt(holderPid);
      if (holderStartedAt.length > 0 && observedStartedAt === holderStartedAt) {
        throw new Error(`Development lifecycle is already being changed by PID ${holderPid}`);
      }
      if (observedStartedAt.length === 0 && isPidAlive(holderPid)) {
        throw new Error('Development lifecycle lock exists but PID state cannot be proven stale');
      }
    }
    await rm(LOCK_PATH, { force: true });
    return acquireLifecycleLock();
  }
}

export async function withLifecycleLock(operation) {
  const handle = await acquireLifecycleLock();
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(LOCK_PATH, { force: true });
  }
}

export async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

export async function waitForHealthy(service, record, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'service did not answer';
  while (Date.now() < deadline) {
    const ownership = validateRecordProcess(record, { requireListener: false });
    if (!ownership.ok) throw new Error(`${service.id}: ${ownership.reason}`);
    const health = await readHealth(service, record);
    if (health.ok) return health.body;
    lastReason = health.reason;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${service.id} was not ready within ${timeoutMs}ms: ${lastReason}`);
}

export function createRunId() {
  return randomUUID();
}

export async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
