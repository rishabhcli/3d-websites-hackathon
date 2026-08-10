export const CALIBRATION_SEED = 0x3d20_2608;
export const MIN_FRAGMENT_COUNT = 64;
export const MAX_FRAGMENT_COUNT = 1_200;

export type FragmentPosition = readonly [x: number, y: number, z: number];

export interface StaticFragmentSet {
  readonly schemaVersion: 1;
  readonly seed: number;
  readonly fragments: readonly FragmentPosition[];
}

function nextRandom(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1_664_525) + 1_013_904_223) >>> 0;
  return state.value / 0x1_0000_0000;
}

export function createCalibrationFragments(seed: number, count: number): StaticFragmentSet {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError('seed must be an unsigned 32-bit integer');
  }
  if (!Number.isSafeInteger(count) || count < MIN_FRAGMENT_COUNT || count > MAX_FRAGMENT_COUNT) {
    throw new RangeError(
      `fragment count must be an integer between ${String(MIN_FRAGMENT_COUNT)} and ${String(MAX_FRAGMENT_COUNT)}`,
    );
  }

  const state = { value: seed >>> 0 };
  const fragments = Array.from({ length: count }, (_, index): FragmentPosition => {
    const progress = index / count;
    const band = index % 3;
    const phase = progress * Math.PI * 2 + band * ((Math.PI * 2) / 3);
    const radius = 1.45 + Math.sin(progress * Math.PI * 6) * 0.18;
    const jitter = () => (nextRandom(state) - 0.5) * 0.18;
    const x = Math.cos(phase) * radius + jitter();
    const y = Math.sin(phase * 1.5) * 1.18 + (band - 1) * 0.25 + jitter();
    const z = Math.sin(phase) * radius + Math.cos(progress * Math.PI * 4) * 0.38 + jitter();
    return Object.freeze([x, y, z] as const);
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    seed,
    fragments: Object.freeze(fragments),
  });
}
