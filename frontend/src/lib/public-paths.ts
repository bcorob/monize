/**
 * Routes reachable without a session. The proxy lets these through without an
 * auth cookie, and the What's New digest does not auto-open on them: they are
 * the screens that tell the visitor they are signed out.
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/login',
  '/register',
  '/auth/callback',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/confirm-email-change',
  '/emergency-access/claim',
];

export function isPublicPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PUBLIC_PATHS.some((path) => pathname.startsWith(path));
}
