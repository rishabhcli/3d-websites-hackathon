import process from 'node:process';

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const kind = readArgument('--kind');
const port = Number(readArgument('--port'));
const service = readArgument('--service');
const runId = readArgument('--run-id');

if (!['dev', 'preview'].includes(kind) || !Number.isInteger(port) || !service || !runId) {
  throw new Error(
    'vite-service requires --kind dev|preview --port <integer> --service <id> --run-id <id>',
  );
}
if (port < 4100 || port > 4109) throw new Error('vite-service port is outside 4100-4109');

process.env.DEV_SERVICE_NAME = service;
process.env.DEV_SERVICE_PORT = String(port);
process.env.DEV_RUN_ID = runId;

const { createServer, preview } = await import('vite');
const common = { host: '127.0.0.1', port, strictPort: true };
const server =
  kind === 'dev'
    ? await createServer({
        mode: service === 'projection-harness' ? 'test' : 'development',
        server: common,
      })
    : await preview({ preview: common });

if (kind === 'dev') await server.listen();

let closing = false;
async function close(signal) {
  if (closing) return;
  closing = true;
  console.log(`${service}: received ${signal}; closing`);
  await server.close();
  process.exit(0);
}

process.once('SIGTERM', () => void close('SIGTERM'));
process.once('SIGINT', () => void close('SIGINT'));
console.log(`${service}: listening on http://127.0.0.1:${port}`);
