import { describe, it, expect, afterEach, vi } from 'vitest';
import { preferenceCookieAttributes } from './preference-cookie';

describe('preferenceCookieAttributes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the cookie Secure when the page was served over HTTPS', () => {
    vi.stubGlobal('location', { ...window.location, protocol: 'https:' });
    expect(preferenceCookieAttributes()).toEqual({
      sameSite: 'lax',
      expires: 365,
      secure: true,
    });
  });

  it('omits Secure over plain HTTP, where the browser would drop the cookie', () => {
    vi.stubGlobal('location', { ...window.location, protocol: 'http:' });
    expect(preferenceCookieAttributes()).toEqual({
      sameSite: 'lax',
      expires: 365,
    });
  });
});
