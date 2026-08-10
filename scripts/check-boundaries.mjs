import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceRoot = path.join(root, 'src');
const domainAreas = new Set(['camera', 'quality', 'scenes', 'sculpture', 'solver']);
const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu;

function isUiImport(specifier) {
  return (
    specifier === 'react' ||
    specifier.startsWith('react/') ||
    specifier === 'react-dom' ||
    specifier.startsWith('react-dom/') ||
    specifier === '@react-three/fiber' ||
    specifier.startsWith('@react-three/fiber/') ||
    /(?:^|\/)\.\.\/(?:gallery|accessibility)(?:\/|$)/u.test(specifier)
  );
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    }),
  );
  return nested.flat();
}

const failures = [];
for (const file of await filesBelow(sourceRoot)) {
  if (!/\.(?:ts|tsx)$/u.test(file) || /\.(?:test|spec)\./u.test(file)) continue;
  const area = path.relative(sourceRoot, file).split(path.sep)[0];
  if (!area || !domainAreas.has(area)) continue;
  if (file.endsWith('.tsx')) {
    failures.push(`${path.relative(root, file)} uses TSX inside a framework-free domain area`);
  }
  const source = await readFile(file, 'utf8');
  importPattern.lastIndex = 0;
  const importsUi = [...source.matchAll(importPattern)].some((match) => isUiImport(match[1] ?? ''));
  if (importsUi) failures.push(`${path.relative(root, file)} imports UI/framework code`);
}

for (const configFile of ['vite.config.ts', 'playwright.config.ts']) {
  const source = await readFile(path.join(root, configFile), 'utf8');
  if (/\b(?:0\.0\.0\.0|localhost)\b/u.test(source)) {
    failures.push(`${configFile} contains a forbidden non-canonical host`);
  }
  for (const forbiddenPort of [3000, 3001, 4200, 5000, 5173, 5432, 6379, 8000, 8080, 9000, 9090]) {
    if (new RegExp(`\\b${forbiddenPort}\\b`, 'u').test(source)) {
      failures.push(`${configFile} contains forbidden port ${forbiddenPort}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Boundary check failed:\n- ${failures.join('\n- ')}`);
}
console.log('boundaries:check ok — domain/UI and exclusive-port rules hold');
