/**
 * Where a notification sends the reader.
 *
 * The server stores `target` as a same-origin path, and this checks it again
 * before anything routes to it: "the server promised" is not a mechanism on the
 * client, and `router.push` with a cross-origin URL is an open redirect. The
 * promise is also weaker than it looks -- backup restore inserts the column
 * verbatim, so a crafted artifact plants a target the write door never saw.
 *
 * It RESOLVES rather than pattern-matching the prefix, because a prefix test
 * cannot see what the URL parser will do. `/<tab>/evil.example` starts with one
 * slash, not two, and is not `/\` -- so every prefix rule accepts it -- and the
 * parser strips the tab and reads `//evil.example`, a different origin. The same
 * holds for CR and LF. Resolving is also what the service worker does with a
 * push payload's target (`public/sw.js`), so the two surfaces now decide by one
 * mechanism rather than by two rules that have to be kept in agreement;
 * `notification-target.contract.test.ts` runs the same cases through both.
 *
 * Returns the resolved path, or `null` when the target is not somewhere on this
 * origin. It refuses rather than repairing: a target we cannot vouch for is
 * dropped, and the caller's own fallback answers instead.
 */
export function safeNotificationTarget(
  target: string | null | undefined,
  origin: string = typeof window === 'undefined' ? '' : window.location.origin,
): string | null {
  if (typeof target !== 'string' || target.length === 0) return null;
  if (!origin) return null;
  // Still required: a target is an absolute path, not something whose meaning
  // depends on what it is resolved against. `budgets/b-1` would resolve
  // against the current page and mean a different thing on every route.
  if (!target.startsWith('/')) return null;

  let resolved: URL;
  try {
    resolved = new URL(target, origin);
  } catch {
    return null;
  }
  if (resolved.origin !== origin) return null;
  return resolved.pathname + resolved.search + resolved.hash;
}
