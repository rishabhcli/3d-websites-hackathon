import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_SEED,
  MAX_FRAGMENT_COUNT,
  MIN_FRAGMENT_COUNT,
  createCalibrationFragments,
} from './calibrationGeometry';

describe('createCalibrationFragments', () => {
  it('returns byte-identical static geometry for the same seed', () => {
    const first = createCalibrationFragments(CALIBRATION_SEED, 512);
    const second = createCalibrationFragments(CALIBRATION_SEED, 512);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.fragments).toHaveLength(512);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.fragments)).toBe(true);
  });

  it.each([
    [-1, MIN_FRAGMENT_COUNT],
    [0x1_0000_0000, MIN_FRAGMENT_COUNT],
    [CALIBRATION_SEED, MIN_FRAGMENT_COUNT - 1],
    [CALIBRATION_SEED, MAX_FRAGMENT_COUNT + 1],
    [CALIBRATION_SEED, Number.NaN],
  ])('rejects unsafe seed/count pair %s/%s', (seed, count) => {
    expect(() => createCalibrationFragments(seed, count)).toThrow(RangeError);
  });
});
