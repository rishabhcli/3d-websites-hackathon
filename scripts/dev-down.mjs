import {
  inspectService,
  isPidAlive,
  loadServices,
  readRecord,
  removeRecord,
  validateRecordProcess,
  waitForExit,
  withLifecycleLock,
} from './lib/dev-contract.mjs';
import { assertVerificationLeaseAccess } from './lib/verification-lease.mjs';

export async function stopOwnedService(service, { emit = true, expectedRunId = null } = {}) {
  const record = await readRecord(service);
  if (!record) {
    if (emit) console.log(`dev:down ${service.id}: already stopped`);
    return { status: 'already-stopped' };
  }
  if (expectedRunId !== null && record.runId !== expectedRunId) {
    if (emit) {
      console.log(
        `dev:down ${service.id}: preserved newer owned run ${record.runId}; expected ${expectedRunId}`,
      );
    }
    return { status: 'preserved-newer-run', runId: record.runId };
  }
  if (!isPidAlive(record.pid)) {
    await removeRecord(service.id);
    if (emit) console.log(`dev:down ${service.id}: removed dead record`);
    return { status: 'removed-dead-record' };
  }

  const ownership = validateRecordProcess(record, { requireListener: false });
  if (!ownership.ok) {
    throw new Error(`Refusing to signal PID ${record.pid} for ${service.id}: ${ownership.reason}`);
  }

  process.kill(record.pid, 'SIGTERM');
  if (!(await waitForExit(record.pid, 5_000))) {
    const revalidated = validateRecordProcess(record, { requireListener: false });
    if (!revalidated.ok) {
      throw new Error(
        `Refusing SIGKILL after ownership changed for ${service.id}: ${revalidated.reason}`,
      );
    }
    process.kill(record.pid, 'SIGKILL');
    if (!(await waitForExit(record.pid, 2_000))) {
      throw new Error(`${service.id} PID ${record.pid} did not exit after validated SIGKILL`);
    }
  }
  await removeRecord(service.id);
  if (emit) console.log(`dev:down stopped ${service.id} PID ${record.pid}`);
  return { status: 'stopped', runId: record.runId };
}

export async function runDown({ emit = true, only = null, expectedRunIds = null } = {}) {
  await assertVerificationLeaseAccess();
  return withLifecycleLock(async () => {
    await assertVerificationLeaseAccess();
    const services = await loadServices();
    const selected = only ? services.filter((service) => only.has(service.id)) : services;
    const failures = [];
    const stoppedOrAbsent = new Set();
    for (const service of [...selected].reverse()) {
      try {
        const result = await stopOwnedService(service, {
          emit,
          expectedRunId: expectedRunIds?.get(service.id) ?? null,
        });
        if (result.status !== 'preserved-newer-run') stoppedOrAbsent.add(service.id);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) throw new Error(`dev:down failed closed:\n- ${failures.join('\n- ')}`);

    for (const service of selected.filter(({ id }) => stoppedOrAbsent.has(id))) {
      const inspection = await inspectService(service, { requireHealth: false });
      if (inspection.state !== 'free') {
        throw new Error(
          `${service.id} port ${service.port} remains ${inspection.state}; no foreign process was signalled`,
        );
      }
    }
    if (emit) console.log('dev:down ok — owned services stopped; no discovery-based kills used');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDown().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
