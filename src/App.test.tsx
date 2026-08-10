// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/dom';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('semantic gallery fallback', () => {
  it('keeps observation meaning and keyboard-operable station state without WebGL2', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByText('Semantic gallery active')).toBeVisible();
    const side = screen.getByRole('button', { name: /Side/u });
    await user.click(side);
    expect(side).toHaveAttribute('aria-pressed', 'true');
    expect(location.hash).toBe('#station-02');
    expect(screen.getByText('Side observation').closest('li')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
});
