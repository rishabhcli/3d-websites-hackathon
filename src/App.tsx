import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { SEMANTIC_STATION_MEANINGS } from './accessibility/meaning';
import { CAMERA_STATIONS, parseStationHash, type CameraStationId } from './camera/stations';
import { createCuratedScene, transitionCamera } from './scenes/curatedScene';
import { CALIBRATION_SEED } from './sculpture/calibrationGeometry';

const CanvasStage = lazy(async () => {
  const module = await import('./gallery/CanvasStage');
  return { default: module.CanvasStage };
});

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function supportsWebGl2(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  if (!context) return false;
  context.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.width = 0;
  canvas.height = 0;
  return true;
}

export function App() {
  const [scene, setScene] = useState(() =>
    createCuratedScene(CALIBRATION_SEED, 540, parseStationHash(location.hash)),
  );
  const reducedMotion = useReducedMotion();
  const hasWebGl2 = useMemo(() => supportsWebGl2(), []);
  const [contextAvailable, setContextAvailable] = useState(hasWebGl2);
  const onContextUnavailable = useCallback(() => setContextAvailable(false), []);

  useEffect(() => {
    const onHashChange = () =>
      setScene((current) => transitionCamera(current, parseStationHash(location.hash)));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function selectStation(next: CameraStationId) {
    setScene((current) => transitionCamera(current, next));
    history.replaceState(null, '', `#${next}`);
  }

  return (
    <main className="experience-shell">
      <header className="masthead">
        <p className="eyebrow">Static study / calibration surface</p>
        <p className="status-line">
          <span aria-hidden="true" className="status-mark" /> Geometry fixed · camera moving
        </p>
      </header>

      <section className="stage" aria-labelledby="stage-title">
        <div className="stage-copy">
          <p className="folio">Observation field 001</p>
          <h1 id="stage-title">Stand where the mark is.</h1>
          <p className="stage-description">
            Three stations circle one unmoving arrangement. This calibration surface remains
            explicitly unqualified until projection evidence exists.
          </p>
        </div>

        <div className="canvas-frame" aria-hidden="true">
          {contextAvailable ? (
            <Suspense
              fallback={<div className="canvas-unavailable">Preparing static geometry</div>}
            >
              <CanvasStage
                fragmentSet={scene.geometry}
                onContextUnavailable={onContextUnavailable}
                reducedMotion={reducedMotion}
                stationId={scene.stationId}
              />
            </Suspense>
          ) : (
            <div className="canvas-unavailable">Semantic gallery active</div>
          )}
          <div className="reticle" />
        </div>

        <nav className="station-rail" aria-label="Observation stations">
          {CAMERA_STATIONS.map((station) => (
            <button
              aria-pressed={station.id === scene.stationId}
              className={station.id === scene.stationId ? 'station is-active' : 'station'}
              key={station.id}
              onClick={() => selectStation(station.id)}
              type="button"
            >
              <span>{station.shortLabel}</span>
              <small>{station.label.replace(' observation station', '')}</small>
            </button>
          ))}
        </nav>
      </section>

      <section className="semantic-gallery" aria-labelledby="semantic-title">
        <div>
          <p className="eyebrow">Canvas equivalent</p>
          <h2 id="semantic-title">The same field, described.</h2>
        </div>
        <ol>
          {SEMANTIC_STATION_MEANINGS.map((meaning) => (
            <li
              aria-current={meaning.stationId === scene.stationId ? 'true' : undefined}
              key={meaning.stationId}
            >
              <span>{meaning.stationId.slice(-2)}</span>
              <div>
                <h3>{meaning.heading}</h3>
                <p className="semantic-description">{meaning.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
