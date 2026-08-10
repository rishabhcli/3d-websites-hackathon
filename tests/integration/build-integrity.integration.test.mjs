import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeReleaseLicenseManifest,
  createProductionBuildContext,
  serializeProductionBuildContext,
  snapshotDistributionArtifacts,
  validateReleaseArtifacts,
  writeReleaseManifest,
} from '../../scripts/lib/build-integrity.mjs';
import { TMP_ROOT, ensureDevDirectories } from '../../scripts/lib/dev-contract.mjs';

const temporaryRoots = [];
const buildBinding = {
  toolchain: { nodeVersion: '24.19.0', pnpmVersion: '11.20.0' },
  sourceInputDigest: 'b'.repeat(64),
};
const fixtureValidationOptions = Object.freeze({
  validateInputs: false,
  validateLicenses: false,
});

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

async function createReleaseFixture() {
  await ensureDevDirectories();
  const root = await mkdtemp(path.join(TMP_ROOT, 'release-integrity-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'dist', 'assets'), { recursive: true });
  const context = createProductionBuildContext(
    'production',
    { VITE_RUNTIME_SURFACE: 'gallery' },
    buildBinding,
  );
  const contextBody = serializeProductionBuildContext(context);
  await writeFile(path.join(root, 'dist', 'build-context.json'), contextBody);
  await writeFile(
    path.join(root, 'dist', 'build-integrity.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        project: '3d-websites-hackathon',
        inputDigest: 'b'.repeat(64),
        buildContextSha256: sha256(contextBody),
        buildContext: context,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(root, 'dist', 'index.html'), '<!doctype html>\n');
  await writeFile(path.join(root, 'dist', 'assets', 'app.js'), 'export const ready = true;\n');
  await writeReleaseManifest(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('production build context', () => {
  it('normalizes and binds the exact supported production environment', () => {
    expect(
      createProductionBuildContext(
        'production',
        {
          VITE_RUNTIME_SURFACE: 'projection',
        },
        buildBinding,
      ),
    ).toEqual({
      schemaVersion: 2,
      project: '3d-websites-hackathon',
      mode: 'production',
      baseUrl: '/',
      nodeEnvironment: 'production',
      environment: {
        VITE_BUILD_REF: 'b'.repeat(40),
        VITE_RUNTIME_SURFACE: 'projection',
      },
      toolchain: { nodeVersion: '24.19.0', pnpmVersion: '11.20.0' },
      buildTarget: { platform: 'browser', javascript: 'es2022' },
      sourceInputDigest: 'b'.repeat(64),
    });
  });

  it('fails closed for another mode, invalid values, or unbound VITE variables', () => {
    expect(() => createProductionBuildContext('staging')).toThrow('BUILD_MODE_NOT_PRODUCTION');
    expect(() =>
      createProductionBuildContext('production', { VITE_BUILD_REF: '<script>' }, buildBinding),
    ).toThrow('BUILD_ENVIRONMENT_BUILD_REF_INVALID');
    expect(() =>
      createProductionBuildContext('production', { VITE_UNBOUND_VALUE: 'unsafe' }, buildBinding),
    ).toThrow('BUILD_ENVIRONMENT_UNKNOWN_VITE_KEYS');
    expect(() =>
      createProductionBuildContext('production', { VITE_BUILD_REF: 'abcdef0' }, buildBinding),
    ).toThrow('BUILD_ENVIRONMENT_BUILD_REF_OVERRIDE_FORBIDDEN');
  });
});

describe('release artifact manifest', () => {
  it('covers the exact regular-file set except for the manifest itself', async () => {
    const root = await createReleaseFixture();
    const validation = await validateReleaseArtifacts(root, fixtureValidationOptions);
    expect(validation.manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      'assets/app.js',
      'build-context.json',
      'build-integrity.json',
      'index.html',
    ]);
    expect((await snapshotDistributionArtifacts(root)).map((artifact) => artifact.path)).toEqual([
      'assets/app.js',
      'build-context.json',
      'build-integrity.json',
      'index.html',
      'release-manifest.json',
    ]);
  });

  it('rejects tampered, unexpected, and missing artifacts', async () => {
    const root = await createReleaseFixture();
    const applicationPath = path.join(root, 'dist', 'assets', 'app.js');
    await writeFile(applicationPath, 'export const ready = false;\n');
    await expect(validateReleaseArtifacts(root, fixtureValidationOptions)).rejects.toThrow(
      'RELEASE_ARTIFACT_DIGEST_MISMATCH',
    );

    await writeFile(applicationPath, 'export const ready = true;\n');
    await writeFile(path.join(root, 'dist', 'unexpected.txt'), 'unexpected\n');
    await expect(validateReleaseArtifacts(root, fixtureValidationOptions)).rejects.toThrow(
      'RELEASE_ARTIFACT_FILE_SET_MISMATCH',
    );

    await unlink(path.join(root, 'dist', 'unexpected.txt'));
    await unlink(applicationPath);
    await expect(validateReleaseArtifacts(root, fixtureValidationOptions)).rejects.toThrow(
      'RELEASE_ARTIFACT_FILE_SET_MISMATCH',
    );
  });

  it('rejects symlinks and manifest traversal paths', async () => {
    const root = await createReleaseFixture();
    await symlink(
      path.join(root, 'dist', 'index.html'),
      path.join(root, 'dist', 'assets', 'linked.js'),
    );
    await expect(validateReleaseArtifacts(root, fixtureValidationOptions)).rejects.toThrow(
      'RELEASE_ARTIFACT_SYMLINK_FORBIDDEN',
    );

    await unlink(path.join(root, 'dist', 'assets', 'linked.js'));
    const manifestPath = path.join(root, 'dist', 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts[0].path = '../escape.js';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(validateReleaseArtifacts(root, fixtureValidationOptions)).rejects.toThrow(
      'RELEASE_MANIFEST_ARTIFACT_PATH_INVALID',
    );
  });

  it('adds and validates both emitted Fontsource OFL notices independently', async () => {
    const root = await createReleaseFixture();
    const fontDependencies = [
      {
        name: '@fontsource-variable/archivo',
        version: '5.3.0',
        asset: 'assets/archivo.woff2',
        licenseText: 'Archivo attribution\n\nSIL OPEN FONT LICENSE Version 1.1',
      },
      {
        name: '@fontsource-variable/newsreader',
        version: '5.3.0',
        asset: 'assets/newsreader.woff2',
        licenseText: 'Newsreader attribution\n\nSIL OPEN FONT LICENSE Version 1.1',
      },
    ];
    await writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify(
        {
          dependencies: Object.fromEntries(
            fontDependencies.map(({ name, version }) => [name, version]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    const viteManifest = {
      'index.html': {
        file: 'assets/app.js',
        isEntry: true,
        assets: fontDependencies.map(({ asset }) => asset),
      },
    };
    for (const dependency of fontDependencies) {
      const packageDirectory = path.join(root, 'node_modules', ...dependency.name.split('/'));
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        path.join(packageDirectory, 'package.json'),
        `${JSON.stringify({
          name: dependency.name,
          version: dependency.version,
          license: 'OFL-1.1',
        })}\n`,
      );
      await writeFile(path.join(packageDirectory, 'LICENSE'), `${dependency.licenseText}\n`);
      await writeFile(path.join(root, 'dist', dependency.asset), dependency.name);
      viteManifest[
        `node_modules/.pnpm/${dependency.name.replace('/', '+')}@${dependency.version}/node_modules/${dependency.name}/files/${path.basename(dependency.asset)}`
      ] = { file: dependency.asset };
    }
    await mkdir(path.join(root, 'dist', '.vite'), { recursive: true });
    await writeFile(
      path.join(root, 'dist', '.vite', 'manifest.json'),
      `${JSON.stringify(viteManifest, null, 2)}\n`,
    );
    await writeFile(
      path.join(root, 'dist', 'third-party-licenses.json'),
      `${JSON.stringify([{ name: 'transitive', version: '1.0.0', identifier: 'MIT' }], null, 2)}\n`,
    );

    await expect(completeReleaseLicenseManifest(root)).resolves.toEqual(
      expect.arrayContaining(
        fontDependencies.map((dependency) => ({
          name: dependency.name,
          version: dependency.version,
          identifier: 'OFL-1.1',
          text: dependency.licenseText,
        })),
      ),
    );
    await writeReleaseManifest(root);
    await expect(validateReleaseArtifacts(root, { validateInputs: false })).resolves.toMatchObject({
      manifest: { project: '3d-websites-hackathon' },
    });

    const licensesPath = path.join(root, 'dist', 'third-party-licenses.json');
    const licenses = JSON.parse(await readFile(licensesPath, 'utf8'));
    await writeFile(
      licensesPath,
      `${JSON.stringify(
        licenses.filter(({ name }) => name !== '@fontsource-variable/newsreader'),
        null,
        2,
      )}\n`,
    );
    await writeReleaseManifest(root);
    await expect(validateReleaseArtifacts(root, { validateInputs: false })).rejects.toThrow(
      'RELEASE_RUNTIME_LICENSE_MISSING_OR_STALE',
    );
  });
});
