import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateReleaseArtifacts } from './lib/build-integrity.mjs';
import { PROJECT_NAME, REPOSITORY_ROOT, REPORT_ROOT } from './lib/dev-contract.mjs';

const sbomPath = path.join(REPORT_ROOT, 'sbom.cdx.json');
const packageManifest = JSON.parse(
  await readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
);
const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));

function requireObject(value, code) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameSortedStrings(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort(compareStrings);
  const expectedSorted = [...expected].sort(compareStrings);
  return actualSorted.every((value, index) => value === expectedSorted[index]);
}

function npmIdentity(name, version) {
  if (
    typeof name !== 'string' ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) ||
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(version)
  ) {
    throw new Error(`SBOM_RUNTIME_DEPENDENCY_NOT_PINNED: ${String(name)}`);
  }
  if (name.startsWith('@')) {
    const [group, componentName] = name.split('/');
    if (!group || !componentName) throw new Error(`SBOM_PACKAGE_NAME_INVALID: ${name}`);
    return {
      name,
      group,
      componentName,
      version,
      purl: `pkg:npm/%40${group.slice(1)}/${componentName}@${version}`,
    };
  }
  return {
    name,
    group: undefined,
    componentName: name,
    version,
    purl: `pkg:npm/${name}@${version}`,
  };
}

const packageObject = requireObject(packageManifest, 'SBOM_PACKAGE_MANIFEST_INVALID');
const runtimeDependencies = Object.entries(
  requireObject(packageObject.dependencies, 'SBOM_RUNTIME_DEPENDENCIES_INVALID'),
)
  .map(([name, version]) => npmIdentity(name, version))
  .sort((left, right) => compareStrings(left.name, right.name));
if (runtimeDependencies.length === 0) throw new Error('SBOM_RUNTIME_DEPENDENCIES_EMPTY');

for (const dependency of runtimeDependencies) {
  const installed = requireObject(
    JSON.parse(
      await readFile(
        path.join(REPOSITORY_ROOT, 'node_modules', ...dependency.name.split('/'), 'package.json'),
        'utf8',
      ),
    ),
    `SBOM_INSTALLED_PACKAGE_INVALID: ${dependency.name}`,
  );
  if (
    installed.name !== dependency.name ||
    installed.version !== dependency.version ||
    typeof installed.license !== 'string' ||
    installed.license.length === 0
  ) {
    throw new Error(`SBOM_INSTALLED_PACKAGE_MISMATCH: ${dependency.name}`);
  }
  dependency.license = installed.license;
}

const sbomObject = requireObject(sbom, 'SBOM_INVALID');
const metadata = requireObject(sbomObject.metadata, 'SBOM_METADATA_INVALID');
const rootComponent = requireObject(metadata.component, 'SBOM_ROOT_COMPONENT_INVALID');
const packageVersion = packageObject.version;
const rootPurl = `pkg:npm/${PROJECT_NAME}@${packageVersion}`;
if (
  sbomObject.bomFormat !== 'CycloneDX' ||
  sbomObject.specVersion !== '1.7' ||
  packageObject.name !== PROJECT_NAME ||
  typeof packageVersion !== 'string' ||
  rootComponent.type !== 'application' ||
  rootComponent.name !== PROJECT_NAME ||
  rootComponent.version !== packageVersion ||
  rootComponent.purl !== rootPurl ||
  rootComponent['bom-ref'] !== rootPurl ||
  !Array.isArray(sbomObject.components) ||
  sbomObject.components.length === 0 ||
  !Array.isArray(sbomObject.dependencies)
) {
  throw new Error('SBOM_INVALID: expected the pinned CycloneDX 1.7 application document');
}

const componentsByPurl = new Map();
for (const candidate of sbomObject.components) {
  const component = requireObject(candidate, 'SBOM_COMPONENT_INVALID');
  if (
    component.type !== 'library' ||
    typeof component.purl !== 'string' ||
    component.purl.length === 0 ||
    component['bom-ref'] !== component.purl ||
    componentsByPurl.has(component.purl) ||
    !Array.isArray(component.licenses) ||
    component.licenses.length === 0
  ) {
    throw new Error('SBOM_COMPONENT_INVALID_OR_DUPLICATE');
  }
  componentsByPurl.set(component.purl, component);
}

for (const dependency of runtimeDependencies) {
  const component = componentsByPurl.get(dependency.purl);
  if (
    !component ||
    component.group !== dependency.group ||
    component.name !== dependency.componentName ||
    component.version !== dependency.version
  ) {
    throw new Error(`SBOM_RUNTIME_COMPONENT_MISSING_OR_STALE: ${dependency.name}`);
  }
  const licenseIdentifiers = component.licenses.map((candidate) => {
    const wrapper = requireObject(candidate, `SBOM_LICENSE_INVALID: ${dependency.name}`);
    const license = requireObject(wrapper.license, `SBOM_LICENSE_INVALID: ${dependency.name}`);
    if (typeof license.id !== 'string' || license.id.length === 0) {
      throw new Error(`SBOM_LICENSE_INVALID: ${dependency.name}`);
    }
    return license.id;
  });
  if (
    new Set(licenseIdentifiers).size !== licenseIdentifiers.length ||
    !licenseIdentifiers.includes(dependency.license)
  ) {
    throw new Error(`SBOM_RUNTIME_LICENSE_MISSING_OR_STALE: ${dependency.name}`);
  }
}

const graphByReference = new Map();
for (const candidate of sbomObject.dependencies) {
  const graphEntry = requireObject(candidate, 'SBOM_DEPENDENCY_GRAPH_INVALID');
  if (
    typeof graphEntry.ref !== 'string' ||
    !Array.isArray(graphEntry.dependsOn) ||
    !graphEntry.dependsOn.every((reference) => typeof reference === 'string') ||
    graphByReference.has(graphEntry.ref) ||
    new Set(graphEntry.dependsOn).size !== graphEntry.dependsOn.length
  ) {
    throw new Error('SBOM_DEPENDENCY_GRAPH_INVALID_OR_DUPLICATE');
  }
  graphByReference.set(graphEntry.ref, graphEntry.dependsOn);
}
const validGraphReferences = new Set([rootPurl, ...componentsByPurl.keys()]);
if (
  graphByReference.size !== validGraphReferences.size ||
  [...validGraphReferences].some((reference) => !graphByReference.has(reference)) ||
  [...graphByReference].some(
    ([reference, dependencies]) =>
      !validGraphReferences.has(reference) ||
      dependencies.some((dependency) => !componentsByPurl.has(dependency)),
  )
) {
  throw new Error('SBOM_DEPENDENCY_GRAPH_DANGLING_OR_INCOMPLETE');
}
const rootDependencies = graphByReference.get(rootPurl);
const directRuntimePurls = runtimeDependencies.map(({ purl }) => purl);
if (!rootDependencies || !sameSortedStrings(rootDependencies, directRuntimePurls)) {
  throw new Error('SBOM_ROOT_DEPENDENCY_SET_MISMATCH');
}

const release = await validateReleaseArtifacts(REPOSITORY_ROOT);
const releasePaths = new Set(release.artifacts.map((artifact) => artifact.path));
for (const requiredPath of ['.vite/manifest.json', 'third-party-licenses.json']) {
  if (!releasePaths.has(requiredPath))
    throw new Error(`SBOM_RELEASE_ARTIFACT_MISSING: ${requiredPath}`);
}
const viteManifest = requireObject(
  JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'dist', '.vite', 'manifest.json'), 'utf8')),
  'SBOM_VITE_MANIFEST_INVALID',
);
const releaseLicenses = JSON.parse(
  await readFile(path.join(REPOSITORY_ROOT, 'dist', 'third-party-licenses.json'), 'utf8'),
);
if (!Array.isArray(releaseLicenses)) throw new Error('SBOM_RELEASE_LICENSES_INVALID');
const releaseLicensesByPackage = new Map();
for (const candidate of releaseLicenses) {
  const entry = requireObject(candidate, 'SBOM_RELEASE_LICENSE_ENTRY_INVALID');
  const key = `${String(entry.name)}@${String(entry.version)}`;
  if (releaseLicensesByPackage.has(key)) throw new Error('SBOM_RELEASE_LICENSE_ENTRY_DUPLICATE');
  releaseLicensesByPackage.set(key, entry);
}
for (const dependency of runtimeDependencies) {
  const releaseLicense = releaseLicensesByPackage.get(`${dependency.name}@${dependency.version}`);
  if (!releaseLicense || releaseLicense.identifier !== dependency.license) {
    throw new Error(`SBOM_RELEASE_LICENSE_MISSING_OR_STALE: ${dependency.name}`);
  }
  if (!dependency.name.startsWith('@fontsource-variable/')) continue;
  const installedLicenseText = (
    await readFile(
      path.join(REPOSITORY_ROOT, 'node_modules', ...dependency.name.split('/'), 'LICENSE'),
      'utf8',
    )
  ).trim();
  if (releaseLicense.text !== installedLicenseText || dependency.license !== 'OFL-1.1') {
    throw new Error(`SBOM_RELEASE_FONT_LICENSE_INVALID: ${dependency.name}`);
  }
  const sourcePrefix = `node_modules/.pnpm/${dependency.name.replace('/', '+')}@${dependency.version}/node_modules/${dependency.name}/files/`;
  const emittedFontEntries = Object.entries(viteManifest).filter(
    ([source, entry]) =>
      source.startsWith(sourcePrefix) &&
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.file === 'string' &&
      entry.file.endsWith('.woff2'),
  );
  if (emittedFontEntries.length !== 1) {
    throw new Error(`SBOM_RELEASE_FONT_ASSET_INVALID: ${dependency.name}`);
  }
  const emittedPath = emittedFontEntries[0]?.[1]?.file;
  if (typeof emittedPath !== 'string' || !releasePaths.has(emittedPath)) {
    throw new Error(`SBOM_RELEASE_FONT_ASSET_UNMANIFESTED: ${dependency.name}`);
  }
}

console.log(
  `sbom ok — ${sbomObject.components.length} production components; ${runtimeDependencies.length} exact runtime dependencies and release licenses/assets reconciled at ${sbomPath}`,
);
