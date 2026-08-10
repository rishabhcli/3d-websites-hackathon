import type { CameraStationId } from '../camera/stations';
import { stationById } from '../camera/stations';
import type { StaticFragmentSet } from '../sculpture/calibrationGeometry';
import { createCalibrationFragments } from '../sculpture/calibrationGeometry';

export interface CuratedSceneState {
  readonly schemaVersion: 1;
  readonly geometry: StaticFragmentSet;
  readonly stationId: CameraStationId;
}

export function createCuratedScene(
  seed: number,
  fragmentCount: number,
  stationId: CameraStationId,
): CuratedSceneState {
  stationById(stationId);
  return Object.freeze({
    schemaVersion: 1 as const,
    geometry: createCalibrationFragments(seed, fragmentCount),
    stationId,
  });
}

export function transitionCamera(
  scene: CuratedSceneState,
  stationId: CameraStationId,
): CuratedSceneState {
  stationById(stationId);
  return Object.freeze({
    schemaVersion: scene.schemaVersion,
    geometry: scene.geometry,
    stationId,
  });
}
