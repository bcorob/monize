import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { BootSplashHider } from './BootSplashHider';
import { BOOT_SPLASH_ID } from '@/components/layout/BootSplash';

describe('BootSplashHider', () => {
  beforeEach(() => {
    document.getElementById(BOOT_SPLASH_ID)?.remove();
  });

  it('hides the boot splash on mount without detaching it', () => {
    const splash = document.createElement('div');
    splash.id = BOOT_SPLASH_ID;
    document.body.appendChild(splash);

    render(<BootSplashHider />);

    // Regression: the first implementation called .remove(), which detaches
    // a React-owned node outside React -- the next client-side navigation
    // then crashed the reconciler (insertBefore/removeChild NotFoundError)
    // and every page rendered the error boundary. The splash must still be
    // exactly where the server put it, merely invisible.
    const after = document.getElementById(BOOT_SPLASH_ID);
    expect(after).not.toBeNull();
    expect(after?.parentElement).toBe(document.body);
    expect(after?.style.display).toBe('none');
  });

  it('is a no-op when no boot splash exists', () => {
    expect(() => render(<BootSplashHider />)).not.toThrow();
  });
});
