import { describe, it, expect } from 'vitest';
import { safeReturnTo } from './return-to';

const ORIGIN = 'https://monize.example';

describe('safeReturnTo', () => {
  it('keeps a same-origin path with its query string and fragment', () => {
    expect(
      safeReturnTo('/api/v1/oauth-consent/abc?x=1&y=%2F#frag', ORIGIN),
    ).toBe('/api/v1/oauth-consent/abc?x=1&y=%2F#frag');
    expect(safeReturnTo('/share?files=2', ORIGIN)).toBe('/share?files=2');
  });

  // Each of these starts with one slash and is not "//" or "/\", so a prefix
  // rule accepts it; the URL parser strips tab, CR and LF and reads a
  // protocol-relative URL to another origin.
  it.each([
    ['tab', '/\t/evil.example'],
    ['CR', '/\r/evil.example'],
    ['LF', '/\n/evil.example'],
    ['tab before the second slash with a path', '/\t/evil.example/login?x=1'],
    ['backslash', '/\\evil.example'],
    ['backslash after a tab', '/\t\\evil.example'],
    ['protocol-relative', '//evil.example'],
    ['absolute https URL', 'https://evil.example/'],
    ['absolute URL on this host but another scheme', 'http://monize.example/'],
    ['javascript: URL', 'javascript:alert(1)'],
    ['data: URL', 'data:text/html,hi'],
  ])('refuses a value that leaves the origin (%s)', (_label, value) => {
    expect(safeReturnTo(value, ORIGIN)).toBeNull();
  });

  it('refuses a relative path, whose meaning depends on the current page', () => {
    expect(safeReturnTo('dashboard', ORIGIN)).toBeNull();
  });

  it('refuses empty and missing values', () => {
    expect(safeReturnTo('', ORIGIN)).toBeNull();
    expect(safeReturnTo(null, ORIGIN)).toBeNull();
    expect(safeReturnTo(undefined, ORIGIN)).toBeNull();
  });

  it('resolves against the page origin by default', () => {
    expect(safeReturnTo('/bills')).toBe('/bills');
    expect(safeReturnTo('/\t/evil.example')).toBeNull();
  });
});
