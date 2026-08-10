import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDevDirectories, TMP_ROOT } from '../../scripts/lib/dev-contract.mjs';
import {
  ownedProcessGroupExists,
  spawnOwnedProcess,
  terminateOwnedProcess,
  waitForOwnedProcess,
} from '../../scripts/lib/owned-child-process.mjs';

describe('transient child ownership and cancellation', () => {
  it('refuses to signal an arbitrary process-shaped value', () => {
    expect(() => terminateOwnedProcess({ processGroupId: process.pid })).toThrow(
      /OWNED_PROCESS_REQUIRED/u,
    );
  });

  it('waits for both output pipes to close before reporting completion', async () => {
    const bytes = 128 * 1024;
    const owned = spawnOwnedProcess(
      process.execPath,
      [
        '-e',
        `process.stdout.write('o'.repeat(${bytes})); process.stderr.write('e'.repeat(${bytes}));`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdoutBytes = 0;
    let stderrBytes = 0;
    owned.child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
    });
    owned.child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength;
    });

    const result = await waitForOwnedProcess(owned);
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      spawnError: null,
      leakedDescendants: false,
    });
    expect(stdoutBytes).toBe(bytes);
    expect(stderrBytes).toBe(bytes);
    expect(ownedProcessGroupExists(owned)).toBe(false);
  });

  it('bounds cancellation and escalates only its exact ignoring process group', async () => {
    const parentProgram = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      'child.unref();',
      "process.stdout.write(String(child.pid) + '\\n');",
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const adjacent = spawnOwnedProcess(
      process.execPath,
      ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const adjacentReady = new Promise((resolve) => adjacent.child.stdout.once('data', resolve));
    await adjacentReady;

    const owned = spawnOwnedProcess(process.execPath, ['-e', parentProgram], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const firstLine = new Promise((resolve) => {
      let stdout = '';
      owned.child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('\n')) resolve(stdout.trim());
      });
    });
    const descendantPid = Number(await firstLine);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(descendantPid).toBeGreaterThan(1);

    try {
      const firstTermination = terminateOwnedProcess(owned, {
        graceMs: 50,
        killGraceMs: 2_000,
      });
      expect(terminateOwnedProcess(owned)).toBe(firstTermination);
      await firstTermination;
      const result = await waitForOwnedProcess(owned);
      expect(result.signal).toBe('SIGKILL');
      expect(ownedProcessGroupExists(owned)).toBe(false);
      expect(ownedProcessGroupExists(adjacent)).toBe(true);

      const descendant = spawnSync('ps', ['-p', String(descendantPid), '-o', 'stat='], {
        encoding: 'utf8',
        shell: false,
        timeout: 2_000,
      });
      expect(descendant.status === 1 || descendant.stdout.trim().startsWith('Z')).toBe(true);
    } finally {
      await terminateOwnedProcess(adjacent, { graceMs: 500, killGraceMs: 2_000 });
      await waitForOwnedProcess(adjacent);
    }
  }, 20_000);

  it('turns an absolute command deadline into bounded exact cleanup', async () => {
    const owned = spawnOwnedProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    await expect(
      waitForOwnedProcess(owned, {
        timeoutMs: 50,
        timeoutTermination: { graceMs: 50, killGraceMs: 2_000 },
      }),
    ).rejects.toThrow(/OWNED_PROCESS_TIMEOUT/u);
    expect(ownedProcessGroupExists(owned)).toBe(false);
  });

  it('keeps the guardian alive until descendants of a closed target are removed', async () => {
    const program = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      'child.unref();',
      "process.stdout.write(String(child.pid) + '\\n');",
    ].join(' ');
    const owned = spawnOwnedProcess(process.execPath, ['-e', program], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    owned.child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });

    const result = await waitForOwnedProcess(owned, {
      timeoutMs: 20_000,
      timeoutTermination: { graceMs: 50, killGraceMs: 2_000 },
    });
    const descendantPid = Number(output.trim());
    expect(result.leakedDescendants).toBe(true);
    expect(ownedProcessGroupExists(owned)).toBe(false);
    const descendant = spawnSync('ps', ['-p', String(descendantPid), '-o', 'stat='], {
      encoding: 'utf8',
      shell: false,
      timeout: 2_000,
    });
    expect(descendant.status === 1 || descendant.stdout.trim().startsWith('Z')).toBe(true);
  }, 40_000);

  it('reports a target spawn failure and releases its guardian', async () => {
    const owned = spawnOwnedProcess('/definitely/not/a/real/executable', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await waitForOwnedProcess(owned);
    expect(result.exitCode).not.toBe(0);
    expect(result.spawnError).toMatch(/ENOENT|not\/a\/real/u);
    expect(result.leakedDescendants).toBe(false);
    expect(ownedProcessGroupExists(owned)).toBe(false);
  });

  it('never starts the target when guardian fingerprinting fails', async () => {
    await ensureDevDirectories();
    const fixtureRoot = await mkdtemp(path.join(TMP_ROOT, 'guardian-fingerprint-'));
    const fakePs = path.join(fixtureRoot, 'ps');
    const targetMarker = path.join(fixtureRoot, 'target-started');
    await writeFile(fakePs, '#!/bin/sh\nexit 2\n', { mode: 0o700 });
    await chmod(fakePs, 0o700);

    const previousPath = process.env['PATH'];
    let owned;
    try {
      process.env['PATH'] = `${fixtureRoot}:${previousPath ?? ''}`;
      owned = spawnOwnedProcess(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(targetMarker)}, 'started')`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const result = await waitForOwnedProcess(owned, { timeoutMs: 5_000 });
      expect(result.spawnError).toMatch(/OWNED_PROCESS_FINGERPRINT_FAILED/u);
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
    }

    await expect(access(targetMarker)).rejects.toThrow();
    expect(ownedProcessGroupExists(owned)).toBe(false);
    await rm(fixtureRoot, { recursive: true, force: true });
  });
});
