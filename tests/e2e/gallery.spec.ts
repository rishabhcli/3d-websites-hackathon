import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

test('serves the real gallery shell and semantic canvas equivalent', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Multi-view anamorphic sculpture gallery');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Stand where the mark is.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'The same field, described.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Side/ })).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: /Side/ }).click();
  await expect(page).toHaveURL(/#station-02$/u);
  await expect(page.getByRole('button', { name: /Side/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[aria-current="true"]')).toContainText('Side observation');

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('uses the semantic fallback when WebGL2 is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
    const original: unknown = descriptor?.value;
    if (typeof original !== 'function') throw new Error('Canvas getContext is unavailable');
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value(this: HTMLCanvasElement, contextId: string, ...arguments_: unknown[]) {
        if (contextId === 'webgl2') return null;
        const result: unknown = Reflect.apply(original, this, [contextId, ...arguments_]);
        return result;
      },
    });
  });
  await page.goto('/');
  await expect(page.getByText('Semantic gallery active')).toBeVisible();
  await page.getByRole('button', { name: /Elevated/u }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#station-03$/u);
});

test('honours reduced motion while preserving authored descriptions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The same field, described.' })).toBeVisible();
  await page.getByRole('button', { name: /Side/u }).click();
  await expect(page.locator('[aria-current="true"]')).toContainText('Side observation');
});
