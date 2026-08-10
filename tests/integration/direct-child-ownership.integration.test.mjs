import process from 'node:process';
import { describe, expect, it } from 'vitest';

import {
  releaseDirectOwnedChild,
  spawnDirectOwnedChild,
  terminateDirectOwnedChild,
  waitForDirectOwnedChildSpawn,
} from '../../scripts/lib/direct-child-ownership.mjs';

describe('direct service-child ownership', () => {
  it('refuses a forged child-shaped value', () => {
    expect(() => terminateDirectOwnedChild({ child: process })).toThrow(
      /DIRECT_CHILD_OWNERSHIP_REQUIRED/u,
    );
  });

  it('cleans the exact spawned child without requiring a ps fingerprint', async () => {
    const owned = spawnDirectOwnedChild(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await waitForDirectOwnedChildSpawn(owned);
    await new Promise((resolve) => owned.child.stdout.once('data', resolve));

    await terminateDirectOwnedChild(owned, { graceMs: 50, killGraceMs: 2_000 });
    expect(owned.child.signalCode).toBe('SIGKILL');
    releaseDirectOwnedChild(owned);
    expect(() => terminateDirectOwnedChild(owned)).toThrow(/DIRECT_CHILD_OWNERSHIP_REQUIRED/u);
  });

  it('refuses a mismatched persisted fingerprint while the child remains live', async () => {
    const owned = spawnDirectOwnedChild(
      process.execPath,
      ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await waitForDirectOwnedChildSpawn(owned);
    await new Promise((resolve) => owned.child.stdout.once('data', resolve));

    await expect(
      terminateDirectOwnedChild(owned, { expectedStartedAt: 'not-the-child-start-time' }),
    ).rejects.toThrow(/DIRECT_CHILD_IDENTITY_CHANGED/u);
    expect(owned.child.exitCode).toBeNull();

    await terminateDirectOwnedChild(owned);
    releaseDirectOwnedChild(owned);
  });
});
