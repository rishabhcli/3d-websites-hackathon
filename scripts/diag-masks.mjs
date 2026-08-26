/** Diagnostic: for each scene+view, show target mask vs surviving hull projection.
 *  red   = target pixel lost by the carve
 *  white = target pixel kept
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SHOT_DIR || '/tmp/anamorph';
const PORT = 8803;
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: path.join(ROOT, 'app'), stdio: 'ignore' });
process.on('exit', () => server.kill('SIGTERM'));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1300, height: 1400 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

const { dataUrl, table } = await page.evaluate(async () => {
  const M = await import('/src/masks.js');
  const S = M.MASK_SIZE, N = 128;
  const idx = new Int32Array(N);
  for (let n = 0; n < N; n++) idx[n] = Math.min(S - 1, Math.max(0, Math.floor((1 - (n + 0.5) / N) * S)));
  const fwd = new Int32Array(N);
  for (let n = 0; n < N; n++) fwd[n] = Math.min(S - 1, Math.max(0, Math.floor(((n + 0.5) / N) * S)));

  const rows = [];
  const table = [];
  for (let s = 0; s < M.SCENES.length; s++) {
    const masks = M.sceneMasks(s);
    const [A, B, C] = masks;
    const A2 = new Uint8Array(N * N), B2 = new Uint8Array(N * N), C2 = new Uint8Array(N * N);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) A2[i * N + j] = A[idx[j] * S + idx[i]];
      for (let k = 0; k < N; k++) C2[i * N + k] = C[fwd[k] * S + fwd[i]];
    }
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) B2[k * N + j] = B[idx[j] * S + idx[k]];

    const pA = new Uint8Array(S * S), pB = new Uint8Array(S * S), pC = new Uint8Array(S * S);
    let occ = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (!A2[i * N + j]) continue;
      for (let k = 0; k < N; k++) {
        if (B2[k * N + j] && C2[i * N + k]) {
          occ++;
          pA[idx[j] * S + idx[i]] = 1; pB[idx[j] * S + idx[k]] = 1; pC[fwd[k] * S + fwd[i]] = 1;
        }
      }
    }
    const iou = (p, m) => { let a = 0, b = 0; for (let n = 0; n < S * S; n++) { if (p[n] & m[n]) a++; if (p[n] | m[n]) b++; } return b ? a / b : 0; };
    table.push({ scene: M.SCENES[s].title, occ, iou: [iou(pA, A), iou(pB, B), iou(pC, C)] });
    rows.push([[A, pA], [B, pB], [C, pC]]);
  }

  const SC = 3, pad = 16, lab = 26;
  const cv = document.createElement('canvas');
  cv.width = pad + 3 * (S * SC + pad);
  cv.height = rows.length * (S * SC + pad + lab) + pad;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cv.width, cv.height);
  rows.forEach((row, r) => {
    row.forEach(([m, p], c) => {
      const im = ctx.createImageData(S, S);
      for (let n = 0; n < S * S; n++) {
        const t = m[n], k = p[n];
        im.data[n * 4] = t ? 255 : 0;
        im.data[n * 4 + 1] = k ? 255 : 0;
        im.data[n * 4 + 2] = k ? 255 : 0;
        im.data[n * 4 + 3] = 255;
      }
      const tmp = document.createElement('canvas'); tmp.width = S; tmp.height = S;
      tmp.getContext('2d').putImageData(im, 0, 0);
      ctx.imageSmoothingEnabled = false;
      const x = pad + c * (S * SC + pad), y = pad + r * (S * SC + pad + lab);
      ctx.drawImage(tmp, x, y, S * SC, S * SC);
      ctx.fillStyle = '#ddd'; ctx.font = '15px monospace';
      ctx.fillText(`${M.SCENES[r].title} · ${M.SCENES[r].views[c].name} · IoU ${table[r].iou[c].toFixed(3)}`, x, y + S * SC + 18);
    });
  });
  return { dataUrl: cv.toDataURL('image/png'), table };
});

fs.writeFileSync(path.join(OUT, 'diag-masks.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log(JSON.stringify(table, null, 2));
await browser.close();
server.kill('SIGTERM');
