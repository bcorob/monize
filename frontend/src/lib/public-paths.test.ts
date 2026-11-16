import { describe, it, expect } from 'vitest';
import { isPublicPath } from './public-paths';

describe('isPublicPath', () => {
  it.each(['/login', '/login?returnTo=%2Fbills', '/register', '/reset-password/abc', '/emergency-access/claim'])(
    'treats %s as public',
    (path) => {
      expect(isPublicPath(path)).toBe(true);
    },
  );

  it.each(['/', '/dashboard', '/rules', '/change-password', '/settings'])(
    'treats %s as protected',
    (path) => {
      expect(isPublicPath(path)).toBe(false);
    },
  );

  it('treats a missing pathname as protected', () => {
    expect(isPublicPath(null)).toBe(false);
    expect(isPublicPath(undefined)).toBe(false);
  });
});
