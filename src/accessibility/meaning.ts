import type { CameraStationId } from '../camera/stations';

export interface SemanticStationMeaning {
  readonly stationId: CameraStationId;
  readonly heading: string;
  readonly description: string;
}

export const SEMANTIC_STATION_MEANINGS: readonly SemanticStationMeaning[] = Object.freeze([
  {
    stationId: 'station-01',
    heading: 'Front observation',
    description:
      'A fixed amber fragment field viewed head-on. This calibration study does not claim a qualified silhouette.',
  },
  {
    stationId: 'station-02',
    heading: 'Side observation',
    description:
      'The same unmoving fragments viewed from the right, revealing the depth hidden by the front view.',
  },
  {
    stationId: 'station-03',
    heading: 'Elevated observation',
    description:
      'The same unmoving fragments viewed from above, with camera movement replaced by a direct cut in reduced-motion mode.',
  },
]);
