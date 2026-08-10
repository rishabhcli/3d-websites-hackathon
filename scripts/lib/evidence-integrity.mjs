import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { snapshotDistributionArtifacts, validateReleaseArtifacts } from './build-integrity.mjs';

const requiredArtifactPaths = Object.freeze([
  'tier0/build-budget.json',
  'tier0/dependency-register.json',
]);
const requiredTier0FileNames = Object.freeze([
  'build-budget.json',
  'dependency-register.json',
  'manifest.json',
]);
const inputsDigestAlgorithm = 'sha256-path-nul-body-nul-v1';
const buildBudgets = Object.freeze({
  largestJavaScriptRawBytes: 900 * 1024,
  totalCompressedBytes: 6 * 1024 * 1024,
});

const inputFiles = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'scripts/check-build.mjs',
  'scripts/evidence/dependency-review.snapshot.json',
  'scripts/evidence/generate-tier0.mjs',
  'scripts/evidence/refresh-dependency-review.mjs',
  'scripts/lib/build-integrity.mjs',
  'scripts/lib/evidence-integrity.mjs',
]);

export async function sha256File(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

export async function computeEvidenceInputsSha256(repositoryRoot) {
  const digest = createHash('sha256');
  for (const relativeFile of inputFiles) {
    const absolutePath = path.join(repositoryRoot, relativeFile);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`EVIDENCE_INPUT_FILE_INVALID: ${relativeFile}`);
    }
    digest.update(relativeFile.split(path.sep).join('/'));
    digest.update('\0');
    digest.update(await readFile(absolutePath));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export function isEvidenceArtifactEntry(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.path === 'string' &&
    /^tier0\/[a-z0-9-]+\.json$/u.test(value.path) &&
    value.path !== 'tier0/manifest.json' &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    Object.keys(value).sort().join(',') === 'path,sha256'
  );
}

function requireObject(value, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value;
}

function assertExactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(code);
  }
  return value;
}

async function validateBuildBudgetAgainstCurrentRelease(repositoryRoot, buildBudget) {
  assertExactKeys(
    buildBudget,
    [
      'schemaVersion',
      'project',
      'command',
      'seed',
      'buildContext',
      'releaseManifest',
      'budgets',
      'measurements',
      'artifacts',
    ],
    'EVIDENCE_BUILD_BUDGET_SCHEMA_INVALID',
  );
  const release = await validateReleaseArtifacts(repositoryRoot);
  const currentArtifacts = await snapshotDistributionArtifacts(repositoryRoot);
  if (
    JSON.stringify(buildBudget.buildContext) !== JSON.stringify(release.buildContext) ||
    buildBudget.artifacts.length !== currentArtifacts.length
  ) {
    throw new Error('EVIDENCE_BUILD_BUDGET_RELEASE_MISMATCH');
  }
  const releaseManifest = assertExactKeys(
    requireObject(buildBudget.releaseManifest, 'EVIDENCE_BUILD_BUDGET_RELEASE_MANIFEST_INVALID'),
    ['path', 'bytes', 'sha256', 'buildInputDigest', 'buildContextSha256'],
    'EVIDENCE_BUILD_BUDGET_RELEASE_MANIFEST_INVALID',
  );
  if (
    releaseManifest.path !== 'release-manifest.json' ||
    releaseManifest.bytes !== release.manifestBytes ||
    releaseManifest.sha256 !== release.manifestSha256 ||
    releaseManifest.buildInputDigest !== release.manifest.buildInputDigest ||
    releaseManifest.buildContextSha256 !== release.manifest.buildContextSha256
  ) {
    throw new Error('EVIDENCE_BUILD_BUDGET_RELEASE_MANIFEST_STALE');
  }
  const budgets = assertExactKeys(
    requireObject(buildBudget.budgets, 'EVIDENCE_BUILD_BUDGET_LIMITS_INVALID'),
    ['largestJavaScriptRawBytes', 'totalCompressedBytes'],
    'EVIDENCE_BUILD_BUDGET_LIMITS_INVALID',
  );
  if (
    budgets.largestJavaScriptRawBytes !== buildBudgets.largestJavaScriptRawBytes ||
    budgets.totalCompressedBytes !== buildBudgets.totalCompressedBytes
  ) {
    throw new Error('EVIDENCE_BUILD_BUDGET_LIMITS_STALE');
  }
  let largestJavaScriptRawBytes = 0;
  let totalCompressedBytes = 0;
  for (let index = 0; index < currentArtifacts.length; index += 1) {
    const current = currentArtifacts[index];
    const recorded = assertExactKeys(
      requireObject(buildBudget.artifacts[index], 'EVIDENCE_BUILD_BUDGET_ARTIFACT_INVALID'),
      ['path', 'bytes', 'sha256', 'gzipBytes'],
      'EVIDENCE_BUILD_BUDGET_ARTIFACT_INVALID',
    );
    const gzipBytes = gzipSync(await readFile(path.join(repositoryRoot, 'dist', current.path)), {
      level: 9,
    }).byteLength;
    if (
      recorded.path !== current.path ||
      recorded.bytes !== current.bytes ||
      recorded.sha256 !== current.sha256 ||
      recorded.gzipBytes !== gzipBytes
    ) {
      throw new Error(`EVIDENCE_BUILD_BUDGET_ARTIFACT_STALE: ${current.path}`);
    }
    if (current.path.endsWith('.js')) {
      largestJavaScriptRawBytes = Math.max(largestJavaScriptRawBytes, current.bytes);
    }
    totalCompressedBytes += gzipBytes;
  }
  const measurements = assertExactKeys(
    requireObject(buildBudget.measurements, 'EVIDENCE_BUILD_BUDGET_MEASUREMENTS_INVALID'),
    ['largestJavaScriptRawBytes', 'totalCompressedBytes'],
    'EVIDENCE_BUILD_BUDGET_MEASUREMENTS_INVALID',
  );
  if (
    largestJavaScriptRawBytes === 0 ||
    measurements.largestJavaScriptRawBytes !== largestJavaScriptRawBytes ||
    measurements.totalCompressedBytes !== totalCompressedBytes ||
    largestJavaScriptRawBytes > buildBudgets.largestJavaScriptRawBytes ||
    totalCompressedBytes > buildBudgets.totalCompressedBytes
  ) {
    throw new Error('EVIDENCE_BUILD_BUDGET_MEASUREMENTS_STALE_OR_EXCEEDED');
  }
}

async function validateDependencyRegisterAgainstRepository(repositoryRoot, register) {
  assertExactKeys(
    register,
    [
      'schemaVersion',
      'project',
      'command',
      'seed',
      'inputsDigestAlgorithm',
      'inputsSha256',
      'review',
      'dependencies',
    ],
    'EVIDENCE_DEPENDENCY_REGISTER_SCHEMA_INVALID',
  );
  const [packageBody, lockfileSha256] = await Promise.all([
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    sha256File(path.join(repositoryRoot, 'pnpm-lock.yaml')),
  ]);
  const packageManifest = requireObject(
    JSON.parse(packageBody),
    'EVIDENCE_DEPENDENCY_PACKAGE_MANIFEST_INVALID',
  );
  const declared = [
    ...Object.entries(
      requireObject(packageManifest.dependencies, 'EVIDENCE_RUNTIME_DEPENDENCIES_INVALID'),
    ).map(([name, version]) => ({ name, version, scope: 'runtime' })),
    ...Object.entries(
      requireObject(packageManifest.devDependencies, 'EVIDENCE_DEV_DEPENDENCIES_INVALID'),
    ).map(([name, version]) => ({ name, version, scope: 'development' })),
  ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (register.dependencies.length !== declared.length) {
    throw new Error('EVIDENCE_DEPENDENCY_REGISTER_SET_INVALID');
  }
  const review = assertExactKeys(
    requireObject(register.review, 'EVIDENCE_DEPENDENCY_REVIEW_INVALID'),
    [
      'snapshotCommand',
      'reviewedAt',
      'packageJsonSha256',
      'lockfileSha256',
      'primaryPackageMetadataSource',
      'advisoryHistorySource',
      'currentResolvedLockfileAudit',
      'boundary',
    ],
    'EVIDENCE_DEPENDENCY_REVIEW_INVALID',
  );
  if (
    review.snapshotCommand !== 'pnpm run dependency-review:refresh' ||
    review.packageJsonSha256 !== createHash('sha256').update(packageBody).digest('hex') ||
    review.lockfileSha256 !== lockfileSha256 ||
    typeof review.reviewedAt !== 'string' ||
    !Number.isFinite(Date.parse(review.reviewedAt)) ||
    typeof review.boundary !== 'string' ||
    review.boundary.length === 0
  ) {
    throw new Error('EVIDENCE_DEPENDENCY_REVIEW_STALE_OR_INVALID');
  }
  for (let index = 0; index < declared.length; index += 1) {
    const expected = declared[index];
    const recorded = assertExactKeys(
      requireObject(register.dependencies[index], 'EVIDENCE_DEPENDENCY_ENTRY_INVALID'),
      [
        'name',
        'version',
        'scope',
        'license',
        'maintenance',
        'securityHistory',
        'nativeBinary',
        'cost',
      ],
      'EVIDENCE_DEPENDENCY_ENTRY_INVALID',
    );
    if (
      recorded.name !== expected.name ||
      recorded.version !== expected.version ||
      recorded.scope !== expected.scope ||
      typeof expected.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(expected.version)
    ) {
      throw new Error(`EVIDENCE_DEPENDENCY_ENTRY_STALE: ${expected.name}`);
    }
    const installed = requireObject(
      JSON.parse(
        await readFile(
          path.join(repositoryRoot, 'node_modules', ...expected.name.split('/'), 'package.json'),
          'utf8',
        ),
      ),
      `EVIDENCE_DEPENDENCY_INSTALLED_INVALID: ${expected.name}`,
    );
    const license = assertExactKeys(
      requireObject(recorded.license, `EVIDENCE_DEPENDENCY_LICENSE_INVALID: ${expected.name}`),
      ['spdxExpression', 'installedManifest', 'primaryRegistrySelectedVersion', 'status'],
      `EVIDENCE_DEPENDENCY_LICENSE_INVALID: ${expected.name}`,
    );
    if (
      installed.name !== expected.name ||
      installed.version !== expected.version ||
      typeof installed.license !== 'string' ||
      license.spdxExpression !== installed.license ||
      license.installedManifest !== installed.license ||
      license.primaryRegistrySelectedVersion !== installed.license ||
      license.status !== 'matched-installed-and-registry-manifests'
    ) {
      throw new Error(`EVIDENCE_DEPENDENCY_LICENSE_STALE: ${expected.name}`);
    }
    for (const [field, code] of [
      ['maintenance', 'EVIDENCE_DEPENDENCY_MAINTENANCE_INVALID'],
      ['securityHistory', 'EVIDENCE_DEPENDENCY_SECURITY_INVALID'],
      ['nativeBinary', 'EVIDENCE_DEPENDENCY_NATIVE_REVIEW_INVALID'],
      ['cost', 'EVIDENCE_DEPENDENCY_COST_INVALID'],
    ]) {
      requireObject(recorded[field], `${code}: ${expected.name}`);
    }
  }
}

async function validateArtifactContent(
  repositoryRoot,
  artifactPath,
  value,
  inputsSha256,
  validateRepositoryContent,
) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`EVIDENCE_ARTIFACT_CONTENT_INVALID: ${artifactPath}`);
  }
  if (artifactPath === 'tier0/build-budget.json') {
    if (
      value.schemaVersion !== 2 ||
      value.project !== '3d-websites-hackathon' ||
      value.command !== 'pnpm run build' ||
      value.seed !== null ||
      typeof value.buildContext !== 'object' ||
      value.buildContext === null ||
      typeof value.releaseManifest !== 'object' ||
      value.releaseManifest === null ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length === 0
    ) {
      throw new Error('EVIDENCE_BUILD_BUDGET_SCHEMA_INVALID');
    }
    if (validateRepositoryContent) {
      await validateBuildBudgetAgainstCurrentRelease(repositoryRoot, value);
    }
    return;
  }
  if (artifactPath === 'tier0/dependency-register.json') {
    if (
      value.schemaVersion !== 2 ||
      value.project !== '3d-websites-hackathon' ||
      value.command !== 'pnpm run evidence:generate' ||
      value.seed !== null ||
      value.inputsDigestAlgorithm !== inputsDigestAlgorithm ||
      value.inputsSha256 !== inputsSha256 ||
      typeof value.review !== 'object' ||
      value.review === null ||
      !Array.isArray(value.dependencies) ||
      value.dependencies.length === 0
    ) {
      throw new Error('EVIDENCE_DEPENDENCY_REGISTER_SCHEMA_INVALID');
    }
    if (validateRepositoryContent) {
      await validateDependencyRegisterAgainstRepository(repositoryRoot, value);
    }
    return;
  }
  throw new Error(`EVIDENCE_ARTIFACT_UNEXPECTED: ${artifactPath}`);
}

export async function validateEvidenceManifest(
  repositoryRoot,
  { validateRepositoryContent = true } = {},
) {
  if (typeof validateRepositoryContent !== 'boolean') {
    throw new Error('EVIDENCE_VALIDATION_OPTION_INVALID');
  }
  const evidenceRoot = path.join(repositoryRoot, 'evidence');
  const tier0Root = path.join(evidenceRoot, 'tier0');
  const [evidenceRootMetadata, tier0RootMetadata, tier0Entries] = await Promise.all([
    lstat(evidenceRoot),
    lstat(tier0Root),
    readdir(tier0Root, { withFileTypes: true }),
  ]);
  if (
    !evidenceRootMetadata.isDirectory() ||
    evidenceRootMetadata.isSymbolicLink() ||
    !tier0RootMetadata.isDirectory() ||
    tier0RootMetadata.isSymbolicLink()
  ) {
    throw new Error('EVIDENCE_TIER0_ROOT_INVALID');
  }
  const tier0FileNames = tier0Entries
    .map(({ name }) => name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    tier0FileNames.length !== requiredTier0FileNames.length ||
    tier0FileNames.some((fileName, index) => fileName !== requiredTier0FileNames[index])
  ) {
    throw new Error(
      `EVIDENCE_TIER0_FILE_SET_INVALID: expected=${requiredTier0FileNames.join(',')} current=${tier0FileNames.join(',')}`,
    );
  }
  for (const entry of tier0Entries) {
    const metadata = await lstat(path.join(tier0Root, entry.name));
    if (!entry.isFile() || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`EVIDENCE_TIER0_FILE_INVALID: ${entry.name}`);
    }
  }
  const manifestPath = path.join(tier0Root, 'manifest.json');
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error('EVIDENCE_MANIFEST_FILE_INVALID');
  }
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const inputsSha256 = await computeEvidenceInputsSha256(repositoryRoot);
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    manifest.schemaVersion !== 1 ||
    manifest.project !== '3d-websites-hackathon' ||
    manifest.command !== 'pnpm run evidence:generate' ||
    manifest.seed !== null ||
    manifest.inputsDigestAlgorithm !== inputsDigestAlgorithm ||
    manifest.inputsSha256 !== inputsSha256 ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== requiredArtifactPaths.length ||
    !manifest.artifacts.every(isEvidenceArtifactEntry)
  ) {
    throw new Error('EVIDENCE_MANIFEST_INVALID_OR_STALE');
  }
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'project',
      'command',
      'seed',
      'inputsDigestAlgorithm',
      'inputsSha256',
      'artifacts',
    ],
    'EVIDENCE_MANIFEST_INVALID_OR_STALE',
  );
  if (manifestRaw !== `${JSON.stringify(manifest, null, 2)}\n`) {
    throw new Error('EVIDENCE_MANIFEST_NOT_CANONICAL');
  }
  if (
    manifest.artifacts.some(
      ({ path: artifactPath }, index) => artifactPath !== requiredArtifactPaths[index],
    )
  ) {
    throw new Error('EVIDENCE_MANIFEST_ARTIFACT_SET_INVALID');
  }
  const evidenceRealPath = await realpath(evidenceRoot);
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(evidenceRoot, artifact.path);
    const artifactMetadata = await lstat(artifactPath);
    if (!artifactMetadata.isFile() || artifactMetadata.isSymbolicLink()) {
      throw new Error(`EVIDENCE_ARTIFACT_FILE_INVALID: ${artifact.path}`);
    }
    const artifactRealPath = await realpath(artifactPath);
    if (!artifactRealPath.startsWith(`${evidenceRealPath}${path.sep}`)) {
      throw new Error('EVIDENCE_ARTIFACT_ESCAPES_ROOT');
    }
    if ((await sha256File(artifactRealPath)) !== artifact.sha256) {
      throw new Error(`EVIDENCE_ARTIFACT_DIGEST_MISMATCH: ${artifact.path}`);
    }
    const artifactRaw = await readFile(artifactRealPath, 'utf8');
    const artifactValue = JSON.parse(artifactRaw);
    if (artifactRaw !== `${JSON.stringify(artifactValue, null, 2)}\n`) {
      throw new Error(`EVIDENCE_ARTIFACT_NOT_CANONICAL: ${artifact.path}`);
    }
    await validateArtifactContent(
      repositoryRoot,
      artifact.path,
      artifactValue,
      inputsSha256,
      validateRepositoryContent,
    );
  }
  return { manifest, manifestPath };
}
