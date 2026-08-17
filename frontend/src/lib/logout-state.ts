/**
 * A logout the server never confirmed.
 *
 * `/auth/logout` is the only thing that can clear the HttpOnly refresh cookie
 * and invalidate the refresh-token family. When that request fails -- network
 * drop, reverse-proxy error, a concurrent rotation -- clearing the Zustand store
 * ends the session on this tab and nothing more: the credential is still live,
 * and another tab or a later refresh can pick it back up.
 *
 * So the client clears what it owns and records that the server half did not
 * happen. The login screen reads this flag and says so, with a retry, instead of
 * showing the ordinary signed-out state. Session storage, not local: the warning
 * belongs to this browsing session, and a closed tab has taken the risk with it
 * as far as this client can tell.
 */
const KEY = 'monize:logout-incomplete';

export function markLogoutIncomplete(): void {
  try {
    window.sessionStorage.setItem(KEY, '1');
  } catch {
    // Session storage unavailable (private mode, quota). The toast raised at the
    // same moment is the fallback; there is nothing else to do here.
  }
}

export function isLogoutIncomplete(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function clearLogoutIncomplete(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
