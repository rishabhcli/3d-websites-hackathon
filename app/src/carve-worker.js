/**
 * carve-worker.js — voxel carving / visual-hull intersection.
 *
 * A voxel (i,j,k) survives only if it projects inside mask A along Z, inside
 * mask B along X and inside mask C along Y. The projection formulas below are
 * derived from the exact camera bases used by the three orthographic stations
 * in main.js, so what the carve assumes and what the camera shows are the same
 * transform:
 *
 *   station 0  eye (0,0,-D)  up +Y  ->  screen right = -X, screen up = +Y
 *   station 1  eye (+D,0,0)  up +Y  ->  screen right = -Z, screen up = +Y
 *   station 2  eye (0,+D,0)  up -Z  ->  screen right = +X, screen up = -Z
 *
 * World coords: x,y,z = (index + 0.5)/N * 2 - 1, so the grid spans [-1,1]^3.
 * Mask raster coords: u to the right, v downward.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// deterministic per-voxel hash in [0,1) — no Math.random, so runs reproduce
function hash01(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return (n >>> 0) / 4294967296;
}

self.onmessage = (e) => {
  const { N, S, maskA, maskB, maskC, target, jobId } = e.data;
  const t0 = performance.now();

  /* ---- projection lookup tables (integer mask indices per grid index) ---- */
  const uA = new Int32Array(N); // front view column  <- i
  const vRow = new Int32Array(N); // front & side view row <- j
  const uB = new Int32Array(N); // side view column  <- k
  const uC = new Int32Array(N); // top view column   <- i
  const vC = new Int32Array(N); // top view row      <- k
  for (let n = 0; n < N; n++) {
    const t = (n + 0.5) / N;
    uA[n] = clamp(Math.floor((1 - t) * S), 0, S - 1);
    vRow[n] = clamp(Math.floor((1 - t) * S), 0, S - 1);
    uB[n] = clamp(Math.floor((1 - t) * S), 0, S - 1);
    uC[n] = clamp(Math.floor(t * S), 0, S - 1);
    vC[n] = clamp(Math.floor(t * S), 0, S - 1);
  }

  /* ---- collapse each mask test to a 2D table so the inner loop is cheap --- */
  const A2 = new Uint8Array(N * N); // [i*N + j]
  const B2 = new Uint8Array(N * N); // [k*N + j]
  const C2 = new Uint8Array(N * N); // [i*N + k]
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) A2[i * N + j] = maskA[vRow[j] * S + uA[i]];
    for (let k = 0; k < N; k++) C2[i * N + k] = maskC[vC[k] * S + uC[i]];
  }
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < N; j++) B2[k * N + j] = maskB[vRow[j] * S + uB[k]];
  }

  /* ------------------------------ the carve ------------------------------ */
  const NN = N * N;
  const occ = new Uint8Array(N * N * N); // idx = (i*N + j)*N + k
  let occupied = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (!A2[i * N + j]) continue;
      const base = (i * N + j) * N;
      const cRow = i * N;
      for (let k = 0; k < N; k++) {
        if (B2[k * N + j] && C2[cRow + k]) {
          occ[base + k] = 1;
          occupied++;
        }
      }
    }
    if ((i & 7) === 0) self.postMessage({ type: 'progress', jobId, p: i / N });
  }
  const carveMs = performance.now() - t0;

  /* --------- silhouette agreement: re-project the hull onto each mask ------ */
  const pA = new Uint8Array(S * S),
    pB = new Uint8Array(S * S),
    pC = new Uint8Array(S * S);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const base = (i * N + j) * N;
      for (let k = 0; k < N; k++) {
        if (!occ[base + k]) continue;
        pA[vRow[j] * S + uA[i]] = 1;
        pB[vRow[j] * S + uB[k]] = 1;
        pC[vC[k] * S + uC[i]] = 1;
      }
    }
  }
  const iouOf = (proj, mask) => {
    let inter = 0,
      uni = 0;
    for (let n = 0; n < S * S; n++) {
      const a = proj[n],
        b = mask[n];
      if (a & b) inter++;
      if (a | b) uni++;
    }
    return uni === 0 ? 0 : inter / uni;
  };
  const iou = [iouOf(pA, maskA), iouOf(pB, maskB), iouOf(pC, maskC)];

  /* ------- erode to a fragment field: boundary voxels are kept first ------- */
  const bnd = new Int32Array(occupied);
  const inr = new Int32Array(occupied);
  let nb = 0,
    ni = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const base = (i * N + j) * N;
      for (let k = 0; k < N; k++) {
        const idx = base + k;
        if (!occ[idx]) continue;
        const edge =
          i === 0 ||
          i === N - 1 ||
          j === 0 ||
          j === N - 1 ||
          k === 0 ||
          k === N - 1 ||
          !occ[idx - NN] ||
          !occ[idx + NN] ||
          !occ[idx - N] ||
          !occ[idx + N] ||
          !occ[idx - 1] ||
          !occ[idx + 1];
        if (edge) bnd[nb++] = idx;
        else inr[ni++] = idx;
      }
    }
  }

  let bndRate = 1,
    inrRate = 0;
  if (nb > target) {
    bndRate = target / nb;
  } else {
    const room = target - nb;
    inrRate = ni > 0 ? Math.min(0.4, room / ni) : 0;
  }

  const keep = new Int32Array(nb + ni);
  let nk = 0;
  for (let a = 0; a < nb; a++) if (bndRate >= 1 || hash01(bnd[a]) < bndRate) keep[nk++] = bnd[a];
  for (let a = 0; a < ni; a++) if (inrRate > 0 && hash01(inr[a] ^ 0x5bf03635) < inrRate) keep[nk++] = inr[a];

  /* ------------------------- pack instance buffers ------------------------ */
  const pos = new Float32Array(nk * 3);
  const phase = new Float32Array(nk);
  const tint = new Float32Array(nk);
  const spin = new Float32Array(nk * 3);
  const size = new Float32Array(nk);

  let maxR = 1e-6;
  for (let a = 0; a < nk; a++) {
    const idx = keep[a];
    const k = idx % N;
    const j = ((idx - k) / N) % N;
    const i = (idx - k - j * N) / NN;
    const x = ((i + 0.5) / N) * 2 - 1;
    const y = ((j + 0.5) / N) * 2 - 1;
    const z = ((k + 0.5) / N) * 2 - 1;
    pos[a * 3] = x;
    pos[a * 3 + 1] = y;
    pos[a * 3 + 2] = z;
    const r = Math.sqrt(x * x + y * y + z * z);
    if (r > maxR) maxR = r;
    tint[a] = r;
    const h = hash01(idx);
    const h2 = hash01(idx ^ 0x9e3779b9);
    const h3 = hash01(idx ^ 0x85ebca6b);
    phase[a] = h;
    spin[a * 3] = h * Math.PI * 2;
    spin[a * 3 + 1] = h2 * Math.PI * 2;
    spin[a * 3 + 2] = h3 * Math.PI * 2;
    size[a] = 0.68 + h2 * 0.62;
  }
  for (let a = 0; a < nk; a++) tint[a] = Math.min(1, tint[a] / maxR);

  self.postMessage(
    {
      type: 'done',
      jobId,
      pos,
      phase,
      tint,
      spin,
      size,
      stats: {
        fragments: nk,
        occupied,
        boundary: nb,
        grid: N,
        carveMs: Math.round(carveMs * 100) / 100,
        totalMs: Math.round((performance.now() - t0) * 100) / 100,
        iou,
      },
    },
    [pos.buffer, phase.buffer, tint.buffer, spin.buffer, size.buffer]
  );
};
