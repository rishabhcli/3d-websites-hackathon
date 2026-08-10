import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPOSITORY_ROOT, writeJsonAtomic } from '../lib/dev-contract.mjs';

const npmRegistryBaseUrl = 'https://registry.npmjs.org/';
const osvBatchUrl = 'https://api.osv.dev/v1/querybatch';
const outputPath = path.join(
  REPOSITORY_ROOT,
  'scripts',
  'evidence',
  'dependency-review.snapshot.json',
);

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function licenseString(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type;
  return null;
}

function repositoryUrl(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.url === 'string') return value.url;
  return null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': '3d-websites-hackathon-dependency-review/1',
      ...options.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`DEPENDENCY_REVIEW_FETCH_FAILED: ${url} ${response.status}`);
  return response.json();
}

function sortedAdvisoryIds(result) {
  if (!result || !Array.isArray(result.vulns)) return [];
  return [...new Set(result.vulns.map((vulnerability) => vulnerability.id))].sort();
}

const packageJsonBody = await readFile(path.join(REPOSITORY_ROOT, 'package.json'));
const lockfileBody = await readFile(path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'));
const packageJson = JSON.parse(packageJsonBody.toString('utf8'));
const dependencies = [
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
].sort((left, right) => left.name.localeCompare(right.name));

const registryRecords = await Promise.all(
  dependencies.map(async (dependency) => {
    const metadataUrl = `${npmRegistryBaseUrl}${encodeURIComponent(dependency.name)}`;
    const metadata = await fetchJson(metadataUrl);
    const selectedManifest = metadata.versions?.[dependency.version];
    const latestVersion = metadata['dist-tags']?.latest;
    const latestManifest =
      typeof latestVersion === 'string' ? metadata.versions?.[latestVersion] : null;
    const selectedPublishedAt = metadata.time?.[dependency.version];
    const latestPublishedAt =
      typeof latestVersion === 'string' ? metadata.time?.[latestVersion] : undefined;
    if (
      !selectedManifest ||
      typeof latestVersion !== 'string' ||
      !latestManifest ||
      typeof selectedPublishedAt !== 'string' ||
      typeof latestPublishedAt !== 'string'
    ) {
      throw new Error(`DEPENDENCY_REVIEW_REGISTRY_METADATA_INCOMPLETE: ${dependency.name}`);
    }
    return {
      ...dependency,
      registry: {
        metadataUrl,
        selectedPublishedAt,
        selectedLicense: licenseString(selectedManifest.license),
        selectedDeprecatedNotice:
          typeof selectedManifest.deprecated === 'string' ? selectedManifest.deprecated : null,
        latestVersion,
        latestPublishedAt,
        latestDeprecatedNotice:
          typeof latestManifest.deprecated === 'string' ? latestManifest.deprecated : null,
        packageMetadataModifiedAt:
          typeof metadata.time?.modified === 'string' ? metadata.time.modified : null,
        repositoryUrl: repositoryUrl(selectedManifest.repository),
      },
    };
  }),
);

const packageOnlyQueries = dependencies.map(({ name }) => ({
  package: { ecosystem: 'npm', name },
}));
const selectedVersionQueries = dependencies.map(({ name, version }) => ({
  version,
  package: { ecosystem: 'npm', name },
}));
const [packageHistoryBatch, selectedVersionBatch] = await Promise.all([
  fetchJson(osvBatchUrl, {
    method: 'POST',
    body: JSON.stringify({ queries: packageOnlyQueries }),
  }),
  fetchJson(osvBatchUrl, {
    method: 'POST',
    body: JSON.stringify({ queries: selectedVersionQueries }),
  }),
]);
if (
  !Array.isArray(packageHistoryBatch.results) ||
  packageHistoryBatch.results.length !== dependencies.length ||
  !Array.isArray(selectedVersionBatch.results) ||
  selectedVersionBatch.results.length !== dependencies.length
) {
  throw new Error('DEPENDENCY_REVIEW_OSV_BATCH_SHAPE_INVALID');
}

const auditCommand = 'pnpm audit --json --audit-level low';
const audit = spawnSync('pnpm', ['audit', '--json', '--audit-level', 'low'], {
  cwd: REPOSITORY_ROOT,
  encoding: 'utf8',
  env: { ...process.env, npm_config_registry: npmRegistryBaseUrl },
  maxBuffer: 16 * 1024 * 1024,
});
if (audit.error || audit.signal || (audit.status !== 0 && audit.status !== 1)) {
  throw new Error(
    `DEPENDENCY_REVIEW_AUDIT_FAILED: ${audit.error?.message ?? audit.signal ?? audit.status}`,
  );
}
let auditReport;
try {
  auditReport = JSON.parse(audit.stdout);
} catch (error) {
  throw new Error('DEPENDENCY_REVIEW_AUDIT_JSON_INVALID', { cause: error });
}
const auditCounts = auditReport.metadata?.vulnerabilities;
if (
  !auditCounts ||
  !['info', 'low', 'moderate', 'high', 'critical'].every(
    (severity) => Number.isInteger(auditCounts[severity]) && auditCounts[severity] >= 0,
  )
) {
  throw new Error('DEPENDENCY_REVIEW_AUDIT_COUNTS_INVALID');
}

const reviewedAt = new Date().toISOString();
await writeJsonAtomic(outputPath, {
  schemaVersion: 1,
  command: 'pnpm run dependency-review:refresh',
  reviewedAt,
  packageJsonSha256: sha256(packageJsonBody),
  lockfileSha256: sha256(lockfileBody),
  sources: {
    npmRegistry: {
      baseUrl: npmRegistryBaseUrl,
      role: 'Primary package publication metadata for release dates, dist-tags, deprecation, and licence.',
    },
    osv: {
      endpoint: osvBatchUrl,
      role: 'Known-advisory history by npm package and exact selected version.',
      limitation:
        'OSV is an advisory database, not a proof that unlisted vulnerabilities or incidents do not exist.',
    },
    pnpmAudit: {
      command: auditCommand,
      registry: npmRegistryBaseUrl,
      exitCode: audit.status,
      advisoryIds: Object.keys(auditReport.advisories ?? {}).sort(),
      vulnerabilities: {
        info: auditCounts.info,
        low: auditCounts.low,
        moderate: auditCounts.moderate,
        high: auditCounts.high,
        critical: auditCounts.critical,
      },
      dependencyCounts: {
        production: auditReport.metadata?.dependencies ?? null,
        development: auditReport.metadata?.devDependencies ?? null,
        optional: auditReport.metadata?.optionalDependencies ?? null,
        total: auditReport.metadata?.totalDependencies ?? null,
      },
      limitation:
        'The audit covers the resolved lockfile at review time; it is not a complete package security history.',
    },
  },
  dependencies: registryRecords.map((dependency, index) => ({
    ...dependency,
    security: {
      osvKnownAdvisoryIdsForPackage: sortedAdvisoryIds(packageHistoryBatch.results[index]),
      osvAdvisoryIdsAffectingSelectedVersion: sortedAdvisoryIds(
        selectedVersionBatch.results[index],
      ),
    },
  })),
});

console.log(
  `dependency-review:refresh ok — ${dependencies.length} direct dependencies reviewed at ${reviewedAt}`,
);
