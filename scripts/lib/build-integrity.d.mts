export interface ProductionBuildContext {
  readonly schemaVersion: 2;
  readonly project: '3d-websites-hackathon';
  readonly mode: 'production';
  readonly baseUrl: '/';
  readonly nodeEnvironment: 'production';
  readonly environment: Readonly<{
    VITE_BUILD_REF: string;
    VITE_RUNTIME_SURFACE: 'gallery' | 'projection';
  }>;
  readonly toolchain: Readonly<{
    nodeVersion: string;
    pnpmVersion: string;
  }>;
  readonly buildTarget: Readonly<{
    platform: 'browser';
    javascript: 'es2022';
  }>;
  readonly sourceInputDigest: string;
}

export type BuildBinding = Pick<ProductionBuildContext, 'toolchain' | 'sourceInputDigest'>;

export interface BuildProvenance {
  readonly toolchain: ProductionBuildContext['toolchain'];
  readonly builderPlatform: Readonly<{
    os: 'darwin' | 'linux';
    architecture: 'arm64' | 'x64';
  }>;
  readonly sourceRevision: Readonly<{
    commit: string;
    dirty: boolean;
  }>;
}

export interface ReleaseArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BuildIntegrityStamp {
  readonly schemaVersion: 2;
  readonly project: '3d-websites-hackathon';
  readonly inputDigest: string;
  readonly buildContextSha256: string;
  readonly buildContext: ProductionBuildContext;
}

export interface ReleaseValidation {
  readonly manifest: {
    readonly schemaVersion: 1;
    readonly project: '3d-websites-hackathon';
    readonly buildInputDigest: string;
    readonly buildContextSha256: string;
    readonly artifacts: readonly ReleaseArtifact[];
  };
  readonly manifestPath: string;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly stamp: BuildIntegrityStamp;
  readonly buildContext: ProductionBuildContext;
  readonly artifacts: readonly ReleaseArtifact[];
}

export function createProductionBuildContext(
  mode: string,
  environment?: Readonly<Record<string, string>>,
  binding?: BuildBinding,
): ProductionBuildContext;
export function collectBuildProvenance(repositoryRoot: string): Promise<BuildProvenance>;
export function parseProductionBuildContext(value: unknown): ProductionBuildContext;
export function serializeProductionBuildContext(context: ProductionBuildContext): string;
export function computeBuildInputDigest(repositoryRoot: string): Promise<string>;
export function writeBuildIntegrityStamp(repositoryRoot: string): Promise<BuildIntegrityStamp>;
export function completeReleaseLicenseManifest(repositoryRoot: string): Promise<
  readonly Readonly<{
    name: string;
    version: string;
    identifier: string;
    text?: string;
  }>[]
>;
export function readBuildIntegrityStamp(repositoryRoot: string): Promise<BuildIntegrityStamp>;
export function snapshotDistributionArtifacts(
  repositoryRoot: string,
  options?: Readonly<{ includeReleaseManifest?: boolean }>,
): Promise<ReleaseArtifact[]>;
export function writeReleaseManifest(
  repositoryRoot: string,
): Promise<ReleaseValidation['manifest']>;
export function validateReleaseArtifacts(
  repositoryRoot: string,
  options?: Readonly<{ validateInputs?: boolean; validateLicenses?: boolean }>,
): Promise<ReleaseValidation>;
