interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  readonly VITE_BUILD_REF?: string;
  readonly VITE_RUNTIME_SURFACE?: string;
}
