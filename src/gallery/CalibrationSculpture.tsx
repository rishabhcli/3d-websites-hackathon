import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, Matrix4, Object3D, Vector3 } from 'three';
import type { InstancedMesh } from 'three';
import type { CameraStationId } from '../camera/stations';
import { stationById } from '../camera/stations';
import { type StaticFragmentSet } from '../sculpture/calibrationGeometry';

interface CalibrationSculptureProps {
  readonly fragmentSet: StaticFragmentSet;
  readonly reducedMotion: boolean;
  readonly stationId: CameraStationId;
}

const origin = new Vector3(0, 0, 0);

export function CalibrationSculpture({
  fragmentSet,
  reducedMotion,
  stationId,
}: CalibrationSculptureProps) {
  const mesh = useRef<InstancedMesh>(null);
  const target = useMemo(() => new Vector3(...stationById(stationId).position), [stationId]);

  useLayoutEffect(() => {
    const instance = mesh.current;
    if (!instance) return;
    const transform = new Object3D();
    const matrix = new Matrix4();

    fragmentSet.fragments.forEach(([x, y, z], index) => {
      transform.position.set(x, y, z);
      transform.rotation.set(y * 0.38, x * 0.54, z * 0.32);
      const emphasis = index % 7 === 0 ? 1.6 : 1;
      transform.scale.set(0.025 * emphasis, 0.025 * emphasis, 0.16 + (index % 5) * 0.025);
      transform.updateMatrix();
      matrix.copy(transform.matrix);
      instance.setMatrixAt(index, matrix);
      instance.setColorAt(index, new Color(index % 11 === 0 ? '#f6d39c' : '#bd7340'));
    });
    instance.instanceMatrix.needsUpdate = true;
    if (instance.instanceColor) instance.instanceColor.needsUpdate = true;
  }, [fragmentSet]);

  useFrame(({ camera }, delta) => {
    if (reducedMotion) camera.position.copy(target);
    else camera.position.lerp(target, 1 - Math.exp(-Math.min(delta, 0.05) * 4.8));
    camera.lookAt(origin);
    camera.updateProjectionMatrix();
  });

  return (
    <>
      <ambientLight intensity={0.18} />
      <directionalLight color="#ffd7a2" intensity={4.5} position={[4, 5, 3]} />
      <pointLight color="#8a2f17" intensity={28} position={[-3, -1, -2]} distance={8} />
      <instancedMesh ref={mesh} args={[undefined, undefined, fragmentSet.fragments.length]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial color="#c47b49" metalness={0.44} roughness={0.36} />
      </instancedMesh>
    </>
  );
}
