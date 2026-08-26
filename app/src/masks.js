/**
 * masks.js — procedural binary silhouette masks.
 *
 * Every silhouette is authored as Path2D geometry in a normalised [0,1]^2 space
 * (x right, y down), rasterised onto an offscreen 2D canvas, and read back as a
 * binary alpha mask. Nothing is hand-tuned per-pixel and no image assets exist.
 *
 * Design rule that governs every shape here: the carve is a three-way visual
 * hull, and the projection of that hull onto one view is bounded by the extents
 * of the other two masks along the shared axes. So each silhouette is drawn to
 * fill its frame in BOTH dimensions, otherwise the sculpture loses whole regions
 * of the other two silhouettes.
 */

export const MASK_SIZE = 128;

/** Rasterise a normalised-space draw callback into a binary Uint8Array. */
export function rasterize(draw, S = MASK_SIZE) {
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, S, S);
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  draw(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const px = ctx.getImageData(0, 0, S, S).data;
  const out = new Uint8Array(S * S);
  for (let i = 0, n = S * S; i < n; i++) out[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

/** Read a binary mask straight out of an existing canvas (the draw panel). */
export function maskFromCanvas(canvas) {
  const S = canvas.width;
  const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S, S).data;
  const out = new Uint8Array(S * S);
  for (let i = 0, n = S * S; i < n; i++) out[i] = px[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}

/* ------------------------------------------------------------------ helpers */

function poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();
}

function ell(ctx, cx, cy, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
  ctx.fill();
}

function bar(ctx, x0, y0, x1, y1, w) {
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/* ------------------------------------------------------- scene 1: "Passage" */

// Front view, -Z station. Bird in flight: swept wings span the full width,
// head-to-tail spans the full height.
function bird(ctx) {
  ell(ctx, 0.5, 0.545, 0.088, 0.215); // body
  ell(ctx, 0.5, 0.25, 0.083, 0.077); // head
  poly(ctx, [
    [0.412, 0.655],
    [0.588, 0.655],
    [0.645, 0.99],
    [0.5, 0.86],
    [0.355, 0.99],
  ]); // forked tail

  for (const s of [-1, 1]) {
    const m = (u) => 0.5 + s * (u - 0.5);
    ctx.beginPath();
    ctx.moveTo(m(0.46), 0.4);
    ctx.bezierCurveTo(m(0.355), 0.2, m(0.215), 0.06, m(0.03), 0.075);
    ctx.bezierCurveTo(m(0.06), 0.265, m(0.15), 0.45, m(0.3), 0.565);
    ctx.bezierCurveTo(m(0.37), 0.615, m(0.44), 0.585, m(0.47), 0.53);
    ctx.closePath();
    ctx.fill();
  }
}

// Side view, +X station. Skeleton key laid on the diagonal so it fills the
// frame on both axes; drawn bold so the carve keeps real volume.
function key(ctx) {
  ctx.save();
  ctx.translate(0.5, 0.5);
  ctx.rotate(-Math.PI / 4);
  ctx.scale(0.83, 0.83);

  // bow: annulus via even-odd fill
  ctx.beginPath();
  ctx.arc(-0.44, 0, 0.205, 0, Math.PI * 2);
  ctx.arc(-0.44, 0, 0.088, 0, Math.PI * 2);
  ctx.fill('evenodd');

  ctx.beginPath();
  ctx.rect(-0.28, -0.115, 0.075, 0.23); // collar
  ctx.rect(-0.28, -0.058, 0.9, 0.116); // shaft
  ctx.rect(0.235, 0.058, 0.075, 0.135); // tooth 1
  ctx.rect(0.375, 0.058, 0.068, 0.25); // tooth 2
  ctx.rect(0.5, 0.058, 0.08, 0.155); // tooth 3
  ctx.fill();
  ctx.restore();
}

// Top view, +Y station. Open hand, fingers spread to reach the frame edges.
function hand(ctx) {
  rrect(ctx, 0.275, 0.47, 0.45, 0.375, 0.1); // palm
  rrect(ctx, 0.355, 0.76, 0.28, 0.24, 0.05); // wrist
  bar(ctx, 0.365, 0.58, 0.275, 0.09, 0.108); // index
  bar(ctx, 0.478, 0.58, 0.472, 0.035, 0.112); // middle
  bar(ctx, 0.59, 0.58, 0.658, 0.1, 0.108); // ring
  bar(ctx, 0.685, 0.625, 0.878, 0.3, 0.098); // pinky
  bar(ctx, 0.325, 0.715, 0.072, 0.515, 0.132); // thumb
}

/* ------------------------------------------------------ scene 2: "Tidewood" */

function tree(ctx) {
  ctx.beginPath();
  ctx.moveTo(0.44, 0.44);
  ctx.lineTo(0.56, 0.44);
  ctx.lineTo(0.63, 1.0);
  ctx.lineTo(0.37, 1.0);
  ctx.closePath();
  ctx.fill(); // flared trunk
  bar(ctx, 0.5, 0.62, 0.255, 0.42, 0.055);
  bar(ctx, 0.5, 0.6, 0.75, 0.4, 0.055);
  ell(ctx, 0.5, 0.275, 0.29, 0.265);
  ell(ctx, 0.245, 0.395, 0.22, 0.185);
  ell(ctx, 0.755, 0.395, 0.22, 0.185);
  ell(ctx, 0.36, 0.155, 0.175, 0.135);
  ell(ctx, 0.64, 0.155, 0.175, 0.135);
}

function fish(ctx) {
  ell(ctx, 0.435, 0.5, 0.355, 0.255); // body
  poly(ctx, [
    [0.72, 0.5],
    [0.995, 0.185],
    [0.925, 0.5],
    [0.995, 0.815],
  ]); // tail
  poly(ctx, [
    [0.33, 0.29],
    [0.5, 0.03],
    [0.62, 0.31],
  ]); // dorsal fin
  poly(ctx, [
    [0.36, 0.71],
    [0.29, 0.97],
    [0.56, 0.75],
  ]); // ventral fin
  poly(ctx, [
    [0.56, 0.66],
    [0.72, 0.96],
    [0.74, 0.63],
  ]); // pelvic fin
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ell(ctx, 0.175, 0.435, 0.042, 0.042); // eye punched out
  ctx.restore();
}

function spiral(ctx) {
  ctx.lineWidth = 0.082;
  ctx.beginPath();
  const turns = 2.55,
    aMax = turns * Math.PI * 2;
  for (let i = 0; i <= 260; i++) {
    const a = (i / 260) * aMax;
    const r = 0.052 + (a / aMax) * 0.43;
    const x = 0.5 + Math.cos(a) * r;
    const y = 0.5 + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ell(ctx, 0.5 + 0.052, 0.5, 0.052, 0.052);
}

/* ---------------------------------------------------------- scene 3: "Rest" */

function chair(ctx) {
  ctx.beginPath();
  ctx.rect(0.06, 0.03, 0.475, 0.115); // crest rail
  ctx.rect(0.075, 0.03, 0.155, 0.63); // back post
  ctx.rect(0.29, 0.05, 0.075, 0.5); // back slat
  ctx.rect(0.06, 0.53, 0.885, 0.135); // seat
  ctx.rect(0.075, 0.66, 0.145, 0.34); // rear leg
  ctx.rect(0.8, 0.66, 0.145, 0.34); // front leg
  ctx.rect(0.075, 0.83, 0.87, 0.07); // stretcher
  ctx.fill();
}

function letterR(ctx) {
  ctx.beginPath();
  ctx.rect(0.055, 0.035, 0.225, 0.93); // stem
  ctx.fill();

  ctx.beginPath(); // bowl with counter punched out
  ctx.moveTo(0.2, 0.035);
  ctx.lineTo(0.6, 0.035);
  ctx.bezierCurveTo(0.9, 0.035, 0.94, 0.28, 0.6, 0.52);
  ctx.lineTo(0.2, 0.52);
  ctx.closePath();
  ctx.moveTo(0.545, 0.155);
  ctx.bezierCurveTo(0.72, 0.155, 0.72, 0.4, 0.545, 0.4);
  ctx.lineTo(0.33, 0.4);
  ctx.lineTo(0.33, 0.155);
  ctx.closePath();
  ctx.fill('evenodd');

  poly(ctx, [
    [0.47, 0.45],
    [0.72, 0.45],
    [0.975, 0.965],
    [0.715, 0.965],
  ]); // leg
}

function butterfly(ctx) {
  ell(ctx, 0.5, 0.5, 0.036, 0.335); // body
  for (const s of [-1, 1]) {
    const m = (u) => 0.5 + s * (u - 0.5);
    ctx.beginPath(); // upper wing
    ctx.moveTo(m(0.49), 0.42);
    ctx.bezierCurveTo(m(0.36), 0.06, m(0.09), 0.0, m(0.025), 0.19);
    ctx.bezierCurveTo(m(-0.01), 0.33, m(0.22), 0.46, m(0.47), 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath(); // lower wing
    ctx.moveTo(m(0.48), 0.52);
    ctx.bezierCurveTo(m(0.26), 0.58, m(0.06), 0.72, m(0.12), 0.89);
    ctx.bezierCurveTo(m(0.19), 1.03, m(0.42), 0.87, m(0.49), 0.66);
    ctx.closePath();
    ctx.fill();
    bar(ctx, m(0.49), 0.19, m(0.34), 0.035, 0.022); // antenna
  }
}

/* ------------------------------------------------- drawing-panel demo shapes */

function star(ctx) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 0.48 : 0.205;
    const x = 0.5 + Math.cos(a) * r;
    const y = 0.5 + Math.sin(a) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function crescent(ctx) {
  ctx.beginPath();
  ctx.arc(0.46, 0.5, 0.48, 0, Math.PI * 2);
  ctx.arc(0.72, 0.42, 0.42, 0, Math.PI * 2);
  ctx.fill('evenodd');
}

function heart(ctx) {
  ctx.beginPath();
  ctx.moveTo(0.5, 0.99);
  ctx.bezierCurveTo(-0.06, 0.6, 0.1, 0.02, 0.5, 0.31);
  ctx.bezierCurveTo(0.9, 0.02, 1.06, 0.6, 0.5, 0.99);
  ctx.closePath();
  ctx.fill();
}

/* --------------------------------------------------------------- the scenes */

export const SCENES = [
  {
    title: 'Passage',
    note: 'One cloud. A bird, a key, a hand.',
    views: [
      { name: 'Bird', axis: 'front · −Z', draw: bird },
      { name: 'Key', axis: 'side · +X', draw: key },
      { name: 'Hand', axis: 'top · +Y', draw: hand },
    ],
  },
  {
    title: 'Tidewood',
    note: 'Root, current and coil in one solid.',
    views: [
      { name: 'Tree', axis: 'front · −Z', draw: tree },
      { name: 'Fish', axis: 'side · +X', draw: fish },
      { name: 'Spiral', axis: 'top · +Y', draw: spiral },
    ],
  },
  {
    title: 'Rest',
    note: 'A chair, a letter, a wing.',
    views: [
      { name: 'Chair', axis: 'front · −Z', draw: chair },
      { name: 'R', axis: 'side · +X', draw: letterR },
      { name: 'Butterfly', axis: 'top · +Y', draw: butterfly },
    ],
  },
];

export const DEMO_DRAWINGS = [star, crescent, heart];

export function sceneMasks(index) {
  return SCENES[index].views.map((v) => rasterize(v.draw, MASK_SIZE));
}

/** Paint a binary mask into a canvas for the HUD thumbnails. */
export function paintMask(canvas, mask, S = MASK_SIZE, color = [255, 214, 160]) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const on = mask[i];
    img.data[i * 4] = on ? color[0] : 0;
    img.data[i * 4 + 1] = on ? color[1] : 0;
    img.data[i * 4 + 2] = on ? color[2] : 0;
    img.data[i * 4 + 3] = on ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
}
