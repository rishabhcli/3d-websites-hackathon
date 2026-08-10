export const CAMERA_STATIONS = [
  {
    id: 'station-01',
    shortLabel: '01',
    label: 'Front observation station',
    position: [0, 0.2, 6.4],
  },
  {
    id: 'station-02',
    shortLabel: '02',
    label: 'Side observation station',
    position: [6.4, 0.2, 0],
  },
  {
    id: 'station-03',
    shortLabel: '03',
    label: 'Elevated observation station',
    position: [0.2, 6.1, 2.1],
  },
] as const;

export type CameraStation = (typeof CAMERA_STATIONS)[number];
export type CameraStationId = CameraStation['id'];

export function parseStationHash(hash: string): CameraStationId {
  const candidate = hash.replace(/^#/, '');
  return CAMERA_STATIONS.some(({ id }) => id === candidate)
    ? (candidate as CameraStationId)
    : CAMERA_STATIONS[0].id;
}

export function stationById(id: CameraStationId): CameraStation {
  const station = CAMERA_STATIONS.find((candidate) => candidate.id === id);
  if (!station) throw new Error(`Unknown camera station: ${id}`);
  return station;
}
