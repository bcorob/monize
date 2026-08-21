import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { render } from '@/test/render';
import {
  OfflineFallbackSync,
  OFFLINE_STRINGS_MESSAGE_TYPE,
} from './OfflineFallbackSync';

describe('OfflineFallbackSync', () => {
  const postMessage = vi.fn();
  let styleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    postMessage.mockClear();
    Object.defineProperty(window.navigator, 'serviceWorker', {
      value: {
        ready: Promise.resolve({ active: { postMessage } }),
      },
      configurable: true,
    });
    styleSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'rgb(16, 24, 40)',
      color: 'rgb(243, 244, 246)',
    } as CSSStyleDeclaration);
  });

  afterEach(() => {
    styleSpy.mockRestore();
    delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  async function renderAndFlush() {
    await act(async () => {
      render(<OfflineFallbackSync />);
    });
    // The handshake is deferred an animation frame so ThemeProvider's own
    // effects have painted; drain the frame and the serviceWorker.ready chain.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await act(async () => {});
  }

  it('hands the service worker the localized strings, theme and page colours', async () => {
    await renderAndFlush();

    expect(postMessage).toHaveBeenCalledWith({
      type: OFFLINE_STRINGS_MESSAGE_TYPE,
      payload: {
        lang: 'en',
        dir: 'ltr',
        theme: 'light',
        background: 'rgb(16, 24, 40)',
        foreground: 'rgb(243, 244, 246)',
        title: 'Unable to connect',
        message:
          'Monize could not reach the server. Check your connection and try again.',
        retry: 'Try again',
      },
    });
  });

  it('does nothing when service workers are unavailable', async () => {
    delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
    await renderAndFlush();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
