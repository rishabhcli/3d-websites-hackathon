import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig, parseRuntimeConfig } from './runtimeConfig';

const valid = {
  MODE: 'test',
  BASE_URL: '/',
  DEV: true,
  PROD: false,
  SSR: false,
};

describe('runtime configuration boundary', () => {
  it('normalizes a valid configuration into an immutable domain value', () => {
    expect(parseRuntimeConfig(valid)).toEqual({
      baseUrl: '/',
      buildRef: 'working-tree',
      mode: 'test',
      surface: 'gallery',
    });
    expect(Object.isFrozen(parseRuntimeConfig(valid))).toBe(true);
  });

  it('refuses the server-side test runner environment at the browser boundary', () => {
    expect(() => loadRuntimeConfig()).toThrow('RUNTIME_CONFIG_INVALID');
  });

  it.each([
    { ...valid, DEV: false },
    { ...valid, PROD: true },
    { ...valid, BASE_URL: 'https://untrusted.example' },
    { ...valid, VITE_BUILD_REF: '<script>' },
    { ...valid, SSR: true },
  ])('refuses invalid configuration rather than degrading: %o', (candidate) => {
    expect(() => parseRuntimeConfig(candidate)).toThrow('RUNTIME_CONFIG_INVALID');
  });
});
