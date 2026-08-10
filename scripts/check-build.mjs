import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  collectBuildProvenance,
  completeReleaseLicenseManifest,
  snapshotDistributionArtifacts,
  validateReleaseArtifacts,
  writeBuildIntegrityStamp,
  writeReleaseManifest,
} from './lib/build-integrity.mjs';
import { REPOSITORY_ROOT, writeJsonAtomic } from './lib/dev-contract.mjs';

const distRoot = path.join(REPOSITORY_ROOT, 'dist');
const budgets = Object.freeze({
  largestJavaScriptRawBytes: 900 * 1024,
  totalCompressedBytes: 6 * 1024 * 1024,
});

await completeReleaseLicenseManifest(REPOSITORY_ROOT);
await writeBuildIntegrityStamp(REPOSITORY_ROOT);
await writeReleaseManifest(REPOSITORY_ROOT);
const release = await validateReleaseArtifacts(REPOSITORY_ROOT);
const builderProvenance = await collectBuildProvenance(REPOSITORY_ROOT);
await writeJsonAtomic(path.join(REPOSITORY_ROOT, '.dev', 'reports', 'build-attestation.json'), {
  schemaVersion: 1,
  project: '3d-websites-hackathon',
  command: 'pnpm run build',
  buildInputDigest: release.manifest.buildInputDigest,
  buildContextSha256: release.manifest.buildContextSha256,
  releaseManifestSha256: release.manifestSha256,
  toolchain: builderProvenance.toolchain,
  buildTarget: release.buildContext.buildTarget,
  builderPlatform: builderProvenance.builderPlatform,
  sourceRevision: builderProvenance.sourceRevision,
  reproducibilityBoundary:
    'Builder OS, architecture, and Git state are an untracked attestation, not inputs to canonical static artifact hashes. Identical payload bytes across host platforms require separate clean-build comparison evidence.',
});
const currentArtifacts = await snapshotDistributionArtifacts(REPOSITORY_ROOT);
const currentPaths = currentArtifacts.map((artifact) => artifact.path);

if (currentPaths.some((artifactPath) => artifactPath.endsWith('.map'))) {
  throw new Error('BUILD_SOURCEMAP_FORBIDDEN');
}
for (const required of [
  'index.html',
  '.vite/manifest.json',
  'build-context.json',
  'build-integrity.json',
  'release-manifest.json',
  'third-party-licenses.json',
]) {
  if (!currentPaths.includes(required)) throw new Error(`BUILD_ARTIFACT_MISSING: ${required}`);
}

const artifacts = await Promise.all(
  currentArtifacts.map(async (artifact) => {
    const body = await readFile(path.join(distRoot, artifact.path));
    return {
      ...artifact,
      gzipBytes: gzipSync(body, { level: 9 }).byteLength,
    };
  }),
);
const javaScriptArtifacts = artifacts.filter(({ path: artifactPath }) =>
  artifactPath.endsWith('.js'),
);
if (javaScriptArtifacts.length === 0) throw new Error('BUILD_JAVASCRIPT_ARTIFACT_MISSING');
const largestJavaScriptRawBytes = Math.max(...javaScriptArtifacts.map(({ bytes }) => bytes));
const totalCompressedBytes = artifacts.reduce((total, artifact) => total + artifact.gzipBytes, 0);
if (largestJavaScriptRawBytes > budgets.largestJavaScriptRawBytes) {
  throw new Error(
    `BUILD_JS_CHUNK_BUDGET_EXCEEDED: ${largestJavaScriptRawBytes} > ${budgets.largestJavaScriptRawBytes}`,
  );
}
if (totalCompressedBytes > budgets.totalCompressedBytes) {
  throw new Error(
    `BUILD_COMPRESSED_BUDGET_EXCEEDED: ${totalCompressedBytes} > ${budgets.totalCompressedBytes}`,
  );
}

await writeJsonAtomic(path.join(REPOSITORY_ROOT, 'evidence', 'tier0', 'build-budget.json'), {
  schemaVersion: 2,
  project: '3d-websites-hackathon',
  command: 'pnpm run build',
  seed: null,
  buildContext: release.buildContext,
  releaseManifest: {
    path: 'release-manifest.json',
    bytes: release.manifestBytes,
    sha256: release.manifestSha256,
    buildInputDigest: release.manifest.buildInputDigest,
    buildContextSha256: release.manifest.buildContextSha256,
  },
  budgets,
  measurements: { largestJavaScriptRawBytes, totalCompressedBytes },
  artifacts,
});
console.log(
  `build:budget ok — largest JS ${largestJavaScriptRawBytes} bytes; total gzip ${totalCompressedBytes} bytes`,
);
