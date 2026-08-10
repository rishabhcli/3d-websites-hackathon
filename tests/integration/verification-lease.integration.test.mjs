import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT, TMP_ROOT } from '../../scripts/lib/dev-contract.mjs';
import { spawnOwnedProcess, waitForOwnedProcess } from '../../scripts/lib/owned-child-process.mjs';
import {
  acquireVerificationLease,
  releaseVerificationLease,
} from '../../scripts/lib/verification-lease.mjs';

describe('whole-verification lease', () => {
  it('allows the exact inherited token and rejects a concurrent same-repository borrower', async () => {
    const lease = await acquireVerificationLease('verification lease integration test');
    try {
      const nested = await acquireVerificationLease('nested verification operation');
      expect(nested.owned).toBe(false);
      await releaseVerificationLease(nested);

      const environment = {
        ...process.env,
        TMPDIR: TMP_ROOT,
        TMP: TMP_ROOT,
        TEMP: TMP_ROOT,
      };
      delete environment['VERIFICATION_LEASE_TOKEN'];
      const moduleUrl = pathToFileURL(
        path.join(REPOSITORY_ROOT, 'scripts', 'lib', 'verification-lease.mjs'),
      ).href;
      const program = [
        `import { acquireVerificationLease } from ${JSON.stringify(moduleUrl)};`,
        "try { await acquireVerificationLease('concurrent rival'); process.stdout.write('unexpected'); }",
        'catch (error) { process.stdout.write(error instanceof Error ? error.message : String(error)); }',
      ].join(' ');
      const rival = spawnOwnedProcess(process.execPath, ['--input-type=module', '-e', program], {
        cwd: REPOSITORY_ROOT,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      rival.child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      rival.child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      const result = await waitForOwnedProcess(rival, { timeoutMs: 10_000 });
      expect(result).toMatchObject({ exitCode: 0, signal: null, leakedDescendants: false });
      expect(stderr).toBe('');
      expect(stdout).toMatch(/VERIFICATION_LEASE_BUSY/u);
    } finally {
      await releaseVerificationLease(lease);
    }
  });
});
