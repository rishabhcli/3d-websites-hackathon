import { Canvas } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import type { WebGLRenderer } from 'three';
import type { CameraStationId } from '../camera/stations';
import type { StaticFragmentSet } from '../sculpture/calibrationGeometry';
import { CalibrationSculpture } from './CalibrationSculpture';

interface CanvasStageProps {
  readonly fragmentSet: StaticFragmentSet;
  readonly onContextUnavailable: () => void;
  readonly reducedMotion: boolean;
  readonly stationId: CameraStationId;
}

export function CanvasStage({
  fragmentSet,
  onContextUnavailable,
  reducedMotion,
  stationId,
}: CanvasStageProps) {
  const [renderer, setRenderer] = useState<WebGLRenderer | null>(null);

  useEffect(() => {
    if (!renderer) return;
    const canvas = renderer.domElement;
    const onLost = (event: Event) => {
      event.preventDefault();
      onContextUnavailable();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    return () => canvas.removeEventListener('webglcontextlost', onLost);
  }, [onContextUnavailable, renderer]);

  return (
    <Canvas
      camera={{ fov: 36, near: 0.1, far: 50, position: [0, 0.2, 6.4] }}
      dpr={[0.75, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => setRenderer(gl)}
    >
      <fog attach="fog" args={['#090805', 6, 13]} />
      <CalibrationSculpture
        fragmentSet={fragmentSet}
        reducedMotion={reducedMotion}
        stationId={stationId}
      />
    </Canvas>
  );
}
