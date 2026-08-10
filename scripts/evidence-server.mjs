import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateEvidenceManifest } from './lib/evidence-integrity.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.join(repositoryRoot, 'evidence');

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(readArgument('--port'));
const service = readArgument('--service');
const runId = readArgument('--run-id');
if (!Number.isInteger(port) || !service || !runId || port < 4100 || port > 4109) {
  throw new Error('evidence-server requires safe --port, --service and --run-id arguments');
}

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

async function resolveEvidencePath(pathname) {
  const relative =
    pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('path escapes evidence root');
  const resolved = await realpath(candidate);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('symlink escapes evidence root');
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error('not a file');
  return resolved;
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and HEAD are supported' },
        }),
      );
      return;
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/livez') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(
        request.method === 'HEAD'
          ? undefined
          : JSON.stringify({
              schemaVersion: 1,
              project: '3d-websites-hackathon',
              service,
              host: '127.0.0.1',
              port,
              pid: process.pid,
              runId,
              status: 'alive',
            }),
      );
      return;
    }
    if (url.pathname === '/readyz') {
      const { manifestPath } = await validateEvidenceManifest(repositoryRoot);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(
        request.method === 'HEAD'
          ? undefined
          : JSON.stringify({
              schemaVersion: 1,
              project: '3d-websites-hackathon',
              service,
              host: '127.0.0.1',
              port,
              pid: process.pid,
              runId,
              artifactDigest: createHash('sha256')
                .update(await readFile(manifestPath))
                .digest('hex'),
              status: 'ready',
            }),
      );
      return;
    }
    const filePath = await resolveEvidencePath(url.pathname);
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const message =
      error instanceof URIError ? 'invalid path encoding' : 'evidence artifact not found';
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { code: 'EVIDENCE_NOT_FOUND', message } }));
  }
});

server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
  console.log(`${service}: listening on http://127.0.0.1:${port}`);
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));
