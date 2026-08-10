import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TMP_ROOT, ensureDevDirectories } from './lib/dev-contract.mjs';
import { spawnOwnedProcess, waitForOwnedProcess } from './lib/owned-child-process.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const expectedNode = 'v24.19.0';
const expectedPnpm = packageJson.packageManager.replace('pnpm@', '');
const supportedPlatforms = new Set(['darwin', 'linux']);
const probeOptions = {
  cwd: root,
  encoding: 'utf8',
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 5_000,
  maxBuffer: 1024 * 1024,
};
const localEnvironment = { ...process.env, TMPDIR: TMP_ROOT, TMP: TMP_ROOT, TEMP: TMP_ROOT };

function probeText(value) {
  return typeof value === 'string' ? value : '';
}

function diagnosticSuffix(result) {
  const standardError = probeText(result.stderr).trim();
  return standardError.length > 0 ? `: ${standardError}` : '';
}

function assertProbeStarted(tool, result) {
  if (result.error) {
    const code =
      typeof result.error === 'object' && result.error !== null && 'code' in result.error
        ? String(result.error.code)
        : '';
    if (code === 'ENOENT') {
      const packageHint = tool === 'ps' ? 'procps on Debian/Ubuntu' : 'lsof';
      throw new Error(
        `HOST_TOOL_MISSING: required executable "${tool}" is not available on PATH; install ${packageHint}`,
      );
    }
    throw new Error(
      `HOST_TOOL_UNUSABLE: executable "${tool}" could not run${code ? ` (${code})` : ''}`,
    );
  }
  if (result.signal !== null) {
    throw new Error(
      `HOST_TOOL_UNUSABLE: executable "${tool}" terminated by signal ${result.signal ?? '<unknown>'}`,
    );
  }
}

function assertSuccessfulProbe(tool, purpose, result, outputIsValid) {
  assertProbeStarted(tool, result);
  if (result.status !== 0) {
    throw new Error(
      `HOST_TOOL_UNUSABLE: executable "${tool}" cannot ${purpose} (exit ${String(result.status)})${diagnosticSuffix(result)}`,
    );
  }
  if (probeText(result.stderr).length > 0) {
    throw new Error(
      `HOST_TOOL_UNUSABLE: executable "${tool}" emitted diagnostics while attempting to ${purpose}${diagnosticSuffix(result)}`,
    );
  }
  if (!outputIsValid(probeText(result.stdout))) {
    throw new Error(
      `HOST_TOOL_UNUSABLE: executable "${tool}" returned unparseable output while attempting to ${purpose}`,
    );
  }
}

function assertListenerProbe(result) {
  assertProbeStarted('lsof', result);
  const standardOutput = probeText(result.stdout);
  const standardError = probeText(result.stderr);
  if (result.status === 1 && standardOutput.length === 0 && standardError.length === 0) return;
  if (result.status !== 0) {
    throw new Error(
      `HOST_TOOL_UNUSABLE: executable "lsof" cannot inspect TCP listeners (exit ${String(result.status)})${diagnosticSuffix(result)}`,
    );
  }
  if (standardError.length > 0) {
    throw new Error(
      `HOST_TOOL_UNUSABLE: executable "lsof" emitted diagnostics while attempting to inspect TCP listeners${diagnosticSuffix(result)}`,
    );
  }
  if (
    !/^p\d+$/mu.test(standardOutput) ||
    !/^c.+$/mu.test(standardOutput) ||
    !/^n.+$/mu.test(standardOutput)
  ) {
    throw new Error('HOST_TOOL_UNUSABLE: executable "lsof" returned unparseable listener output');
  }
}

export function assertRequiredHostTools({
  execute = spawnSync,
  platform = process.platform,
  pid = process.pid,
} = {}) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(
      `HOST_PLATFORM_UNSUPPORTED: ${platform} is not supported; use a macOS or Linux host`,
    );
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`HOST_PROBE_INVALID_PID: cannot probe host tools with PID ${String(pid)}`);
  }

  const lsofCwd = execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], probeOptions);
  assertSuccessfulProbe(
    'lsof',
    'inspect process working directories',
    lsofCwd,
    (output) =>
      output.split(/\r?\n/u).includes(`p${pid}`) &&
      /^fcwd$/mu.test(output) &&
      /^n\//mu.test(output),
  );

  const lsofListeners = execute(
    'lsof',
    ['-nP', '-Fpcn', '-iTCP:65535', '-sTCP:LISTEN'],
    probeOptions,
  );
  assertListenerProbe(lsofListeners);

  const psCommand = execute('ps', ['-p', String(pid), '-o', 'command='], probeOptions);
  assertSuccessfulProbe(
    'ps',
    'read process command lines',
    psCommand,
    (output) => output.trim().length > 0,
  );

  const psStartedAt = execute('ps', ['-p', String(pid), '-o', 'lstart='], probeOptions);
  assertSuccessfulProbe(
    'ps',
    'read process start times',
    psStartedAt,
    (output) => output.trim().length > 0,
  );

  const psGroupId = execute('ps', ['-p', String(pid), '-o', 'pgid='], probeOptions);
  assertSuccessfulProbe('ps', 'read process group identifiers', psGroupId, (output) =>
    /^\s*\d+\s*$/u.test(output),
  );
  const processGroupId = Number(probeText(psGroupId.stdout));
  const processListArguments =
    platform === 'linux'
      ? ['-e', '-o', 'pid=,pgid=,stat=']
      : ['-o', 'pid=,pgid=,stat=', '-g', String(processGroupId)];
  const psProcessGroups = execute('ps', processListArguments, probeOptions);
  assertSuccessfulProbe('ps', 'enumerate owned process groups', psProcessGroups, (output) =>
    output.split(/\r?\n/u).some((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
      return match !== null && Number(match[2]) === processGroupId;
    }),
  );
}

async function runBootstrapCommand(command, arguments_, label) {
  let stdout = '';
  let stderr = '';
  const owned = spawnOwnedProcess(command, arguments_, {
    cwd: root,
    env: localEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const result = await waitForOwnedProcess(owned, {
    timeoutMs: 15 * 60_000,
    timeoutTermination: { graceMs: 10_000, killGraceMs: 5_000 },
  });
  if (result.spawnError) throw new Error(`${label} could not start: ${result.spawnError}`);
  if (result.leakedDescendants) {
    throw new Error(`${label} leaked descendants; its exact group was terminated`);
  }
  if (result.signal || result.exitCode !== 0) {
    throw new Error(
      `${label} failed${result.signal ? ` from ${result.signal}` : ` with exit code ${String(result.exitCode)}`}`,
    );
  }
  if (stderr.trim().length > 0) {
    throw new Error(`${label} emitted stderr under the zero-warning contract`);
  }
  return stdout;
}

export async function runBootstrap() {
  assertRequiredHostTools();
  await ensureDevDirectories();

  if (process.version !== expectedNode) {
    throw new Error(
      `TOOLCHAIN_NODE_MISMATCH: expected ${expectedNode}, received ${process.version}`,
    );
  }
  const version = spawnSync('pnpm', ['--version'], probeOptions);
  if (
    version.status !== 0 ||
    probeText(version.stderr).length > 0 ||
    probeText(version.stdout).trim() !== expectedPnpm
  ) {
    throw new Error(
      `TOOLCHAIN_PNPM_MISMATCH: expected ${expectedPnpm}, received ${probeText(version.stdout).trim() || 'unavailable'}`,
    );
  }

  await runBootstrapCommand('pnpm', ['install', '--frozen-lockfile'], 'locked pnpm install');
  await runBootstrapCommand(
    process.execPath,
    ['scripts/run-playwright.mjs', 'install', 'chromium'],
    'Playwright Chromium install',
  );
  console.log(
    `bootstrap ok — ${process.platform} host with lsof/ps, Node ${process.version}, pnpm ${expectedPnpm}, locked dependencies and Chromium ready`,
  );
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await runBootstrap();
