import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = '3d-websites-hackathon';
const buildContextFile = 'build-context.json';
const buildIntegrityFile = 'build-integrity.json';
const releaseManifestFile = 'release-manifest.json';
const sha256Pattern = /^[0-9a-f]{64}$/u;
const buildRefPattern = /^(?:working-tree|[0-9a-f]{7,40})$/u;
const knownViteEnvironmentKeys = Object.freeze(['VITE_BUILD_REF', 'VITE_RUNTIME_SURFACE']);
const shippedFontDependencies = Object.freeze([
  '@fontsource-variable/archivo',
  '@fontsource-variable/newsreader',
]);

const buildInputFiles = Object.freeze([
  '.node-version',
  '.nvmrc',
  'index.html',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/check-build.mjs',
  'scripts/lib/build-integrity.d.mts',
  'scripts/lib/build-integrity.mjs',
  'scripts/lib/dev-contract.mjs',
  'scripts/lib/evidence-integrity.mjs',
  'tsconfig.app.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.test.json',
  'vite.config.ts',
]);

function requireObject(value, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function assertExactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(code);
  }
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function exactCommandOutput(repositoryRoot, command, arguments_, code) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (
    result.error ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    result.stderr.length > 0
  ) {
    throw new Error(code);
  }
  return result.stdout.trim();
}

async function packageManagerVersionFromEnvironment() {
  const userAgent = process.env['npm_config_user_agent'];
  const executable = process.env['npm_execpath'];
  const match =
    typeof userAgent === 'string'
      ? /^pnpm\/(\d+\.\d+\.\d+) npm\/\S+ node\/v(\d+\.\d+\.\d+) (\S+) (\S+)$/u.exec(userAgent)
      : null;
  if (!match || typeof executable !== 'string' || executable.length === 0) {
    throw new Error('BUILD_PNPM_EXECUTION_CONTEXT_INVALID');
  }
  const actualExecutable = await realpath(executable);
  const actualPackageDirectory = path.dirname(path.dirname(actualExecutable));
  const packageManagerManifest = requireObject(
    JSON.parse(await readFile(path.join(actualPackageDirectory, 'package.json'), 'utf8')),
    'BUILD_PNPM_PACKAGE_MANIFEST_INVALID',
  );
  const packageManagerBins = requireObject(
    packageManagerManifest.bin,
    'BUILD_PNPM_PACKAGE_MANIFEST_INVALID',
  );
  const declaredExecutable = packageManagerBins.pnpm;
  if (
    packageManagerManifest.name !== 'pnpm' ||
    packageManagerManifest.version !== match[1] ||
    typeof declaredExecutable !== 'string' ||
    (await realpath(path.join(actualPackageDirectory, declaredExecutable))) !== actualExecutable ||
    match[2] !== process.versions.node ||
    match[3] !== process.platform ||
    match[4] !== process.arch
  ) {
    throw new Error('BUILD_PNPM_EXECUTION_CONTEXT_INVALID');
  }
  return match[1];
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isMissing(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function toPortableRelative(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function comparePortablePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateArtifactPath(value, code) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === '.' ||
    value === '..' ||
    value.startsWith('../') ||
    value.endsWith('/')
  ) {
    throw new Error(code);
  }
  return value;
}

async function assertDistributionRoot(repositoryRoot) {
  const repositoryRealPath = await realpath(repositoryRoot);
  const distributionRoot = path.join(repositoryRoot, 'dist');
  const metadata = await lstat(distributionRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('RELEASE_DISTRIBUTION_ROOT_INVALID');
  }
  const distributionRealPath = await realpath(distributionRoot);
  if (!distributionRealPath.startsWith(`${repositoryRealPath}${path.sep}`)) {
    throw new Error('RELEASE_DISTRIBUTION_ROOT_ESCAPES_REPOSITORY');
  }
  return { distributionRoot, distributionRealPath };
}

async function filesBelow(distributionRoot, currentDirectory = distributionRoot) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => comparePortablePaths(left.name, right.name))) {
    const absolute = path.join(currentDirectory, entry.name);
    const relative = toPortableRelative(path.relative(distributionRoot, absolute));
    validateArtifactPath(relative, `RELEASE_ARTIFACT_PATH_INVALID: ${relative}`);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`RELEASE_ARTIFACT_SYMLINK_FORBIDDEN: ${relative}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await filesBelow(distributionRoot, absolute)));
    } else if (metadata.isFile()) {
      files.push({ absolute, relative, metadata });
    } else {
      throw new Error(`RELEASE_ARTIFACT_TYPE_FORBIDDEN: ${relative}`);
    }
  }
  return files;
}

async function snapshotFile(file) {
  const body = await readFile(file.absolute);
  const after = await lstat(file.absolute);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.size !== file.metadata.size ||
    body.byteLength !== after.size
  ) {
    throw new Error(`RELEASE_ARTIFACT_CHANGED_DURING_READ: ${file.relative}`);
  }
  return {
    path: file.relative,
    bytes: body.byteLength,
    sha256: sha256(body),
  };
}

function parseToolchain(value) {
  const toolchain = requireObject(value, 'BUILD_TOOLCHAIN_INVALID');
  assertExactKeys(toolchain, ['nodeVersion', 'pnpmVersion'], 'BUILD_TOOLCHAIN_INVALID');
  if (
    typeof toolchain.nodeVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(toolchain.nodeVersion) ||
    typeof toolchain.pnpmVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(toolchain.pnpmVersion)
  ) {
    throw new Error('BUILD_TOOLCHAIN_INVALID');
  }
  return Object.freeze({
    nodeVersion: toolchain.nodeVersion,
    pnpmVersion: toolchain.pnpmVersion,
  });
}

function parseBuildProvenance(value) {
  const provenance = requireObject(value, 'BUILD_PROVENANCE_INVALID');
  assertExactKeys(
    provenance,
    ['toolchain', 'builderPlatform', 'sourceRevision'],
    'BUILD_PROVENANCE_INVALID',
  );
  const toolchain = parseToolchain(provenance.toolchain);
  const builderPlatform = requireObject(provenance.builderPlatform, 'BUILD_PROVENANCE_INVALID');
  const sourceRevision = requireObject(provenance.sourceRevision, 'BUILD_PROVENANCE_INVALID');
  assertExactKeys(builderPlatform, ['os', 'architecture'], 'BUILD_PROVENANCE_INVALID');
  assertExactKeys(sourceRevision, ['commit', 'dirty'], 'BUILD_PROVENANCE_INVALID');
  if (
    (builderPlatform.os !== 'darwin' && builderPlatform.os !== 'linux') ||
    (builderPlatform.architecture !== 'arm64' && builderPlatform.architecture !== 'x64') ||
    typeof sourceRevision.commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(sourceRevision.commit) ||
    typeof sourceRevision.dirty !== 'boolean'
  ) {
    throw new Error('BUILD_PROVENANCE_INVALID');
  }
  return Object.freeze({
    toolchain,
    builderPlatform: Object.freeze({
      os: builderPlatform.os,
      architecture: builderPlatform.architecture,
    }),
    sourceRevision: Object.freeze({
      commit: sourceRevision.commit,
      dirty: sourceRevision.dirty,
    }),
  });
}

export async function collectBuildProvenance(repositoryRoot) {
  const [nodeVersionPin, nvmVersionPin, packageJsonBody] = await Promise.all([
    readFile(path.join(repositoryRoot, '.node-version'), 'utf8'),
    readFile(path.join(repositoryRoot, '.nvmrc'), 'utf8'),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  ]);
  const packageJson = requireObject(JSON.parse(packageJsonBody), 'BUILD_PACKAGE_MANIFEST_INVALID');
  const nodeVersion = process.versions.node;
  const pnpmVersion = await packageManagerVersionFromEnvironment();
  if (
    nodeVersionPin.trim() !== nodeVersion ||
    nvmVersionPin.trim() !== nodeVersion ||
    packageJson.packageManager !== `pnpm@${pnpmVersion}` ||
    requireObject(packageJson.engines, 'BUILD_PACKAGE_ENGINES_INVALID').pnpm !== pnpmVersion
  ) {
    throw new Error('BUILD_TOOLCHAIN_DOES_NOT_MATCH_PINS');
  }
  const commit = exactCommandOutput(
    repositoryRoot,
    'git',
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    'BUILD_GIT_COMMIT_UNAVAILABLE',
  );
  const status = exactCommandOutput(
    repositoryRoot,
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    'BUILD_GIT_STATUS_UNAVAILABLE',
  );
  return parseBuildProvenance({
    toolchain: { nodeVersion, pnpmVersion },
    builderPlatform: { os: process.platform, architecture: process.arch },
    sourceRevision: { commit, dirty: status.length > 0 },
  });
}

function parseBuildBinding(value) {
  const binding = requireObject(value, 'BUILD_BINDING_INVALID');
  assertExactKeys(binding, ['toolchain', 'sourceInputDigest'], 'BUILD_BINDING_INVALID');
  if (
    typeof binding.sourceInputDigest !== 'string' ||
    !sha256Pattern.test(binding.sourceInputDigest)
  ) {
    throw new Error('BUILD_BINDING_INVALID');
  }
  return Object.freeze({
    toolchain: parseToolchain(binding.toolchain),
    sourceInputDigest: binding.sourceInputDigest,
  });
}

export function createProductionBuildContext(mode, environment = {}, bindingValue) {
  if (mode !== 'production') throw new Error(`BUILD_MODE_NOT_PRODUCTION: ${String(mode)}`);
  const source = requireObject(environment, 'BUILD_ENVIRONMENT_INVALID');
  const binding = parseBuildBinding(bindingValue);
  const unknownKeys = Object.keys(source)
    .filter((key) => key.startsWith('VITE_') && !knownViteEnvironmentKeys.includes(key))
    .sort();
  if (unknownKeys.length > 0) {
    throw new Error(`BUILD_ENVIRONMENT_UNKNOWN_VITE_KEYS: ${unknownKeys.join(',')}`);
  }
  const requestedBuildRef = source.VITE_BUILD_REF;
  const runtimeSurface = source.VITE_RUNTIME_SURFACE ?? 'gallery';
  if (
    requestedBuildRef !== undefined &&
    (typeof requestedBuildRef !== 'string' || !buildRefPattern.test(requestedBuildRef))
  ) {
    throw new Error('BUILD_ENVIRONMENT_BUILD_REF_INVALID');
  }
  if (runtimeSurface !== 'gallery' && runtimeSurface !== 'projection') {
    throw new Error('BUILD_ENVIRONMENT_RUNTIME_SURFACE_INVALID');
  }
  const buildRef = binding.sourceInputDigest.slice(0, 40);
  if (requestedBuildRef !== undefined && requestedBuildRef !== buildRef) {
    throw new Error('BUILD_ENVIRONMENT_BUILD_REF_OVERRIDE_FORBIDDEN');
  }
  return Object.freeze({
    schemaVersion: 2,
    project,
    mode: 'production',
    baseUrl: '/',
    nodeEnvironment: 'production',
    environment: Object.freeze({
      VITE_BUILD_REF: buildRef,
      VITE_RUNTIME_SURFACE: runtimeSurface,
    }),
    toolchain: binding.toolchain,
    buildTarget: Object.freeze({
      platform: 'browser',
      javascript: 'es2022',
    }),
    sourceInputDigest: binding.sourceInputDigest,
  });
}

export function parseProductionBuildContext(value) {
  const context = requireObject(value, 'BUILD_CONTEXT_INVALID');
  assertExactKeys(
    context,
    [
      'schemaVersion',
      'project',
      'mode',
      'baseUrl',
      'nodeEnvironment',
      'environment',
      'toolchain',
      'buildTarget',
      'sourceInputDigest',
    ],
    'BUILD_CONTEXT_INVALID',
  );
  const environment = requireObject(context.environment, 'BUILD_CONTEXT_INVALID');
  const binding = parseBuildBinding({
    toolchain: context.toolchain,
    sourceInputDigest: context.sourceInputDigest,
  });
  const buildTarget = requireObject(context.buildTarget, 'BUILD_CONTEXT_INVALID');
  assertExactKeys(environment, knownViteEnvironmentKeys, 'BUILD_CONTEXT_INVALID');
  assertExactKeys(buildTarget, ['platform', 'javascript'], 'BUILD_CONTEXT_INVALID');
  if (
    context.schemaVersion !== 2 ||
    context.project !== project ||
    context.mode !== 'production' ||
    context.baseUrl !== '/' ||
    context.nodeEnvironment !== 'production' ||
    buildTarget.platform !== 'browser' ||
    buildTarget.javascript !== 'es2022' ||
    typeof environment.VITE_BUILD_REF !== 'string' ||
    !buildRefPattern.test(environment.VITE_BUILD_REF) ||
    (environment.VITE_RUNTIME_SURFACE !== 'gallery' &&
      environment.VITE_RUNTIME_SURFACE !== 'projection')
  ) {
    throw new Error('BUILD_CONTEXT_INVALID');
  }
  return createProductionBuildContext(context.mode, environment, binding);
}

export function serializeProductionBuildContext(context) {
  return canonicalJson(parseProductionBuildContext(context));
}

async function readBuildContextArtifact(repositoryRoot) {
  const contextPath = path.join(repositoryRoot, 'dist', buildContextFile);
  const metadata = await lstat(contextPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('BUILD_CONTEXT_ARTIFACT_INVALID');
  }
  const raw = await readFile(contextPath, 'utf8');
  const context = parseProductionBuildContext(JSON.parse(raw));
  if (raw !== serializeProductionBuildContext(context)) {
    throw new Error('BUILD_CONTEXT_ARTIFACT_NOT_CANONICAL');
  }
  return { context, raw, sha256: sha256(raw) };
}

async function sourceFilesBelow(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => comparePortablePaths(left.name, right.name))) {
    const relative = path.join(relativeDirectory, entry.name);
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`BUILD_INPUT_SYMLINK_FORBIDDEN: ${relative}`);
    }
    if (metadata.isDirectory()) files.push(...(await sourceFilesBelow(root, relative)));
    else if (metadata.isFile()) files.push(relative);
    else throw new Error(`BUILD_INPUT_TYPE_FORBIDDEN: ${relative}`);
  }
  return files;
}

export async function computeBuildInputDigest(repositoryRoot) {
  const files = [...buildInputFiles, ...(await sourceFilesBelow(repositoryRoot, 'src'))].sort();
  const digest = createHash('sha256');
  for (const relativeFile of files) {
    const absolute = path.join(repositoryRoot, relativeFile);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`BUILD_INPUT_FILE_INVALID: ${relativeFile}`);
    }
    digest.update(toPortableRelative(relativeFile));
    digest.update('\0');
    digest.update(await readFile(absolute));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function parseBuildIntegrityStamp(value) {
  const stamp = requireObject(value, 'BUILD_INTEGRITY_STAMP_INVALID');
  assertExactKeys(
    stamp,
    ['schemaVersion', 'project', 'inputDigest', 'buildContextSha256', 'buildContext'],
    'BUILD_INTEGRITY_STAMP_INVALID',
  );
  const context = parseProductionBuildContext(stamp.buildContext);
  if (
    stamp.schemaVersion !== 2 ||
    stamp.project !== project ||
    typeof stamp.inputDigest !== 'string' ||
    !sha256Pattern.test(stamp.inputDigest) ||
    typeof stamp.buildContextSha256 !== 'string' ||
    !sha256Pattern.test(stamp.buildContextSha256)
  ) {
    throw new Error('BUILD_INTEGRITY_STAMP_INVALID');
  }
  return {
    schemaVersion: 2,
    project,
    inputDigest: stamp.inputDigest,
    buildContextSha256: stamp.buildContextSha256,
    buildContext: context,
  };
}

async function readBuildIntegrityStampDocument(repositoryRoot) {
  const stampPath = path.join(repositoryRoot, 'dist', buildIntegrityFile);
  const metadata = await lstat(stampPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('BUILD_INTEGRITY_STAMP_INVALID');
  }
  const raw = await readFile(stampPath, 'utf8');
  const stamp = parseBuildIntegrityStamp(JSON.parse(raw));
  if (raw !== canonicalJson(stamp)) throw new Error('BUILD_INTEGRITY_STAMP_NOT_CANONICAL');
  return stamp;
}

export async function writeBuildIntegrityStamp(repositoryRoot) {
  const destination = path.join(repositoryRoot, 'dist', buildIntegrityFile);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const contextArtifact = await readBuildContextArtifact(repositoryRoot);
  const actualProvenance = await collectBuildProvenance(repositoryRoot);
  const inputDigest = await computeBuildInputDigest(repositoryRoot);
  if (
    canonicalJson(contextArtifact.context.toolchain) !==
      canonicalJson(actualProvenance.toolchain) ||
    contextArtifact.context.sourceInputDigest !== inputDigest
  ) {
    throw new Error('BUILD_CONTEXT_PROVENANCE_CHANGED_DURING_BUILD');
  }
  const stamp = {
    schemaVersion: 2,
    project,
    inputDigest,
    buildContextSha256: contextArtifact.sha256,
    buildContext: contextArtifact.context,
  };
  await writeFile(temporary, canonicalJson(stamp), { mode: 0o600 });
  await rename(temporary, destination);
  return stamp;
}

function parseLicenseEntries(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('RELEASE_LICENSE_MANIFEST_INVALID');
  }
  const entries = value.map((candidate) => {
    const entry = requireObject(candidate, 'RELEASE_LICENSE_ENTRY_INVALID');
    assertExactKeys(
      entry,
      entry.text === undefined
        ? ['name', 'version', 'identifier']
        : ['name', 'version', 'identifier', 'text'],
      'RELEASE_LICENSE_ENTRY_INVALID',
    );
    if (
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      typeof entry.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(entry.version) ||
      typeof entry.identifier !== 'string' ||
      entry.identifier.length === 0 ||
      (entry.text !== undefined && typeof entry.text !== 'string')
    ) {
      throw new Error('RELEASE_LICENSE_ENTRY_INVALID');
    }
    return {
      name: entry.name,
      version: entry.version,
      identifier: entry.identifier,
      ...(entry.text === undefined ? {} : { text: entry.text }),
    };
  });
  const keys = entries.map(({ name, version }) => `${name}@${version}`);
  if (new Set(keys).size !== keys.length) throw new Error('RELEASE_LICENSE_ENTRY_DUPLICATE');
  return entries;
}

async function runtimeDependencyManifests(repositoryRoot) {
  const packageJson = requireObject(
    JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')),
    'RELEASE_PACKAGE_MANIFEST_INVALID',
  );
  const dependencies = requireObject(
    packageJson.dependencies,
    'RELEASE_RUNTIME_DEPENDENCIES_INVALID',
  );
  return Promise.all(
    Object.entries(dependencies)
      .sort(([left], [right]) => comparePortablePaths(left, right))
      .map(async ([name, version]) => {
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(version)) {
          throw new Error(`RELEASE_RUNTIME_DEPENDENCY_VERSION_INVALID: ${name}`);
        }
        const packageDirectory = path.join(repositoryRoot, 'node_modules', ...name.split('/'));
        const installed = requireObject(
          JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')),
          `RELEASE_INSTALLED_PACKAGE_INVALID: ${name}`,
        );
        if (
          installed.name !== name ||
          installed.version !== version ||
          typeof installed.license !== 'string' ||
          installed.license.length === 0
        ) {
          throw new Error(`RELEASE_INSTALLED_PACKAGE_MISMATCH: ${name}`);
        }
        return { name, version, license: installed.license, packageDirectory };
      }),
  );
}

async function validateEmittedFontAssets(repositoryRoot, dependencies) {
  const viteManifest = requireObject(
    JSON.parse(await readFile(path.join(repositoryRoot, 'dist', '.vite', 'manifest.json'), 'utf8')),
    'RELEASE_VITE_MANIFEST_INVALID',
  );
  const indexEntry = requireObject(viteManifest['index.html'], 'RELEASE_VITE_ENTRY_INVALID');
  if (!Array.isArray(indexEntry.assets)) throw new Error('RELEASE_VITE_ENTRY_ASSETS_INVALID');
  for (const dependency of dependencies.filter(({ name }) =>
    shippedFontDependencies.includes(name),
  )) {
    const locator = `${dependency.name.replace('/', '+')}@${dependency.version}`;
    const sourcePrefix = `node_modules/.pnpm/${locator}/node_modules/${dependency.name}/files/`;
    const emitted = Object.entries(viteManifest).filter(
      ([source, entry]) =>
        source.startsWith(sourcePrefix) &&
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.file === 'string' &&
        entry.file.endsWith('.woff2'),
    );
    if (emitted.length !== 1) {
      throw new Error(`RELEASE_FONT_ASSET_EMISSION_INVALID: ${dependency.name}`);
    }
    const emittedEntry = emitted[0]?.[1];
    if (
      typeof emittedEntry !== 'object' ||
      emittedEntry === null ||
      typeof emittedEntry.file !== 'string'
    ) {
      throw new Error(`RELEASE_FONT_ASSET_EMISSION_INVALID: ${dependency.name}`);
    }
    const emittedPath = validateArtifactPath(
      emittedEntry.file,
      `RELEASE_FONT_ASSET_PATH_INVALID: ${dependency.name}`,
    );
    if (indexEntry.assets.filter((candidate) => candidate === emittedPath).length !== 1) {
      throw new Error(`RELEASE_FONT_ASSET_NOT_REFERENCED: ${dependency.name}`);
    }
    const assetPath = path.join(repositoryRoot, 'dist', emittedPath);
    const metadata = await lstat(assetPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
      throw new Error(`RELEASE_FONT_ASSET_INVALID: ${dependency.name}`);
    }
  }
}

export async function completeReleaseLicenseManifest(repositoryRoot) {
  const licensePath = path.join(repositoryRoot, 'dist', 'third-party-licenses.json');
  const [entries, dependencies] = await Promise.all([
    readFile(licensePath, 'utf8').then((raw) => parseLicenseEntries(JSON.parse(raw))),
    runtimeDependencyManifests(repositoryRoot),
  ]);
  await validateEmittedFontAssets(repositoryRoot, dependencies);
  const byPackageVersion = new Map(
    entries.map((entry) => [`${entry.name}@${entry.version}`, entry]),
  );
  for (const dependency of dependencies.filter(({ name }) =>
    shippedFontDependencies.includes(name),
  )) {
    if (dependency.license !== 'OFL-1.1') {
      throw new Error(`RELEASE_FONT_LICENSE_IDENTIFIER_INVALID: ${dependency.name}`);
    }
    const text = (await readFile(path.join(dependency.packageDirectory, 'LICENSE'), 'utf8')).trim();
    if (!text.includes('SIL OPEN FONT LICENSE Version 1.1')) {
      throw new Error(`RELEASE_FONT_LICENSE_TEXT_INVALID: ${dependency.name}`);
    }
    byPackageVersion.set(`${dependency.name}@${dependency.version}`, {
      name: dependency.name,
      version: dependency.version,
      identifier: dependency.license,
      text,
    });
  }
  const completed = [...byPackageVersion.values()].sort((left, right) => {
    const byPackage = comparePortablePaths(left.name, right.name);
    return byPackage === 0 ? comparePortablePaths(left.version, right.version) : byPackage;
  });
  const temporary = `${licensePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, canonicalJson(completed), { mode: 0o600 });
  await rename(temporary, licensePath);
  return completed;
}

async function validateReleaseLicenseManifest(repositoryRoot) {
  const licensePath = path.join(repositoryRoot, 'dist', 'third-party-licenses.json');
  const [raw, dependencies] = await Promise.all([
    readFile(licensePath, 'utf8'),
    runtimeDependencyManifests(repositoryRoot),
  ]);
  const entries = parseLicenseEntries(JSON.parse(raw));
  const sortedEntries = [...entries].sort((left, right) => {
    const byPackage = comparePortablePaths(left.name, right.name);
    return byPackage === 0 ? comparePortablePaths(left.version, right.version) : byPackage;
  });
  if (raw !== canonicalJson(sortedEntries)) {
    throw new Error('RELEASE_LICENSE_MANIFEST_NOT_CANONICAL');
  }
  await validateEmittedFontAssets(repositoryRoot, dependencies);
  const byPackageVersion = new Map(
    entries.map((entry) => [`${entry.name}@${entry.version}`, entry]),
  );
  for (const dependency of dependencies) {
    const entry = byPackageVersion.get(`${dependency.name}@${dependency.version}`);
    if (!entry || entry.identifier !== dependency.license) {
      throw new Error(`RELEASE_RUNTIME_LICENSE_MISSING_OR_STALE: ${dependency.name}`);
    }
    if (
      shippedFontDependencies.includes(dependency.name) &&
      (typeof entry.text !== 'string' ||
        entry.text !==
          (await readFile(path.join(dependency.packageDirectory, 'LICENSE'), 'utf8')).trim())
    ) {
      throw new Error(`RELEASE_FONT_LICENSE_TEXT_MISSING: ${dependency.name}`);
    }
  }
}

function parseReleaseArtifact(value) {
  const artifact = requireObject(value, 'RELEASE_MANIFEST_ARTIFACT_INVALID');
  assertExactKeys(artifact, ['path', 'bytes', 'sha256'], 'RELEASE_MANIFEST_ARTIFACT_INVALID');
  const artifactPath = validateArtifactPath(
    artifact.path,
    'RELEASE_MANIFEST_ARTIFACT_PATH_INVALID',
  );
  if (
    artifactPath === releaseManifestFile ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 0 ||
    typeof artifact.sha256 !== 'string' ||
    !sha256Pattern.test(artifact.sha256)
  ) {
    throw new Error('RELEASE_MANIFEST_ARTIFACT_INVALID');
  }
  return { path: artifactPath, bytes: artifact.bytes, sha256: artifact.sha256 };
}

function parseReleaseManifest(value) {
  const manifest = requireObject(value, 'RELEASE_MANIFEST_INVALID');
  assertExactKeys(
    manifest,
    ['schemaVersion', 'project', 'buildInputDigest', 'buildContextSha256', 'artifacts'],
    'RELEASE_MANIFEST_INVALID',
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.project !== project ||
    typeof manifest.buildInputDigest !== 'string' ||
    !sha256Pattern.test(manifest.buildInputDigest) ||
    typeof manifest.buildContextSha256 !== 'string' ||
    !sha256Pattern.test(manifest.buildContextSha256) ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0
  ) {
    throw new Error('RELEASE_MANIFEST_INVALID');
  }
  const artifacts = manifest.artifacts.map(parseReleaseArtifact);
  const sortedPaths = artifacts.map((artifact) => artifact.path).sort(comparePortablePaths);
  if (
    new Set(sortedPaths).size !== sortedPaths.length ||
    artifacts.some((artifact, index) => artifact.path !== sortedPaths[index])
  ) {
    throw new Error('RELEASE_MANIFEST_ARTIFACT_ORDER_INVALID');
  }
  return {
    schemaVersion: 1,
    project,
    buildInputDigest: manifest.buildInputDigest,
    buildContextSha256: manifest.buildContextSha256,
    artifacts,
  };
}

async function readReleaseManifest(repositoryRoot) {
  const manifestPath = path.join(repositoryRoot, 'dist', releaseManifestFile);
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('RELEASE_MANIFEST_INVALID');
  }
  const raw = await readFile(manifestPath, 'utf8');
  const manifest = parseReleaseManifest(JSON.parse(raw));
  if (raw !== canonicalJson(manifest)) throw new Error('RELEASE_MANIFEST_NOT_CANONICAL');
  return { manifest, manifestPath, raw };
}

export async function snapshotDistributionArtifacts(
  repositoryRoot,
  { includeReleaseManifest = true } = {},
) {
  if (typeof includeReleaseManifest !== 'boolean') {
    throw new Error('RELEASE_SNAPSHOT_OPTION_INVALID');
  }
  const { distributionRoot } = await assertDistributionRoot(repositoryRoot);
  const files = await filesBelow(distributionRoot);
  const selected = files.filter(
    ({ relative }) => includeReleaseManifest || relative !== releaseManifestFile,
  );
  return Promise.all(
    selected
      .sort((left, right) => comparePortablePaths(left.relative, right.relative))
      .map(snapshotFile),
  );
}

export async function writeReleaseManifest(repositoryRoot) {
  const { distributionRoot } = await assertDistributionRoot(repositoryRoot);
  const destination = path.join(distributionRoot, releaseManifestFile);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('RELEASE_MANIFEST_DESTINATION_INVALID');
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const [stamp, artifacts] = await Promise.all([
    readBuildIntegrityStampDocument(repositoryRoot),
    snapshotDistributionArtifacts(repositoryRoot, { includeReleaseManifest: false }),
  ]);
  const manifest = {
    schemaVersion: 1,
    project,
    buildInputDigest: stamp.inputDigest,
    buildContextSha256: stamp.buildContextSha256,
    artifacts,
  };
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, canonicalJson(manifest), { mode: 0o600 });
  await rename(temporary, destination);
  return manifest;
}

export async function validateReleaseArtifacts(
  repositoryRoot,
  { validateInputs = true, validateLicenses = true } = {},
) {
  if (typeof validateInputs !== 'boolean' || typeof validateLicenses !== 'boolean') {
    throw new Error('RELEASE_VALIDATION_OPTION_INVALID');
  }
  await assertDistributionRoot(repositoryRoot);
  const [{ manifest, manifestPath, raw }, currentArtifacts, stamp, contextArtifact] =
    await Promise.all([
      readReleaseManifest(repositoryRoot),
      snapshotDistributionArtifacts(repositoryRoot, { includeReleaseManifest: false }),
      readBuildIntegrityStampDocument(repositoryRoot),
      readBuildContextArtifact(repositoryRoot),
    ]);
  const expectedPaths = manifest.artifacts.map((artifact) => artifact.path);
  const currentPaths = currentArtifacts.map((artifact) => artifact.path);
  if (
    expectedPaths.length !== currentPaths.length ||
    expectedPaths.some((artifactPath, index) => artifactPath !== currentPaths[index])
  ) {
    throw new Error(
      `RELEASE_ARTIFACT_FILE_SET_MISMATCH: expected=${expectedPaths.join(',')} current=${currentPaths.join(',')}`,
    );
  }
  for (let index = 0; index < manifest.artifacts.length; index += 1) {
    const expected = manifest.artifacts[index];
    const current = currentArtifacts[index];
    if (
      !expected ||
      !current ||
      expected.path !== current.path ||
      expected.bytes !== current.bytes ||
      expected.sha256 !== current.sha256
    ) {
      throw new Error(`RELEASE_ARTIFACT_DIGEST_MISMATCH: ${expected?.path ?? '<unknown>'}`);
    }
  }
  if (
    manifest.buildInputDigest !== stamp.inputDigest ||
    manifest.buildContextSha256 !== stamp.buildContextSha256 ||
    stamp.buildContext.sourceInputDigest !== stamp.inputDigest ||
    stamp.buildContext.environment.VITE_BUILD_REF !== stamp.inputDigest.slice(0, 40) ||
    stamp.buildContextSha256 !== contextArtifact.sha256 ||
    canonicalJson(stamp.buildContext) !== canonicalJson(contextArtifact.context)
  ) {
    throw new Error('RELEASE_BUILD_BINDING_MISMATCH');
  }
  if (validateInputs && stamp.inputDigest !== (await computeBuildInputDigest(repositoryRoot))) {
    throw new Error('RELEASE_BUILD_INPUTS_STALE');
  }
  if (validateLicenses) await validateReleaseLicenseManifest(repositoryRoot);
  return {
    manifest,
    manifestPath,
    manifestBytes: Buffer.byteLength(raw),
    manifestSha256: sha256(raw),
    stamp,
    buildContext: contextArtifact.context,
    artifacts: currentArtifacts,
  };
}

export async function readBuildIntegrityStamp(repositoryRoot) {
  const { stamp } = await validateReleaseArtifacts(repositoryRoot);
  return stamp;
}
