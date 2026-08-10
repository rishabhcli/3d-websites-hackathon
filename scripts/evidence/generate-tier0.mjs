import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { PROJECT_NAME, REPOSITORY_ROOT, writeJsonAtomic } from '../lib/dev-contract.mjs';
import {
  snapshotDistributionArtifacts,
  validateReleaseArtifacts,
} from '../lib/build-integrity.mjs';
import {
  computeEvidenceInputsSha256,
  sha256File,
  validateEvidenceManifest,
} from '../lib/evidence-integrity.mjs';

const outputRoot = path.join(REPOSITORY_ROOT, 'evidence', 'tier0');
const packageJsonPath = path.join(REPOSITORY_ROOT, 'package.json');
const lockfilePath = path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml');
const reviewSnapshotPath = path.join(
  REPOSITORY_ROOT,
  'scripts',
  'evidence',
  'dependency-review.snapshot.json',
);
const buildBudgetPath = path.join(outputRoot, 'build-budget.json');
const viteManifestPath = path.join(REPOSITORY_ROOT, 'dist', '.vite', 'manifest.json');
const binaryPayloadExtensions = new Set(['.node', '.wasm', '.woff', '.woff2', '.ttf', '.otf']);

function requireObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(code);
  }
  return value;
}

function requirePositiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

async function validateBuildBudgetEvidence(buildBudget, release, currentArtifacts) {
  requireExactKeys(
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
    'BUILD_BUDGET_EVIDENCE_INVALID',
  );
  if (
    buildBudget.schemaVersion !== 2 ||
    buildBudget.project !== PROJECT_NAME ||
    buildBudget.command !== 'pnpm run build' ||
    buildBudget.seed !== null ||
    JSON.stringify(buildBudget.buildContext) !== JSON.stringify(release.buildContext) ||
    !Array.isArray(buildBudget.artifacts) ||
    buildBudget.artifacts.length !== currentArtifacts.length
  ) {
    throw new Error('BUILD_BUDGET_EVIDENCE_INVALID');
  }

  const releaseManifest = requireExactKeys(
    requireObject(buildBudget.releaseManifest, 'BUILD_BUDGET_RELEASE_MANIFEST_INVALID'),
    ['path', 'bytes', 'sha256', 'buildInputDigest', 'buildContextSha256'],
    'BUILD_BUDGET_RELEASE_MANIFEST_INVALID',
  );
  if (
    releaseManifest.path !== 'release-manifest.json' ||
    releaseManifest.bytes !== release.manifestBytes ||
    releaseManifest.sha256 !== release.manifestSha256 ||
    releaseManifest.buildInputDigest !== release.manifest.buildInputDigest ||
    releaseManifest.buildContextSha256 !== release.manifest.buildContextSha256
  ) {
    throw new Error('BUILD_BUDGET_RELEASE_MANIFEST_STALE');
  }

  const budgets = requireExactKeys(
    requireObject(buildBudget.budgets, 'BUILD_BUDGET_LIMITS_INVALID'),
    ['largestJavaScriptRawBytes', 'totalCompressedBytes'],
    'BUILD_BUDGET_LIMITS_INVALID',
  );
  requirePositiveSafeInteger(budgets.largestJavaScriptRawBytes, 'BUILD_BUDGET_JS_LIMIT_INVALID');
  requirePositiveSafeInteger(budgets.totalCompressedBytes, 'BUILD_BUDGET_TOTAL_LIMIT_INVALID');

  let largestJavaScriptRawBytes = 0;
  let totalCompressedBytes = 0;
  for (let index = 0; index < currentArtifacts.length; index += 1) {
    const current = currentArtifacts[index];
    const recorded = requireExactKeys(
      requireObject(buildBudget.artifacts[index], 'BUILD_BUDGET_ARTIFACT_INVALID'),
      ['path', 'bytes', 'sha256', 'gzipBytes'],
      'BUILD_BUDGET_ARTIFACT_INVALID',
    );
    const body = await readFile(path.join(REPOSITORY_ROOT, 'dist', current.path));
    const gzipBytes = gzipSync(body, { level: 9 }).byteLength;
    if (
      recorded.path !== current.path ||
      recorded.bytes !== current.bytes ||
      recorded.sha256 !== current.sha256 ||
      recorded.gzipBytes !== gzipBytes
    ) {
      throw new Error(`BUILD_BUDGET_ARTIFACT_STALE: ${current.path}`);
    }
    if (current.path.endsWith('.js')) {
      largestJavaScriptRawBytes = Math.max(largestJavaScriptRawBytes, current.bytes);
    }
    totalCompressedBytes += gzipBytes;
  }
  if (largestJavaScriptRawBytes === 0) throw new Error('BUILD_BUDGET_JAVASCRIPT_MISSING');

  const measurements = requireExactKeys(
    requireObject(buildBudget.measurements, 'BUILD_BUDGET_MEASUREMENTS_INVALID'),
    ['largestJavaScriptRawBytes', 'totalCompressedBytes'],
    'BUILD_BUDGET_MEASUREMENTS_INVALID',
  );
  if (
    measurements.largestJavaScriptRawBytes !== largestJavaScriptRawBytes ||
    measurements.totalCompressedBytes !== totalCompressedBytes ||
    largestJavaScriptRawBytes > budgets.largestJavaScriptRawBytes ||
    totalCompressedBytes > budgets.totalCompressedBytes
  ) {
    throw new Error('BUILD_BUDGET_MEASUREMENTS_STALE_OR_EXCEEDED');
  }
}

function requireIsoTimestamp(value, code) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(code);
  return value;
}

function ageInWholeDays(reviewedAt, publishedAt) {
  const milliseconds = Date.parse(reviewedAt) - Date.parse(publishedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error('DEPENDENCY_REVIEW_RELEASE_DATE_AFTER_REVIEW');
  }
  return Math.floor(milliseconds / 86_400_000);
}

function sortedUniqueStrings(value, code) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(code);
  }
  const sorted = [...new Set(value)].sort();
  if (sorted.length !== value.length || sorted.some((entry, index) => entry !== value[index])) {
    throw new Error(code);
  }
  return sorted;
}

async function installedInventory(directory) {
  const totals = { bytes: 0, binaryPayloads: new Map() };
  async function visit(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        const bytes = (await stat(target)).size;
        totals.bytes += bytes;
        const extension = path.extname(entry.name).toLowerCase();
        if (binaryPayloadExtensions.has(extension)) {
          const current = totals.binaryPayloads.get(extension) ?? { files: 0, bytes: 0 };
          current.files += 1;
          current.bytes += bytes;
          totals.binaryPayloads.set(extension, current);
        }
      }
    }
  }
  await visit(directory);
  return {
    installedPackageBytes: totals.bytes,
    directPackageBinaryPayloads: Object.fromEntries(
      [...totals.binaryPayloads.entries()].sort(([left], [right]) => compareStrings(left, right)),
    ),
  };
}

function executableNames(name, bin) {
  if (typeof bin === 'string')
    return [name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name];
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return [];
  return Object.keys(bin).sort();
}

function nativeBinaryReview(name, scope, installed, directPackageBinaryPayloads) {
  const installLifecycleScripts = Object.keys(installed.scripts ?? {})
    .filter((script) => ['preinstall', 'install', 'postinstall'].includes(script))
    .sort();
  let implication;
  if (name.startsWith('@fontsource-variable/')) {
    implication =
      'Browser WOFF2 font payloads are direct package data, not executable native modules; the emitted font file is measured separately.';
  } else if (name === 'vite') {
    implication =
      'Development/build CLI. Vite reaches a platform-specific Rolldown native binding transitively during the build; neither the CLI nor binding is deployed in the static site.';
  } else if (name === '@playwright/test' || name === '@axe-core/playwright') {
    implication =
      'Test-only browser automation. Repository bootstrap installs a platform Chromium build under .dev/cache; browser executables and this package are excluded from deployment.';
  } else if (name === '@react-three/fiber') {
    implication =
      'Browser JavaScript that drives WebGL/GPU APIs. The direct package has no compiled native module, but runtime behavior depends on the browser graphics stack.';
  } else if (name === 'three') {
    implication =
      'Browser JavaScript that drives WebGL/GPU APIs. The installed package also contains auxiliary WASM/font payloads counted above; those package payloads are not automatically deployment cost, so the emitted chunk measurement below remains authoritative.';
  } else if (name === '@vitest/coverage-v8') {
    implication =
      'Test-only JavaScript using the pinned Node runtime V8 coverage interface; no package binary is deployed.';
  } else if (scope === 'development') {
    implication =
      'Development-only direct package; direct manifest executables are local tooling and installed package payloads do not deploy.';
  } else {
    implication =
      'Static browser JavaScript. No direct compiled-native payload or install lifecycle hook was observed in the installed direct package.';
  }
  return {
    directManifestSignals: {
      executableNames: executableNames(name, installed.bin),
      installLifecycleScripts,
      osConstraints: Array.isArray(installed.os) ? installed.os : [],
      cpuConstraints: Array.isArray(installed.cpu) ? installed.cpu : [],
      gypfile: installed.gypfile === true,
    },
    directPackageBinaryPayloads,
    implication,
    boundary:
      'Signals and payload counts describe the installed direct package. The Vite and Playwright transitive/platform implications are explicitly reviewed exceptions; no broader transitive-native absence is claimed.',
  };
}

function measuredArtifact(buildBudget, relativePath) {
  const artifact = buildBudget.artifacts.find((candidate) => candidate.path === relativePath);
  if (!artifact) throw new Error(`DEPENDENCY_COST_ARTIFACT_MISSING: ${relativePath}`);
  return {
    path: artifact.path,
    bytes: artifact.bytes,
    gzipBytes: artifact.gzipBytes,
    sha256: artifact.sha256,
  };
}

function emittedRuntimeCost(dependency, viteManifest, buildBudget) {
  if (dependency.scope === 'development') {
    return {
      classification: 'development-only-not-attributed-to-deployable',
      measuredDeployedBytes: null,
      basis:
        'The package is declared only in devDependencies. Production output is the static dist artifact; this field does not claim a per-package zero-byte proof.',
    };
  }
  const initialEntry = requireObject(viteManifest['index.html'], 'VITE_MANIFEST_ENTRY_MISSING');
  if (dependency.name.startsWith('@fontsource-variable/')) {
    const pnpmLocator = `${dependency.name.replace('/', '+')}@${dependency.version}`;
    const matchingEntries = Object.entries(viteManifest).filter(
      ([source, entry]) => source.includes(pnpmLocator) && typeof entry.file === 'string',
    );
    if (matchingEntries.length !== 1) {
      throw new Error(`DEPENDENCY_FONT_EMISSION_AMBIGUOUS: ${dependency.name}`);
    }
    const fontArtifact = measuredArtifact(buildBudget, matchingEntries[0][1].file);
    if (!Array.isArray(initialEntry.css) || initialEntry.css.length !== 1) {
      throw new Error('VITE_MANIFEST_SHARED_CSS_AMBIGUOUS');
    }
    return {
      classification: 'exact-emitted-font-plus-shared-css-upper-bound',
      loadingPhase: 'initial',
      exactFontArtifact: fontArtifact,
      sharedCssArtifactUpperBound: measuredArtifact(buildBudget, initialEntry.css[0]),
      boundary:
        'Font bytes are exact for this package asset. The CSS measurement is the whole shared stylesheet and includes application and other font declarations.',
    };
  }
  const dynamicRuntimeDependencies = new Set(['@react-three/fiber', 'three']);
  const initialRuntimeDependencies = new Set(['react', 'react-dom', 'zod']);
  if (dynamicRuntimeDependencies.has(dependency.name)) {
    const dynamicEntry = requireObject(
      viteManifest['src/gallery/CanvasStage.tsx'],
      'VITE_MANIFEST_CANVAS_ENTRY_MISSING',
    );
    return {
      classification: 'shared-chunk-upper-bound',
      loadingPhase: 'dynamic-after-WebGL2-capability-check',
      artifact: measuredArtifact(buildBudget, dynamicEntry.file),
      boundary:
        'Measurement is the complete CanvasStage chunk, including application code and other dependencies; it is an upper bound, not marginal package attribution.',
    };
  }
  if (initialRuntimeDependencies.has(dependency.name)) {
    return {
      classification: 'shared-chunk-upper-bound',
      loadingPhase: 'initial',
      artifact: measuredArtifact(buildBudget, initialEntry.file),
      boundary:
        'Measurement is the complete initial JavaScript chunk, including application code and other dependencies; it is an upper bound, not marginal package attribution.',
    };
  }
  throw new Error(`DEPENDENCY_RUNTIME_COST_MAPPING_MISSING: ${dependency.name}`);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const declared = [
  ...Object.entries(packageJson.dependencies ?? {}).map(([name, version]) => ({
    name,
    version,
    scope: 'runtime',
  })),
  ...Object.entries(packageJson.devDependencies ?? {}).map(([name, version]) => ({
    name,
    version,
    scope: 'development',
  })),
].sort((left, right) => compareStrings(left.name, right.name));

const reviewSnapshot = requireObject(
  JSON.parse(await readFile(reviewSnapshotPath, 'utf8')),
  'DEPENDENCY_REVIEW_SNAPSHOT_INVALID',
);
const reviewedAt = requireIsoTimestamp(
  reviewSnapshot.reviewedAt,
  'DEPENDENCY_REVIEW_TIMESTAMP_INVALID',
);
if (
  reviewSnapshot.schemaVersion !== 1 ||
  reviewSnapshot.command !== 'pnpm run dependency-review:refresh' ||
  reviewSnapshot.packageJsonSha256 !== (await sha256File(packageJsonPath)) ||
  reviewSnapshot.lockfileSha256 !== (await sha256File(lockfilePath)) ||
  !Array.isArray(reviewSnapshot.dependencies) ||
  reviewSnapshot.dependencies.length !== declared.length
) {
  throw new Error('DEPENDENCY_REVIEW_SNAPSHOT_STALE_OR_INVALID');
}
const reviewByName = new Map(
  reviewSnapshot.dependencies.map((dependency) => [dependency.name, dependency]),
);
if (reviewByName.size !== declared.length) throw new Error('DEPENDENCY_REVIEW_DUPLICATE_PACKAGE');

const buildBudget = requireObject(
  JSON.parse(await readFile(buildBudgetPath, 'utf8')),
  'BUILD_BUDGET_EVIDENCE_INVALID',
);
const release = await validateReleaseArtifacts(REPOSITORY_ROOT);
const currentDistributionArtifacts = await snapshotDistributionArtifacts(REPOSITORY_ROOT);
await validateBuildBudgetEvidence(buildBudget, release, currentDistributionArtifacts);
const viteManifest = requireObject(
  JSON.parse(await readFile(viteManifestPath, 'utf8')),
  'VITE_MANIFEST_INVALID',
);
const auditEvidence = requireObject(
  requireObject(reviewSnapshot.sources, 'DEPENDENCY_REVIEW_SOURCES_INVALID').pnpmAudit,
  'DEPENDENCY_REVIEW_AUDIT_INVALID',
);
const auditVulnerabilities = requireObject(
  auditEvidence.vulnerabilities,
  'DEPENDENCY_REVIEW_AUDIT_COUNTS_INVALID',
);
for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
  if (!Number.isInteger(auditVulnerabilities[severity]) || auditVulnerabilities[severity] < 0) {
    throw new Error('DEPENDENCY_REVIEW_AUDIT_COUNTS_INVALID');
  }
}

const dependencies = [];
for (const dependency of declared) {
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(dependency.version)) {
    throw new Error(`${dependency.name} must use an exact version, received ${dependency.version}`);
  }
  const review = requireObject(
    reviewByName.get(dependency.name),
    `DEPENDENCY_REVIEW_PACKAGE_MISSING: ${dependency.name}`,
  );
  if (review.version !== dependency.version || review.scope !== dependency.scope) {
    throw new Error(`DEPENDENCY_REVIEW_PACKAGE_STALE: ${dependency.name}`);
  }
  const registry = requireObject(
    review.registry,
    `DEPENDENCY_REVIEW_REGISTRY_INVALID: ${dependency.name}`,
  );
  const selectedPublishedAt = requireIsoTimestamp(
    registry.selectedPublishedAt,
    `DEPENDENCY_REVIEW_SELECTED_DATE_INVALID: ${dependency.name}`,
  );
  const latestPublishedAt = requireIsoTimestamp(
    registry.latestPublishedAt,
    `DEPENDENCY_REVIEW_LATEST_DATE_INVALID: ${dependency.name}`,
  );
  if (typeof registry.latestVersion !== 'string' || typeof registry.metadataUrl !== 'string') {
    throw new Error(`DEPENDENCY_REVIEW_REGISTRY_INVALID: ${dependency.name}`);
  }
  const security = requireObject(
    review.security,
    `DEPENDENCY_REVIEW_SECURITY_INVALID: ${dependency.name}`,
  );
  const knownPackageAdvisoryIds = sortedUniqueStrings(
    security.osvKnownAdvisoryIdsForPackage,
    `DEPENDENCY_REVIEW_SECURITY_HISTORY_INVALID: ${dependency.name}`,
  );
  const selectedVersionAdvisoryIds = sortedUniqueStrings(
    security.osvAdvisoryIdsAffectingSelectedVersion,
    `DEPENDENCY_REVIEW_SECURITY_VERSION_INVALID: ${dependency.name}`,
  );
  const packageDirectory = path.join(
    REPOSITORY_ROOT,
    'node_modules',
    ...dependency.name.split('/'),
  );
  const installed = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (installed.version !== dependency.version) {
    throw new Error(
      `${dependency.name}: installed ${installed.version}, declared ${dependency.version}`,
    );
  }
  const installedLicense = typeof installed.license === 'string' ? installed.license : null;
  if (installedLicense !== registry.selectedLicense) {
    throw new Error(`DEPENDENCY_REVIEW_LICENSE_MISMATCH: ${dependency.name}`);
  }
  const inventory = await installedInventory(packageDirectory);
  dependencies.push({
    name: dependency.name,
    version: dependency.version,
    scope: dependency.scope,
    license: {
      spdxExpression: installedLicense,
      installedManifest: installedLicense,
      primaryRegistrySelectedVersion: registry.selectedLicense,
      status:
        installedLicense === null ? 'not-declared' : 'matched-installed-and-registry-manifests',
    },
    maintenance: {
      observedStatus:
        registry.selectedDeprecatedNotice !== null
          ? 'selected-version-deprecated-in-registry'
          : dependency.version === registry.latestVersion
            ? 'selected-version-is-latest-dist-tag-at-review'
            : 'selected-version-behind-latest-dist-tag-at-review',
      reviewedAt,
      primaryMetadataUrl: registry.metadataUrl,
      selectedPublishedAt,
      lockedReleaseAgeDaysAtReview: ageInWholeDays(reviewedAt, selectedPublishedAt),
      selectedDeprecatedNotice: registry.selectedDeprecatedNotice,
      latestVersion: registry.latestVersion,
      latestPublishedAt,
      latestReleaseAgeDaysAtReview: ageInWholeDays(reviewedAt, latestPublishedAt),
      packageMetadataModifiedAt: registry.packageMetadataModifiedAt,
      repositoryUrl: registry.repositoryUrl,
      boundary:
        'This is a dated npm publication/deprecation observation. Release recency does not prove maintainer responsiveness or future support.',
    },
    securityHistory: {
      reviewedAt,
      knownOsvAdvisoryIdsForPackage: knownPackageAdvisoryIds,
      osvAdvisoryIdsAffectingSelectedVersion: selectedVersionAdvisoryIds,
      selectedVersionObservation:
        selectedVersionAdvisoryIds.length === 0
          ? 'osv-returned-no-match-for-exact-version-at-review'
          : 'osv-returned-matches-for-exact-version-at-review',
      resolvedLockfileAuditEvidenceRef: '#/review/currentResolvedLockfileAudit',
      blockingCurrentAdvisoryCommand: 'pnpm audit --audit-level high',
      boundary:
        'Package-wide IDs are historical database matches, not necessarily applicable to this version. An empty list or audit response is not a claim that vulnerabilities or incidents never existed.',
    },
    nativeBinary: nativeBinaryReview(
      dependency.name,
      dependency.scope,
      installed,
      inventory.directPackageBinaryPayloads,
    ),
    cost: {
      installedDirectPackageBytes: inventory.installedPackageBytes,
      emittedRuntime: emittedRuntimeCost(dependency, viteManifest, buildBudget),
    },
  });
}

const inputsSha256 = await computeEvidenceInputsSha256(REPOSITORY_ROOT);
const dependencyRegisterPath = path.join(outputRoot, 'dependency-register.json');
await writeJsonAtomic(dependencyRegisterPath, {
  schemaVersion: 2,
  project: PROJECT_NAME,
  command: 'pnpm run evidence:generate',
  seed: null,
  inputsDigestAlgorithm: 'sha256-path-nul-body-nul-v1',
  inputsSha256,
  review: {
    snapshotCommand: reviewSnapshot.command,
    reviewedAt,
    packageJsonSha256: reviewSnapshot.packageJsonSha256,
    lockfileSha256: reviewSnapshot.lockfileSha256,
    primaryPackageMetadataSource: reviewSnapshot.sources.npmRegistry,
    advisoryHistorySource: reviewSnapshot.sources.osv,
    currentResolvedLockfileAudit: auditEvidence,
    boundary:
      'Evidence generation is offline and consumes the committed dated review snapshot. Refreshing package/advisory observations is a separate explicit network command.',
  },
  dependencies,
});
const artifactPaths = [path.join(outputRoot, 'build-budget.json'), dependencyRegisterPath];
await writeJsonAtomic(path.join(outputRoot, 'manifest.json'), {
  schemaVersion: 1,
  project: PROJECT_NAME,
  command: 'pnpm run evidence:generate',
  seed: null,
  inputsDigestAlgorithm: 'sha256-path-nul-body-nul-v1',
  inputsSha256,
  artifacts: await Promise.all(
    artifactPaths.map(async (artifactPath) => ({
      path: path
        .relative(path.join(REPOSITORY_ROOT, 'evidence'), artifactPath)
        .split(path.sep)
        .join('/'),
      sha256: await sha256File(artifactPath),
    })),
  ),
});
await validateEvidenceManifest(REPOSITORY_ROOT);

const index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Regenerable evidence</title></head>
<body data-project="3d-websites-hackathon"><main><h1>Regenerable evidence</h1><p>Generated by <code>pnpm run evidence:generate</code>.</p><ul><li><a href="/tier0/manifest.json">Tier 0 manifest</a></li><li><a href="/tier0/dependency-register.json">Dependency register</a></li></ul></main></body></html>
`;
await import('node:fs/promises').then(({ mkdir, writeFile }) =>
  mkdir(path.dirname(path.join(REPOSITORY_ROOT, 'evidence', 'index.html')), {
    recursive: true,
  }).then(() => writeFile(path.join(REPOSITORY_ROOT, 'evidence', 'index.html'), index)),
);
console.log(`evidence:generate ok — ${dependencies.length} exact direct dependencies recorded`);
