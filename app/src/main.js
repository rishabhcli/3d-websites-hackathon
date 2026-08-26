/**
 * main.js — multi-view anamorphic sculpture gallery.
 *
 * The sculpture is a three-way voxel visual hull (carved in a worker) rendered
 * as an instanced field of emissive octahedra. Nothing about it ever moves or
 * morphs; only the camera does. The illusion is entirely geometric.
 */
import * as THREE from 'three';
import { SCENES, MASK_SIZE, sceneMasks, rasterize, maskFromCanvas, paintMask, DEMO_DRAWINGS } from './masks.js';
import { Post } from './postfx.js';

const GRID = 128;
const TARGET_FRAGMENTS = 28000;
const FOV = 30;
const HALF_TAN = Math.tan((FOV * Math.PI) / 180 / 2);
const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATIONS = [
  { theta: Math.PI, phi: Math.PI / 2 }, // eye at (0,0,-D)  front
  { theta: Math.PI / 2, phi: Math.PI / 2 }, // eye at (+D,0,0)  side
  { theta: Math.PI / 2, phi: 0 }, // eye at (0,+D,0)  top
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function shortest(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function sph(theta, phi, d, out = new THREE.Vector3()) {
  return out.set(d * Math.sin(phi) * Math.sin(theta), d * Math.cos(phi), d * Math.sin(phi) * Math.cos(theta));
}
function upFor(phi, out = new THREE.Vector3()) {
  const s = smoothstep(0.62, 0.14, phi);
  return out.set(0, 1 - s, -s).normalize();
}
const raf = () => new Promise((r) => requestAnimationFrame(r));
async function frames(n) {
  for (let i = 0; i < n; i++) await raf();
}

/* =============================================================== renderer */

const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // composite pass does its own transfer
renderer.setClearColor(0x000000, 1);
renderer.autoClear = false;

const post = new Post(renderer);
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
const perspRef = new THREE.PerspectiveCamera(FOV, 1, 0.05, 60);
const orthoRef = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 60);

const rig = { theta: STATIONS[0].theta, phi: STATIONS[0].phi, dist: 4.2 };
const camPos = new THREE.Vector3();
const stationDirs = STATIONS.map((s) => sph(s.theta, s.phi, 1));

function snapT() {
  sph(rig.theta, rig.phi, 1, camPos);
  let best = Infinity;
  for (const d of stationDirs) best = Math.min(best, camPos.angleTo(d));
  return smoothstep(0.34, 0.012, best);
}

function updateCamera(w, h) {
  sph(rig.theta, rig.phi, rig.dist, camPos);
  camera.position.copy(camPos);
  upFor(rig.phi, camera.up);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const aspect = w / h;
  perspRef.aspect = aspect;
  perspRef.updateProjectionMatrix();
  const halfH = rig.dist * HALF_TAN;
  orthoRef.left = -halfH * aspect;
  orthoRef.right = halfH * aspect;
  orthoRef.top = halfH;
  orthoRef.bottom = -halfH;
  orthoRef.updateProjectionMatrix();

  const t = snapT();
  const pe = perspRef.projectionMatrix.elements;
  const oe = orthoRef.projectionMatrix.elements;
  const ce = camera.projectionMatrix.elements;
  for (let i = 0; i < 16; i++) ce[i] = pe[i] + (oe[i] - pe[i]) * t;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  return t;
}

/* ============================================================== materials */

const fragmentMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uLightDir: { value: new THREE.Vector3(0.6, 0.5, 0.6).normalize() },
    uWarm: { value: new THREE.Color(1.0, 0.68, 0.34) },
    uCool: { value: new THREE.Color(0.36, 0.72, 1.0) },
    uGain: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    attribute float aPhase;
    attribute float aTint;
    varying vec3 vN;
    varying vec3 vW;
    varying float vPhase;
    varying float vTint;
    void main() {
      vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vN = normalize(mat3(instanceMatrix) * normal);
      vW = wp.xyz;
      vPhase = aPhase;
      vTint = aTint;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform float uTime;
    uniform vec3 uLightDir;
    uniform vec3 uWarm;
    uniform vec3 uCool;
    uniform float uGain;
    varying vec3 vN;
    varying vec3 vW;
    varying float vPhase;
    varying float vTint;
    void main() {
      vec3 n = normalize(vN);
      vec3 v = normalize(cameraPosition - vW);
      float ndl = max(dot(n, uLightDir), 0.0);
      float rim = pow(1.0 - abs(dot(n, v)), 2.5);
      vec3 base = mix(uWarm, uCool, clamp(vTint, 0.0, 1.0));
      float shimmer = 0.74 + 0.26 * sin(uTime * 1.3 + vPhase * 6.2831853);
      vec3 col = base * (0.26 + 0.92 * ndl) * shimmer + uCool * rim * 0.42 * shimmer;
      gl_FragColor = vec4(col * uGain, 1.0);
    }`,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
  depthTest: true,
});

/* ---------------------------------------------------------- ambient dust */
{
  const N = 1400;
  const p = new Float32Array(N * 3);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < N; i++) {
    const r = 3.6 + rnd() * 7.5;
    const u = rnd() * 2 - 1;
    const a = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    p[i * 3] = r * s * Math.cos(a);
    p[i * 3 + 1] = r * u * 0.72;
    p[i * 3 + 2] = r * s * Math.sin(a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const dust = new THREE.Points(
    g,
    new THREE.PointsMaterial({
      size: 0.02,
      color: new THREE.Color(0.32, 0.42, 0.58),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  dust.frustumCulled = false;
  scene.add(dust);
}

/* --------------------------------------------------------- station rings */
const markers = new THREE.Group();
{
  const geo = new THREE.TorusGeometry(0.17, 0.0045, 6, 64);
  for (const s of STATIONS) {
    const m = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.0, 0.72, 0.4),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    m.position.copy(sph(s.theta, s.phi, 2.65));
    m.lookAt(0, 0, 0);
    markers.add(m);
  }
}
scene.add(markers);

/* ================================================================= carve */

const worker = new Worker(new URL('./carve-worker.js', import.meta.url));
const pending = new Map();
let jobSeq = 0;

const el = (id) => document.getElementById(id);
const progressBox = el('progress');
const progressFill = el('progressFill');
const progressText = el('progressText');

worker.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'progress') {
    progressFill.style.width = `${Math.round(d.p * 100)}%`;
    progressText.textContent = `Carving ${GRID}³ · ${Math.round(d.p * 100)}%`;
    return;
  }
  const done = pending.get(d.jobId);
  if (done) {
    pending.delete(d.jobId);
    done(d);
  }
};

function carve(masks) {
  return new Promise((resolve) => {
    const jobId = ++jobSeq;
    pending.set(jobId, resolve);
    progressBox.hidden = false;
    progressFill.style.width = '0%';
    progressText.textContent = `Carving ${GRID}³ · 0%`;
    worker.postMessage({
      N: GRID,
      S: MASK_SIZE,
      maskA: masks[0],
      maskB: masks[1],
      maskC: masks[2],
      target: TARGET_FRAGMENTS,
      jobId,
    });
  });
}

/* ================================================================== mesh */

let mesh = null;
let current = { stats: null, masks: null, labels: null, title: '', note: '' };
const dummy = new THREE.Object3D();

function buildMesh(d) {
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.dispose();
    mesh = null;
  }
  const n = d.stats.fragments;
  if (n === 0) return;

  const geo = new THREE.OctahedronGeometry(1, 0);
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(d.phase, 1));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(d.tint, 1));

  mesh = new THREE.InstancedMesh(geo, fragmentMaterial, n);
  mesh.frustumCulled = false;
  const R = (2 / d.stats.grid) * 0.62;
  for (let a = 0; a < n; a++) {
    dummy.position.set(d.pos[a * 3], d.pos[a * 3 + 1], d.pos[a * 3 + 2]);
    dummy.rotation.set(d.spin[a * 3], d.spin[a * 3 + 1], d.spin[a * 3 + 2]);
    dummy.scale.setScalar(R * d.size[a]);
    dummy.updateMatrix();
    mesh.setMatrixAt(a, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
}

/* ==================================================================== ui */

const stationsBox = el('stations');
const iouRow = el('iouRow');
const scenePills = el('scenePills');
let stationBtns = [];
let iouFills = [];
let activeStation = 0;
let activeScene = 0;

function buildStationCards(labels) {
  stationsBox.innerHTML = '';
  iouRow.innerHTML = '';
  stationBtns = [];
  iouFills = [];
  labels.forEach((lab, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'station';
    b.setAttribute('aria-pressed', String(i === activeStation));
    b.innerHTML =
      `<span class="station__idx">0${i + 1}</span>` +
      `<canvas width="${MASK_SIZE}" height="${MASK_SIZE}"></canvas>` +
      `<div class="station__name"></div><div class="station__axis"></div>`;
    b.querySelector('.station__name').textContent = lab.name;
    b.querySelector('.station__axis').textContent = lab.axis;
    b.addEventListener('click', () => gotoStation(i));
    stationsBox.appendChild(b);
    stationBtns.push(b);

    const row = document.createElement('div');
    row.className = 'iouItem';
    row.innerHTML = `<span></span><span class="iouBar"><i></i></span><span>—</span>`;
    row.children[0].textContent = lab.name;
    iouRow.appendChild(row);
    iouFills.push(row);
  });
}

function paintThumbnails(masks) {
  stationBtns.forEach((b, i) => paintMask(b.querySelector('canvas'), masks[i]));
}

function updateReadout(stats) {
  el('rFrag').textContent = stats.fragments.toLocaleString('en-US');
  el('rGrid').textContent = `${stats.grid}³`;
  el('rMs').textContent = `${stats.carveMs.toFixed(1)} ms`;
  el('rOcc').textContent = stats.occupied.toLocaleString('en-US');
  stats.iou.forEach((v, i) => {
    const row = iouFills[i];
    if (!row) return;
    row.querySelector('.iouBar i').style.width = `${(v * 100).toFixed(1)}%`;
    row.children[2].textContent = v.toFixed(3);
  });
}

function markStation(i) {
  activeStation = i;
  stationBtns.forEach((b, n) => b.setAttribute('aria-pressed', String(n === i)));
}

SCENES.forEach((s, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pill';
  b.textContent = ['I', 'II', 'III'][i] + ' · ' + s.title;
  b.setAttribute('aria-pressed', String(i === 0));
  b.addEventListener('click', () => setScene(i));
  scenePills.appendChild(b);
});

function markScene(i) {
  activeScene = i;
  [...scenePills.children].forEach((b, n) => b.setAttribute('aria-pressed', String(n === i)));
}

/* ------------------------------------------------------------ light dial */

let lightTheta = 0.9;
const lightElev = 0.62;
const dial = el('lightDial');
const handle = el('lightHandle');

function applyLight() {
  const c = Math.cos(lightElev);
  fragmentMaterial.uniforms.uLightDir.value.set(Math.sin(lightTheta) * c, Math.sin(lightElev), Math.cos(lightTheta) * c).normalize();
  const r = 33;
  handle.style.left = `${50 + (Math.sin(lightTheta) * r * 100) / 92}%`;
  handle.style.top = `${50 - (Math.cos(lightTheta) * r * 100) / 92}%`;
  const deg = Math.round(((lightTheta * 180) / Math.PI + 360) % 360);
  el('lightVal').textContent = `${deg}°`;
  dial.setAttribute('aria-valuenow', String(deg));
}

function dialFromEvent(e) {
  const r = dial.getBoundingClientRect();
  lightTheta = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2)));
  applyLight();
}
dial.addEventListener('pointerdown', (e) => {
  dial.setPointerCapture(e.pointerId);
  dialFromEvent(e);
});
dial.addEventListener('pointermove', (e) => {
  if (dial.hasPointerCapture(e.pointerId)) dialFromEvent(e);
});
dial.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { lightTheta -= 0.12; applyLight(); e.preventDefault(); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { lightTheta += 0.12; applyLight(); e.preventDefault(); }
});
applyLight();

/* ------------------------------------------------------------ orbit input */

let dragging = false;
let lastX = 0;
let lastY = 0;
const hint = el('hint');
let hintFaded = false;
function fadeHint() {
  if (hintFaded) return;
  hintFaded = true;
  hint.style.opacity = '0';
}

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  cancelTween();
  fadeHint();
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  rig.theta -= (e.clientX - lastX) * 0.0055;
  rig.phi = clamp(rig.phi - (e.clientY - lastY) * 0.0055, 0, Math.PI);
  lastX = e.clientX;
  lastY = e.clientY;
});
const endDrag = () => (dragging = false);
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    rig.dist = clamp(rig.dist * Math.exp(e.deltaY * 0.0009), 2.2, 9);
    fadeHint();
  },
  { passive: false }
);

window.addEventListener('keydown', (e) => {
  if (drawerOpen && e.key !== 'Escape') return;
  if (e.key === '1') gotoStation(0);
  if (e.key === '2') gotoStation(1);
  if (e.key === '3') gotoStation(2);
  if (e.key === 'Escape' && drawerOpen) closeDrawPanel();
});

/* ------------------------------------------------------------ camera fly */

let tween = null;
function cancelTween() {
  if (tween) {
    const r = tween.resolve;
    tween = null;
    r();
  }
}

function flyTo(theta, phi, ms) {
  cancelTween();
  const target = rig.theta + shortest(rig.theta, theta);
  if (ms <= 0 || REDUCE) {
    rig.theta = target;
    rig.phi = phi;
    return frames(2);
  }
  return new Promise((resolve) => {
    tween = { fromT: rig.theta, fromP: rig.phi, toT: target, toP: phi, t0: performance.now(), dur: ms, resolve };
  });
}

let pulseT0 = -1;
function gotoStation(i, opts = {}) {
  markStation(i);
  fadeHint();
  const s = STATIONS[i];
  const ms = opts.instant ? 0 : 1750;
  return flyTo(s.theta, s.phi, ms).then(() => {
    pulseT0 = performance.now();
    return frames(2);
  });
}

function orbitTo(theta, phi) {
  fadeHint();
  return flyTo(theta, clamp(phi, 0, Math.PI), REDUCE ? 0 : 1100).then(() => frames(1));
}

function setLight(theta) {
  const from = lightTheta;
  const to = from + shortest(from, theta);
  if (REDUCE) {
    lightTheta = to;
    applyLight();
    return frames(1);
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = () => {
      const u = clamp((performance.now() - t0) / 520, 0, 1);
      lightTheta = lerp(from, to, easeInOut(u));
      applyLight();
      if (u < 1) requestAnimationFrame(step);
      else resolve();
    };
    step();
  });
}

/* ---------------------------------------------------------------- scenes */

async function applyCarve(masks, labels, title, note) {
  const d = await carve(masks);
  progressBox.hidden = true;
  buildMesh(d);
  current = { stats: d.stats, masks, labels, title, note };
  buildStationCards(labels);
  markStation(activeStation);
  paintThumbnails(masks);
  updateReadout(d.stats);
  el('sceneTitle').textContent = title;
  el('sceneNote').textContent = note;
  await frames(2);
  return d.stats;
}

async function setScene(i) {
  markScene(i);
  const s = SCENES[i];
  return applyCarve(sceneMasks(i), s.views, s.title, s.note);
}

/* ----------------------------------------------------------- draw panel */

const drawer = el('drawer');
const padsBox = el('pads');
const PAD_LABELS = [
  { name: 'Front', axis: 'front · −Z' },
  { name: 'Side', axis: 'side · +X' },
  { name: 'Top', axis: 'top · +Y' },
];
const pads = [];
let drawerOpen = false;
let brushMode = 'brush';
let brushSize = 16;

PAD_LABELS.forEach((lab, i) => {
  const wrap = document.createElement('div');
  wrap.className = 'pad';
  wrap.innerHTML = `<canvas width="${MASK_SIZE}" height="${MASK_SIZE}"></canvas><p>${lab.name} · ${lab.axis.split(' · ')[1]}</p>`;
  const cv = wrap.querySelector('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  padsBox.appendChild(wrap);

  let down = false;
  let px = 0;
  let py = 0;
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * MASK_SIZE, ((e.clientY - r.top) / r.height) * MASK_SIZE];
  };
  const stroke = (x0, y0, x1, y1) => {
    ctx.globalCompositeOperation = brushMode === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#ffe9c8';
    ctx.lineWidth = brushSize;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  cv.addEventListener('pointerdown', (e) => {
    down = true;
    cv.setPointerCapture(e.pointerId);
    [px, py] = at(e);
    stroke(px, py, px, py);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!down) return;
    const [x, y] = at(e);
    stroke(px, py, x, y);
    px = x;
    py = y;
  });
  const up = () => (down = false);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  pads.push({ cv, ctx });
});

function clearPads() {
  pads.forEach((p) => p.ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE));
}

function loadDemoDrawings() {
  clearPads();
  pads.forEach((p, i) => {
    const m = rasterize(DEMO_DRAWINGS[i], MASK_SIZE);
    const img = p.ctx.createImageData(MASK_SIZE, MASK_SIZE);
    for (let n = 0; n < MASK_SIZE * MASK_SIZE; n++) {
      const on = m[n];
      img.data[n * 4] = 255;
      img.data[n * 4 + 1] = 233;
      img.data[n * 4 + 2] = 200;
      img.data[n * 4 + 3] = on ? 255 : 0;
    }
    p.ctx.putImageData(img, 0, 0);
  });
  el('drawResult').textContent = 'Example silhouettes loaded — star, crescent, heart. Press Carve.';
  return frames(1);
}

function openDrawPanel() {
  drawer.hidden = false;
  drawerOpen = true;
  return frames(2);
}
function closeDrawPanel() {
  drawer.hidden = true;
  drawerOpen = false;
  return frames(2);
}

async function carveDrawn() {
  const masks = pads.map((p) => maskFromCanvas(p.cv));
  const filled = masks.map((m) => m.reduce((a, b) => a + b, 0));
  if (filled.some((f) => f < 24)) {
    el('drawResult').textContent = 'Every pad needs a shape — front, side and top.';
    return null;
  }
  el('carveBtn').disabled = true;
  el('drawResult').textContent = 'Carving…';
  const stats = await applyCarve(masks, PAD_LABELS, 'Your carve', 'Front, side and top from your own hand.');
  el('carveBtn').disabled = false;
  if (stats.fragments === 0) {
    el('drawResult').textContent = 'Those three silhouettes have no common volume — nothing survives the intersection. Try overlapping shapes.';
  } else {
    el('drawResult').textContent =
      `${stats.fragments.toLocaleString('en-US')} fragments from ${stats.occupied.toLocaleString('en-US')} hull voxels in ${stats.carveMs.toFixed(1)} ms · ` +
      `agreement front ${stats.iou[0].toFixed(3)} · side ${stats.iou[1].toFixed(3)} · top ${stats.iou[2].toFixed(3)}`;
    await closeDrawPanel();
    await gotoStation(0);
  }
  return stats;
}

el('drawOpen').addEventListener('click', openDrawPanel);
el('drawClose').addEventListener('click', closeDrawPanel);
el('clearAll').addEventListener('click', () => {
  clearPads();
  el('drawResult').textContent = 'Cleared. Draw in all three pads, then carve.';
});
el('loadDemo').addEventListener('click', loadDemoDrawings);
el('carveBtn').addEventListener('click', carveDrawn);
el('brushSize').addEventListener('input', (e) => (brushSize = Number(e.target.value)));
el('toolBrush').addEventListener('click', () => {
  brushMode = 'brush';
  el('toolBrush').setAttribute('aria-pressed', 'true');
  el('toolErase').setAttribute('aria-pressed', 'false');
});
el('toolErase').addEventListener('click', () => {
  brushMode = 'erase';
  el('toolBrush').setAttribute('aria-pressed', 'false');
  el('toolErase').setAttribute('aria-pressed', 'true');
});

/* ================================================================= loop */

let vw = 0;
let vh = 0;
function resize() {
  const w = Math.floor(window.innerWidth);
  const h = Math.floor(window.innerHeight);
  const dpr = renderer.getPixelRatio();
  if (w === vw && h === vh) return;
  vw = w;
  vh = h;
  renderer.setSize(w, h, false);
  post.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
}
window.addEventListener('resize', resize);
resize();

let readyDone = false;
let readyResolve;
const readyPromise = new Promise((r) => (readyResolve = r));
let meshFrames = 0;

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();

  if (tween) {
    const u = clamp((now - tween.t0) / tween.dur, 0, 1);
    const e = easeInOut(u);
    rig.theta = lerp(tween.fromT, tween.toT, e);
    rig.phi = lerp(tween.fromP, tween.toP, e);
    if (u >= 1) {
      const r = tween.resolve;
      tween = null;
      r();
    }
  }

  resize();
  const t = updateCamera(vw, vh);

  fragmentMaterial.uniforms.uTime.value = now / 1000;
  fragmentMaterial.uniforms.uGain.value = lerp(0.86, 1.06, t);
  markers.children.forEach((m) => (m.material.opacity = 0.42 * (1 - t)));

  let pulse = 0;
  if (pulseT0 > 0) {
    const u = (now - pulseT0) / 760;
    if (u < 1) pulse = Math.sin(u * Math.PI) * 1.05;
    else pulseT0 = -1;
  }

  post.render(scene, camera, { bloom: 0.9 + pulse, exposure: lerp(1.0, 1.18, t), time: now / 900 });

  if (mesh && !readyDone) {
    if (++meshFrames >= 2) {
      readyDone = true;
      readyResolve();
    }
  }
}

/* ================================================================= boot */

buildStationCards(SCENES[0].views);
animate();

const bootStats = setScene(0).then(async (s) => {
  await gotoStation(0, { instant: true });
  return s;
});

window.__demo = {
  ready: Promise.all([bootStats, readyPromise]).then(() => true),
  gotoStation,
  setScene,
  orbitTo,
  setLight,
  openDrawPanel,
  closeDrawPanel,
  loadDemoDrawings,
  carveDrawn,
  stats: () =>
    current.stats
      ? {
          fragments: current.stats.fragments,
          grid: current.stats.grid,
          carveMs: current.stats.carveMs,
          occupied: current.stats.occupied,
          iou: current.stats.iou.slice(),
          scene: current.title,
          station: activeStation,
        }
      : null,
};
