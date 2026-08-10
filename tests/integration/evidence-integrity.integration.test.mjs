import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeEvidenceInputsSha256,
  sha256File,
  validateEvidenceManifest,
} from '../../scripts/lib/evidence-integrity.mjs';
import {
  REPOSITORY_ROOT,
  TMP_ROOT,
  ensureDevDirectories,
} from '../../scripts/lib/dev-contract.mjs';

const inputFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'scripts/check-build.mjs',
  'scripts/evidence/dependency-review.snapshot.json',
  'scripts/evidence/generate-tier0.mjs',
  'scripts/evidence/refresh-dependency-review.mjs',
  'scripts/lib/build-integrity.mjs',
  'scripts/lib/evidence-integrity.mjs',
];
const temporaryRoots = [];
const fixtureValidationOptions = Object.freeze({ validateRepositoryContent: false });

async function writeJson(destination, value) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
}

async function createEvidenceFixture() {
  await ensureDevDirectories();
  const root = await mkdtemp(path.join(TMP_ROOT, 'evidence-integrity-'));
  temporaryRoots.push(root);
  for (const relativeFile of inputFiles) {
    const destination = path.join(root, relativeFile);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(REPOSITORY_ROOT, relativeFile)));
  }
  const inputsSha256 = await computeEvidenceInputsSha256(root);
  const buildBudgetPath = path.join(root, 'evidence', 'tier0', 'build-budget.json');
  const dependencyRegisterPath = path.join(root, 'evidence', 'tier0', 'dependency-register.json');
  await writeJson(buildBudgetPath, {
    schemaVersion: 2,
    project: '3d-websites-hackathon',
    command: 'pnpm run build',
    seed: null,
    buildContext: {},
    releaseManifest: {},
    artifacts: [{}],
  });
  await writeJson(dependencyRegisterPath, {
    schemaVersion: 2,
    project: '3d-websites-hackathon',
    command: 'pnpm run evidence:generate',
    seed: null,
    inputsDigestAlgorithm: 'sha256-path-nul-body-nul-v1',
    inputsSha256,
    review: {},
    dependencies: [{}],
  });
  const manifestPath = path.join(root, 'evidence', 'tier0', 'manifest.json');
  await writeJson(manifestPath, {
    schemaVersion: 1,
    project: '3d-websites-hackathon',
    command: 'pnpm run evidence:generate',
    seed: null,
    inputsDigestAlgorithm: 'sha256-path-nul-body-nul-v1',
    inputsSha256,
    artifacts: [
      {
        path: 'tier0/build-budget.json',
        sha256: await sha256File(buildBudgetPath),
      },
      {
        path: 'tier0/dependency-register.json',
        sha256: await sha256File(dependencyRegisterPath),
      },
    ],
  });
  return { root, manifestPath, buildBudgetPath };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('evidence manifest integrity', () => {
  it('requires the exact sorted artifact set rather than accepting a subset', async () => {
    const { root, manifestPath } = await createEvidenceFixture();
    await expect(validateEvidenceManifest(root, fixtureValidationOptions)).resolves.toMatchObject({
      manifest: { artifacts: [{ path: 'tier0/build-budget.json' }, {}] },
    });

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts = [manifest.artifacts[0]];
    await writeJson(manifestPath, manifest);
    await expect(validateEvidenceManifest(root, fixtureValidationOptions)).rejects.toThrow(
      'EVIDENCE_MANIFEST_INVALID_OR_STALE',
    );
  }, 30_000);

  it('validates artifact content after verifying its digest', async () => {
    const { root, manifestPath, buildBudgetPath } = await createEvidenceFixture();
    const buildBudget = JSON.parse(await readFile(buildBudgetPath, 'utf8'));
    buildBudget.schemaVersion = 1;
    await writeJson(buildBudgetPath, buildBudget);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts[0].sha256 = await sha256File(buildBudgetPath);
    await writeJson(manifestPath, manifest);
    await expect(validateEvidenceManifest(root, fixtureValidationOptions)).rejects.toThrow(
      'EVIDENCE_BUILD_BUDGET_SCHEMA_INVALID',
    );
  }, 30_000);

  it('rejects an unmanifested file in the tier0 evidence directory', async () => {
    const { root } = await createEvidenceFixture();
    await writeJson(path.join(root, 'evidence', 'tier0', 'orphan.json'), {
      forged: true,
    });
    await expect(validateEvidenceManifest(root, fixtureValidationOptions)).rejects.toThrow(
      'EVIDENCE_TIER0_FILE_SET_INVALID',
    );
  }, 30_000);
});
