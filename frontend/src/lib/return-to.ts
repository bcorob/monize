import { safeNotificationTarget } from '@/lib/notification-target';

/**
 * Where to send the browser after sign-in: a `returnTo` query parameter, or the
 * path the login page (or a step-up) stashed in sessionStorage before an OIDC
 * round trip.
 *
 * Decided by the same mechanism as a notification's target
 * (`safeNotificationTarget`): the value is resolved against this origin and
 * accepted only when it stays on it, and the parser's own path is returned. A
 * prefix rule (starts with `/`, not `//`, not `/\`) is not enough: the parser
 * strips tab, CR and LF, so `/<tab>/evil.example` passes every prefix test and
 * still navigates to `https://evil.example/`.
 *
 * Returns `null` when the value is not a path on this origin; the caller's own
 * default (the dashboard) answers instead.
 */
export function safeReturnTo(
  value: string | null | undefined,
  origin?: string,
): string | null {
  return origin === undefined
    ? safeNotificationTarget(value)
    : safeNotificationTarget(value, origin);
}
