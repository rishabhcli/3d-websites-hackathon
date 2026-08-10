import { inspectService, loadServices, readHealth } from './lib/dev-contract.mjs';

export default async function globalSetup() {
  const required = new Set(['projection-harness', 'vite-preview']);
  for (const service of await loadServices()) {
    if (!required.has(service.id)) continue;
    const inspection = await inspectService(service, { requireHealth: false });
    if (inspection.state !== 'owned') {
      throw new Error(
        `Playwright refuses unowned ${service.id} port ${service.port} (${inspection.state})`,
      );
    }
    const health = await readHealth(service, inspection.record);
    if (!health.ok) throw new Error(`Playwright ${service.id} is not ready: ${health.reason}`);
    required.delete(service.id);
  }
  if (required.size > 0) {
    throw new Error(`${[...required].sort().join(', ')} absent from ports.env`);
  }
}
