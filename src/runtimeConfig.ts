import { z } from 'zod';

const runtimeConfigSchema = z
  .object({
    MODE: z.enum(['development', 'production', 'test']),
    BASE_URL: z.string().startsWith('/'),
    DEV: z.boolean(),
    PROD: z.boolean(),
    SSR: z.literal(false),
    VITE_BUILD_REF: z
      .string()
      .regex(/^(?:working-tree|[0-9a-f]{7,40})$/u)
      .default('working-tree'),
    VITE_RUNTIME_SURFACE: z.enum(['gallery', 'projection']).default('gallery'),
  })
  .superRefine((value, context) => {
    if (value.DEV === value.PROD) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one of DEV or PROD must be true',
        path: ['DEV'],
      });
    }
  });

export interface RuntimeConfig {
  readonly baseUrl: string;
  readonly buildRef: string;
  readonly mode: 'development' | 'production' | 'test';
  readonly surface: 'gallery' | 'projection';
}

export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  const parsed = runtimeConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`RUNTIME_CONFIG_INVALID: ${z.prettifyError(parsed.error)}`);
  }
  return Object.freeze({
    baseUrl: parsed.data.BASE_URL,
    buildRef: parsed.data.VITE_BUILD_REF,
    mode: parsed.data.MODE,
    surface: parsed.data.VITE_RUNTIME_SURFACE,
  });
}

export function loadRuntimeConfig(): RuntimeConfig {
  return parseRuntimeConfig({
    MODE: import.meta.env.MODE,
    BASE_URL: import.meta.env.BASE_URL,
    DEV: import.meta.env.DEV,
    PROD: import.meta.env.PROD,
    SSR: import.meta.env.SSR,
    VITE_BUILD_REF: import.meta.env.VITE_BUILD_REF,
    VITE_RUNTIME_SURFACE: import.meta.env.VITE_RUNTIME_SURFACE,
  });
}
