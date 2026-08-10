import { expect, test } from './fixtures';

interface DrawEvidence {
  drawArrays: number;
  drawArraysInstanced: number;
  drawElements: number;
  drawElementsInstanced: number;
}

declare global {
  interface Window {
    readonly __canvasStageDrawEvidence?: DrawEvidence;
  }
}

test('executes the production CanvasStage with a live qualified WebGL2 renderer', async ({
  page,
}) => {
  const canvasStageResponses: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (/\/assets\/CanvasStage-[A-Za-z0-9_-]+\.js$/u.test(url.pathname) && response.ok()) {
      canvasStageResponses.push(response.url());
    }
  });

  await page.addInitScript(() => {
    const evidence: DrawEvidence = {
      drawArrays: 0,
      drawArraysInstanced: 0,
      drawElements: 0,
      drawElementsInstanced: 0,
    };
    Object.defineProperty(window, '__canvasStageDrawEvidence', {
      configurable: false,
      value: evidence,
      writable: false,
    });

    const webGl = WebGLRenderingContext.prototype;
    const drawArrays: unknown = Object.getOwnPropertyDescriptor(webGl, 'drawArrays')?.value;
    const drawElements: unknown = Object.getOwnPropertyDescriptor(webGl, 'drawElements')?.value;
    if (typeof drawArrays !== 'function' || typeof drawElements !== 'function') {
      throw new Error('WebGL draw functions are unavailable');
    }
    Object.defineProperty(webGl, 'drawArrays', {
      configurable: true,
      value(this: WebGLRenderingContext, mode: number, first: number, count: number) {
        evidence.drawArrays += 1;
        Reflect.apply(drawArrays, this, [mode, first, count]);
      },
    });
    Object.defineProperty(webGl, 'drawElements', {
      configurable: true,
      value(
        this: WebGLRenderingContext,
        mode: number,
        count: number,
        type: number,
        offset: number,
      ) {
        evidence.drawElements += 1;
        Reflect.apply(drawElements, this, [mode, count, type, offset]);
      },
    });

    const webGl2 = WebGL2RenderingContext.prototype;
    const drawArraysInstanced: unknown = Object.getOwnPropertyDescriptor(
      webGl2,
      'drawArraysInstanced',
    )?.value;
    const drawElementsInstanced: unknown = Object.getOwnPropertyDescriptor(
      webGl2,
      'drawElementsInstanced',
    )?.value;
    if (typeof drawArraysInstanced !== 'function' || typeof drawElementsInstanced !== 'function') {
      throw new Error('WebGL2 instanced draw functions are unavailable');
    }
    Object.defineProperty(webGl2, 'drawArraysInstanced', {
      configurable: true,
      value(
        this: WebGL2RenderingContext,
        mode: number,
        first: number,
        count: number,
        instanceCount: number,
      ) {
        evidence.drawArraysInstanced += 1;
        Reflect.apply(drawArraysInstanced, this, [mode, first, count, instanceCount]);
      },
    });
    Object.defineProperty(webGl2, 'drawElementsInstanced', {
      configurable: true,
      value(
        this: WebGL2RenderingContext,
        mode: number,
        count: number,
        type: number,
        offset: number,
        instanceCount: number,
      ) {
        evidence.drawElementsInstanced += 1;
        Reflect.apply(drawElementsInstanced, this, [mode, count, type, offset, instanceCount]);
      },
    });
  });

  await page.goto('/');
  expect(new URL(page.url()).origin).toBe('http://127.0.0.1:4101');

  const canvas = page.locator('.canvas-frame canvas');
  await expect(
    canvas,
    'The production capability probe must mount CanvasStage rather than the semantic fallback',
  ).toBeVisible();

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const evidence = window.__canvasStageDrawEvidence;
          if (!evidence) return 0;
          return (
            evidence.drawArrays +
            evidence.drawArraysInstanced +
            evidence.drawElements +
            evidence.drawElementsInstanced
          );
        }),
      { message: 'CanvasStage must issue a real WebGL draw call', timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  const rendererEvidence = await canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error('CanvasStage did not mount an HTML canvas');
    }
    const context = element.getContext('webgl2');
    if (!context) {
      return { available: false } as const;
    }
    return {
      available: true,
      drawingBufferHeight: context.drawingBufferHeight,
      drawingBufferWidth: context.drawingBufferWidth,
      isContextLost: context.isContextLost(),
      version: String(context.getParameter(context.VERSION)),
    } as const;
  });

  expect(rendererEvidence.available).toBe(true);
  if (!rendererEvidence.available) return;
  expect(rendererEvidence.drawingBufferWidth).toBeGreaterThan(0);
  expect(rendererEvidence.drawingBufferHeight).toBeGreaterThan(0);
  expect(rendererEvidence.isContextLost).toBe(false);
  expect(rendererEvidence.version).toContain('WebGL 2.0');
  expect(canvasStageResponses).toHaveLength(1);
  const [canvasStageResponse] = canvasStageResponses;
  if (!canvasStageResponse)
    throw new Error('CanvasStage production chunk response was not observed');
  expect(new URL(canvasStageResponse).origin).toBe('http://127.0.0.1:4101');
});
