import { describe, expect, it } from 'vitest';
import { CAMERA_STATIONS, parseStationHash, stationById } from './stations';
import type { CameraStationId } from './stations';

describe('camera station URL boundary', () => {
  it('accepts only authored station identifiers', () => {
    expect(parseStationHash('#station-02')).toBe('station-02');
    expect(parseStationHash('#%00station-02')).toBe('station-01');
    expect(parseStationHash('#not-authored')).toBe('station-01');
  });

  it('keeps every authored station addressable', () => {
    for (const station of CAMERA_STATIONS) expect(stationById(station.id)).toBe(station);
    expect(() => stationById('not-authored' as CameraStationId)).toThrow('Unknown camera station');
  });
});
