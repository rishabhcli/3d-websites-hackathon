import {
  PORT_RANGE,
  assertGitIgnored,
  assertRepositoryFiles,
  ensureDevDirectories,
  inspectService,
  listenerDetails,
  loadServices,
  removeRecord,
} from './lib/dev-contract.mjs';

export async function runPreflight({ allowOwnedUnhealthy = false, emit = true } = {}) {
  await ensureDevDirectories();
  await assertRepositoryFiles();
  await assertGitIgnored();
  const services = await loadServices();
  const assigned = new Map(services.map((service) => [service.port, service]));
  const failures = [];

  for (const port of PORT_RANGE) {
    const service = assigned.get(port);
    if (!service) {
      const listeners = listenerDetails(port);
      if (listeners.length > 0) {
        failures.push(
          `reserved port ${port} is held by foreign listener(s) ${listeners.map(({ pid, address }) => `${pid}@${address}`).join(', ')}`,
        );
      }
      continue;
    }

    const inspection = await inspectService(service, { requireHealth: !allowOwnedUnhealthy });
    if (inspection.state === 'stale-record') {
      await removeRecord(service.id);
      if (emit) console.log(`preflight: removed dead ownership record for ${service.id}`);
      continue;
    }
    if (
      inspection.state === 'free' ||
      (allowOwnedUnhealthy && inspection.state === 'owned') ||
      inspection.state === 'healthy-owned' ||
      (allowOwnedUnhealthy && inspection.state === 'unhealthy-owned')
    ) {
      continue;
    }
    failures.push(
      `${service.id} on 127.0.0.1:${service.port} is ${inspection.state}: ${inspection.reason ?? 'ownership could not be proven'}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Development preflight failed closed:\n- ${failures.join('\n- ')}`);
  }
  if (emit) {
    console.log(
      allowOwnedUnhealthy
        ? 'dev:preflight ok — ports 4100-4109 are free or held by exact owned services eligible for health repair'
        : 'dev:preflight ok — ports 4100-4109 are free or held by healthy owned services',
    );
  }
  return services;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPreflight().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
