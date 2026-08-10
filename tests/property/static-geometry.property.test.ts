import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_SEED,
  MAX_FRAGMENT_COUNT,
  MIN_FRAGMENT_COUNT,
} from '../../src/sculpture/calibrationGeometry';
import { createCuratedScene, transitionCamera } from '../../src/scenes/curatedScene';

describe('I1 static geometry property', () => {
  it('is independent of camera state across 256 seeded cases', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.integer({ min: MIN_FRAGMENT_COUNT, max: MAX_FRAGMENT_COUNT }),
        fc.array(fc.constantFrom('station-01', 'station-02', 'station-03'), {
          minLength: 0,
          maxLength: 50,
        }),
        (seed, count, transitions) => {
          const initial = createCuratedScene(seed, count, 'station-01');
          const initialBytes = JSON.stringify(initial.geometry);
          const final = transitions.reduce(transitionCamera, initial);
          expect(final.geometry).toBe(initial.geometry);
          expect(JSON.stringify(final.geometry)).toBe(initialBytes);
        },
      ),
      { numRuns: 256, seed: CALIBRATION_SEED },
    );
  });
});
