import { inspectService, loadServices, readHealth } from './lib/dev-contract.mjs';

export async function runHealth({ emit = true, timeoutMs = 30_000 } = {}) {
  const services = await loadServices();
  const deadline = Date.now() + timeoutMs;
  const pending = new Map(
    services.map((service) => [service.id, { service, reason: 'not checked' }]),
  );

  while (pending.size > 0 && Date.now() < deadline) {
    await Promise.all(
      [...pending.values()].map(async ({ service }) => {
        const inspection = await inspectService(service, { requireHealth: false });
        if (inspection.state !== 'owned') {
          pending.set(service.id, {
            service,
            reason: `${inspection.state}: ${inspection.reason ?? 'ownership not established'}`,
          });
          return;
        }
        const health = await readHealth(service, inspection.record);
        if (!health.ok) {
          pending.set(service.id, { service, reason: health.reason });
          return;
        }
        pending.delete(service.id);
        if (emit)
          console.log(`dev:health ready ${service.id} http://127.0.0.1:${service.port}/readyz`);
      }),
    );
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (pending.size > 0) {
    const details = [...pending.values()]
      .map(({ service, reason }) => `${service.id} (${service.port}): ${reason}`)
      .join('\n- ');
    throw new Error(`dev:health failed after ${timeoutMs}ms:\n- ${details}`);
  }
  if (emit) console.log('dev:health ok — all four repository-owned services are ready');
  return services;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHealth().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
