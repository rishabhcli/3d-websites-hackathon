import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_ROOT,
  PROJECT_NAME,
  ensureDevDirectories,
  inspectService,
  listenerDetails,
  loadServices,
  readHealth,
  readRecord,
  recordPath,
  pidPath,
  removeRecord,
  writeJsonAtomic,
} from '../../scripts/lib/dev-contract.mjs';
import {
  computeBuildInputDigest,
  readBuildIntegrityStamp,
} from '../../scripts/lib/build-integrity.mjs';
import { validateEvidenceManifest } from '../../scripts/lib/evidence-integrity.mjs';
import { runPreflight } from '../../scripts/dev-preflight.mjs';
import { runUp } from '../../scripts/dev-up.mjs';

describe('repository development services', () => {
  it('owns four exact loopback listeners with identity-bound readiness', async () => {
    const services = await loadServices();
    expect(services).toHaveLength(4);

    for (const service of services) {
      const inspection = await inspectService(service, { requireHealth: false });
      expect(inspection.state).toBe('owned');
      const listeners = listenerDetails(service.port);
      expect(listeners).toEqual([
        expect.objectContaining({
          pid: inspection.record.pid,
          address: `127.0.0.1:${service.port}`,
        }),
      ]);
      const health = await readHealth(service, inspection.record);
      expect(health, `${service.id}: ${health.reason ?? 'no reason'}`).toMatchObject({ ok: true });
    }
  }, 30_000);

  it('keeps the same owned processes when up is repeated', async () => {
    const services = await loadServices();
    const before = new Map(
      await Promise.all(
        services.map(async (service) => {
          const record = await readRecord(service);
          return [service.id, { pid: record.pid, runId: record.runId }];
        }),
      ),
    );

    await runUp();

    for (const service of services) {
      const record = await readRecord(service);
      expect({ pid: record.pid, runId: record.runId }).toEqual(before.get(service.id));
    }
  }, 60_000);

  it('proves preview and evidence artifacts match their current inputs', async () => {
    const stamp = await readBuildIntegrityStamp(REPOSITORY_ROOT);
    expect(stamp.inputDigest).toBe(await computeBuildInputDigest(REPOSITORY_ROOT));
    const { manifest } = await validateEvidenceManifest(REPOSITORY_ROOT);
    expect(manifest.artifacts).toHaveLength(2);
  });

  it('keeps the evidence service read-only', async () => {
    const response = await fetch('http://127.0.0.1:4103/tier0/manifest.json', {
      method: 'POST',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    await expect(response.json()).resolves.toEqual({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and HEAD are supported' },
    });
  });

  it('recovers a PID sidecar crash from the atomic authoritative JSON record', async () => {
    await ensureDevDirectories();
    const service = { id: 'sidecar-crash-fixture', port: 4109 };
    const record = {
      schemaVersion: 1,
      project: PROJECT_NAME,
      repositoryRoot: REPOSITORY_ROOT,
      service: service.id,
      host: '127.0.0.1',
      port: service.port,
      pid: process.pid,
      runId: '00000000-0000-4000-8000-000000004109',
      commandMarker: 'sidecar-crash-fixture',
      processStartedAt: 'Sun Aug 10 00:00:00 2026',
    };
    await removeRecord(service.id);
    try {
      await writeJsonAtomic(recordPath(service.id), record);
      await expect(readRecord(service)).resolves.toEqual(record);
      await expect(readFile(pidPath(service.id), 'utf8')).resolves.toBe(`${process.pid}\n`);

      await writeFile(pidPath(service.id), '2\n', { mode: 0o600 });
      await expect(readRecord(service)).resolves.toEqual(record);
      await expect(readFile(pidPath(service.id), 'utf8')).resolves.toBe(`${process.pid}\n`);
    } finally {
      await removeRecord(service.id);
    }
  });

  it('fails closed on an unregistered reserved-port listener without stopping it', async () => {
    const fixture = createServer();
    await new Promise((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen({ host: '127.0.0.1', port: 4104, exclusive: true }, resolve);
    });
    try {
      await expect(runPreflight({ emit: false })).rejects.toThrow(/reserved port 4104/u);
      expect(fixture.listening).toBe(true);
    } finally {
      await new Promise((resolve, reject) =>
        fixture.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);
});
