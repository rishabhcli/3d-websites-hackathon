import { spawn } from 'node:child_process';
import process from 'node:process';

const payloadValue = process.env['CODEX_OWNED_COMMAND_PAYLOAD'];
const runId = process.env['CODEX_OWNED_COMMAND_RUN_ID'];
const runIdArgument = process.argv[2] === '--run-id' ? process.argv[3] : undefined;
if (!payloadValue || !runId || runIdArgument !== runId || !process.send) process.exit(125);

let payload;
try {
  payload = JSON.parse(Buffer.from(payloadValue, 'base64url').toString('utf8'));
} catch {
  process.exit(125);
}
if (
  !payload ||
  typeof payload !== 'object' ||
  typeof payload.command !== 'string' ||
  payload.command.length === 0 ||
  !Array.isArray(payload.arguments_) ||
  payload.arguments_.some((value) => typeof value !== 'string')
) {
  process.exit(125);
}

const targetEnvironment = { ...process.env };
delete targetEnvironment['CODEX_OWNED_COMMAND_PAYLOAD'];
delete targetEnvironment['CODEX_OWNED_COMMAND_RUN_ID'];

let target = null;
let targetSpawnError = null;
let targetClosed = false;
let forwardedSignal = null;
let escalationTimer = null;

function send(message) {
  if (!process.connected || !process.send) return;
  try {
    process.send({ ...message, runId });
  } catch {
    // The disconnect handler owns cleanup when the parent channel disappears.
  }
}

function forwardToExactGroup(signal) {
  if (forwardedSignal) return;
  forwardedSignal = signal;
  if (target === null) {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
      send({
        type: 'guardian-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  escalationTimer = setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      process.exit(137);
    }
  }, 60_000);
}

process.on('SIGINT', () => forwardToExactGroup('SIGINT'));
process.on('SIGTERM', () => forwardToExactGroup('SIGTERM'));
process.on('disconnect', () => {
  if (target === null) process.exit(0);
  forwardToExactGroup('SIGTERM');
});
process.on('message', (message) => {
  if (!message || typeof message !== 'object' || message.runId !== runId) return;
  if (message.type === 'abort' && target === null) process.exit(125);
  if (message.type === 'start' && target === null) {
    target = spawn(payload.command, payload.arguments_, {
      cwd: process.cwd(),
      env: targetEnvironment,
      shell: false,
      detached: false,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    target.once('spawn', () => send({ type: 'target-spawned', pid: target.pid }));
    target.once('error', (error) => {
      targetSpawnError = error instanceof Error ? error.message : String(error);
    });
    target.once('close', (exitCode, signal) => {
      targetClosed = true;
      send({ type: 'target-result', exitCode, signal, spawnError: targetSpawnError });
    });
    return;
  }
  if (message.type !== 'release' || !targetClosed) return;
  if (escalationTimer) clearTimeout(escalationTimer);
  process.exit(0);
});
