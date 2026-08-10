import { describe, expect, it } from 'vitest';
import { assertRequiredHostTools } from '../../scripts/bootstrap.mjs';

const pid = 4_200;
const successfulResults = [
  { status: 0, signal: null, stdout: `p${pid}\nfcwd\nn/tmp/repository\n`, stderr: '' },
  { status: 1, signal: null, stdout: '', stderr: '' },
  { status: 0, signal: null, stdout: 'node scripts/bootstrap.mjs\n', stderr: '' },
  { status: 0, signal: null, stdout: 'Mon Aug 10 01:00:00 2026\n', stderr: '' },
  { status: 0, signal: null, stdout: '4000\n', stderr: '' },
  { status: 0, signal: null, stdout: `  ${pid}   4000 S+\n`, stderr: '' },
];

function scriptedExecution(overrides = new Map()) {
  const calls = [];
  const execute = (command, arguments_, options) => {
    const index = calls.length;
    calls.push({ command, arguments_, options });
    return overrides.get(index) ?? successfulResults[index];
  };
  return { calls, execute };
}

describe('bootstrap host-tool gate', () => {
  it('accepts the exact lsof and ps query shapes used by lifecycle ownership checks', () => {
    const { calls, execute } = scriptedExecution();

    expect(() => assertRequiredHostTools({ execute, platform: 'linux', pid })).not.toThrow();
    expect(calls.map(({ command, arguments_ }) => [command, arguments_])).toEqual([
      ['lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']],
      ['lsof', ['-nP', '-Fpcn', '-iTCP:65535', '-sTCP:LISTEN']],
      ['ps', ['-p', String(pid), '-o', 'command=']],
      ['ps', ['-p', String(pid), '-o', 'lstart=']],
      ['ps', ['-p', String(pid), '-o', 'pgid=']],
      ['ps', ['-e', '-o', 'pid=,pgid=,stat=']],
    ]);
    for (const { options } of calls) {
      expect(options).toMatchObject({ shell: false, timeout: 5_000, maxBuffer: 1024 * 1024 });
    }
  });

  it('reports a missing lsof executable with an install hint', () => {
    const missing = {
      status: null,
      signal: null,
      error: Object.assign(new Error('spawnSync lsof ENOENT'), { code: 'ENOENT' }),
      stdout: '',
      stderr: '',
    };
    const { execute } = scriptedExecution(new Map([[0, missing]]));

    expect(() => assertRequiredHostTools({ execute, platform: 'darwin', pid })).toThrow(
      /HOST_TOOL_MISSING: required executable "lsof".*install lsof/u,
    );
  });

  it('reports a missing ps executable with the Linux package name', () => {
    const missing = {
      status: null,
      signal: null,
      error: Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' }),
      stdout: '',
      stderr: '',
    };
    const { execute } = scriptedExecution(new Map([[2, missing]]));

    expect(() => assertRequiredHostTools({ execute, platform: 'linux', pid })).toThrow(
      /HOST_TOOL_MISSING: required executable "ps".*procps on Debian\/Ubuntu/u,
    );
  });

  it('fails closed when lsof emits diagnostics for a listener query', () => {
    const denied = { status: 1, signal: null, stdout: '', stderr: 'permission denied' };
    const { execute } = scriptedExecution(new Map([[1, denied]]));

    expect(() => assertRequiredHostTools({ execute, platform: 'linux', pid })).toThrow(
      /HOST_TOOL_UNUSABLE: executable "lsof" cannot inspect TCP listeners.*permission denied/u,
    );
  });

  it('fails closed when ps returns empty process metadata', () => {
    const empty = { status: 0, signal: null, stdout: '', stderr: '' };
    const { execute } = scriptedExecution(new Map([[3, empty]]));

    expect(() => assertRequiredHostTools({ execute, platform: 'linux', pid })).toThrow(
      /HOST_TOOL_UNUSABLE: executable "ps" returned unparseable output/u,
    );
  });

  it('rejects undeclared host operating systems before probing executables', () => {
    const { calls, execute } = scriptedExecution();

    expect(() => assertRequiredHostTools({ execute, platform: 'win32', pid })).toThrow(
      /HOST_PLATFORM_UNSUPPORTED: win32.*macOS or Linux/u,
    );
    expect(calls).toHaveLength(0);
  });

  it('proves the current supported host provides functional lifecycle tools', () => {
    expect(['darwin', 'linux']).toContain(process.platform);
    expect(() => assertRequiredHostTools()).not.toThrow();
  });
});
