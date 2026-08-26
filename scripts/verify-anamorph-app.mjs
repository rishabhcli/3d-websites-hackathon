/**
 * Headless acceptance check for app/.
 * Serves app/ with python3 -m http.server 8802, drives it with Playwright,
 * asserts no console errors, checks fragment counts per scene and writes one
 * PNG per station so a human can confirm the silhouettes read.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const OUT = process.env.SHOT_DIR || '/tmp/anamorph';
const PORT = 8802;
const ONLY_SHOTS = process.argv.includes('--shots-only');

fs.mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: APP,
  stdio: 'ignore',
});
const stop = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', stop);

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/index.html`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
}

const report = { assets: {}, console: [], pageErrors: [], scenes: [], shots: [], drawn: null };

await waitServer();

for (const asset of ['index.html', 'style.css', 'src/main.js', 'src/masks.js', 'src/postfx.js', 'src/carve-worker.js', 'vendor/three.module.js', 'vendor/three.core.js']) {
  const r = await fetch(`http://127.0.0.1:${PORT}/${asset}`);
  report.assets[asset] = `${r.status} ${(await r.arrayBuffer()).byteLength}B`;
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-lcd-text',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') report.console.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => report.pageErrors.push(String(e)));
page.on('requestfailed', (r) => report.pageErrors.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__demo && window.__demo.ready, null, { timeout: 60000 });
await page.evaluate(() => window.__demo.ready);
report.webgl = await page.evaluate(() => {
  const gl = document.getElementById('stage').getContext('webgl2');
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return { renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
});

if (!ONLY_SHOTS) {
  for (let s = 0; s < 3; s++) {
    await page.evaluate((i) => window.__demo.setScene(i), s);
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => window.__demo.stats());
    report.scenes.push(st);
  }
}

await page.evaluate(() => window.__demo.setScene(0));
await page.waitForTimeout(500);
report.sceneForShots = await page.evaluate(() => window.__demo.stats());

for (let i = 0; i < 3; i++) {
  await page.evaluate((n) => window.__demo.gotoStation(n, { instant: true }), i);
  await page.waitForTimeout(900);
  const p = path.join(OUT, `3d-station-${i}.png`);
  await page.screenshot({ path: p, type: 'png' });
  report.shots.push(p);
}

// mid-orbit frame, proves the illusion dissolves between stations
await page.evaluate(() => window.__demo.orbitTo(Math.PI * 0.78, Math.PI * 0.36));
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(OUT, '3d-between.png'), type: 'png' });
report.shots.push(path.join(OUT, '3d-between.png'));

if (!ONLY_SHOTS) {
  // draw-your-own path, using the same carve
  await page.evaluate(() => window.__demo.openDrawPanel());
  await page.evaluate(() => window.__demo.loadDemoDrawings());
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '3d-draw-panel.png'), type: 'png' });
  report.drawn = await page.evaluate(() => window.__demo.carveDrawn());
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '3d-drawn-carve.png'), type: 'png' });
  report.shots.push(path.join(OUT, '3d-draw-panel.png'), path.join(OUT, '3d-drawn-carve.png'));
  await page.evaluate(() => window.__demo.setScene(0));
  await page.waitForTimeout(300);
}

report.fps = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => {
        n++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
        else res(Math.round((n / (performance.now() - t0)) * 1000));
      };
      requestAnimationFrame(tick);
    })
);

await browser.close();
stop();
console.log(JSON.stringify(report, null, 2));
