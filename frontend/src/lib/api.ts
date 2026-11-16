import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import Cookies from 'js-cookie';
import { useAuthStore } from '@/store/authStore';
import { createLogger } from '@/lib/logger';
import { isSigningOut } from '@/lib/logout-state';
import { clearUndoRefused } from '@/lib/undoRedoSignal';

const logger = createLogger('API');

// Use relative URL - Next.js rewrites handle routing to backend
export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000,
  withCredentials: true,
});

function detectBrowserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

// Request interceptor to add CSRF token and the browser's timezone so the
// backend can compute "today" in the user's local timezone rather than the
// server's (which would misclassify late-evening tomorrow-dated transactions
// for users west of UTC).
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const csrfToken = Cookies.get('csrf_token');
    if (csrfToken && config.headers) {
      config.headers['X-CSRF-Token'] = csrfToken;
    }
    if (config.headers && !config.headers['X-Client-Timezone']) {
      const tz = detectBrowserTimezone();
      if (tz) {
        config.headers['X-Client-Timezone'] = tz;
      }
    }
    logger.debug(`${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

// Endpoints where a 401 is a business response (wrong credentials, wrong
// 2FA code, email already belongs to a delegate that needs claiming, ...)
// rather than an expired session. The refresh-and-retry dance below would
// log the visitor out and bounce them to /login otherwise -- swallowing
// the inline error the calling page needs to show.
const UNAUTH_ENDPOINTS: ReadonlyArray<string> = [
  '/auth/register',
  '/auth/login',
  '/auth/2fa/verify',
  '/auth/forgot-password',
  '/auth/reset-password',
];

function isUnauthEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  return UNAUTH_ENDPOINTS.some(
    (path) => url === path || url.startsWith(path + '?'),
  );
}

// Response interceptor to handle errors
let isLoggingOut = false;
let isRefreshingCsrf = false;
let csrfRefreshPromise: Promise<boolean> | null = null;
let isRefreshingToken = false;
let tokenRefreshPromise: Promise<boolean> | null = null;
let failedQueue: Array<{
  resolve: (config: InternalAxiosRequestConfig) => void;
  reject: (error: any) => void;
  config: InternalAxiosRequestConfig;
}> = [];

function processQueue(success: boolean) {
  failedQueue.forEach(({ resolve, reject, config }) => {
    if (success) {
      // Re-read CSRF token for queued requests
      const csrfToken = Cookies.get('csrf_token');
      if (csrfToken && config.headers) {
        config.headers['X-CSRF-Token'] = csrfToken;
      }
      resolve(config);
    } else {
      reject(new Error('Token refresh failed'));
    }
  });
  failedQueue = [];
}

async function refreshCsrfToken(): Promise<boolean> {
  try {
    await axios.get('/api/v1/auth/csrf-refresh', { withCredentials: true });
    logger.info('CSRF token refreshed');
    return true;
  } catch (_) {
    return false;
  }
}

async function postTokenRefresh(): Promise<boolean> {
  try {
    // Use raw axios to avoid interceptor recursion; refresh_token cookie sent automatically
    await axios.post('/api/v1/auth/refresh', {}, { withCredentials: true });
    logger.info('Access token refreshed');
    return true;
  } catch (_) {
    logger.warn('Token refresh failed');
    return false;
  }
}

// One refresh per browser, not per tab. Every tab sends the same refresh
// cookie, and two tabs presenting it together read as token theft on the
// server, which signed every session out. A tab that waits on this lock sends
// the cookie the holder's response already rotated. Without the Web Locks API
// the per-tab single flight below still applies, and the server's short
// rotation grace answers the second tab.
const TOKEN_REFRESH_LOCK = 'monize-token-refresh';

async function attemptTokenRefresh(): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return postTokenRefresh();
  try {
    return await locks.request(TOKEN_REFRESH_LOCK, postTokenRefresh);
  } catch (_) {
    // The lock itself was refused (an opaque origin, a disabled API); the
    // refresh never ran, so run it unlocked.
    return postTokenRefresh();
  }
}

// Exported for non-axios callers (e.g. `fetch`-based SSE streams) so they can
// match the axios interceptor's 401 refresh-and-retry behavior.
export { attemptTokenRefresh };

apiClient.interceptors.response.use(
  (response) => {
    // Any successful write (a new action, a redo, a successful undo) changes
    // the history head, so a refused Undo may succeed again.
    if (response.config?.method && response.config.method !== 'get') clearUndoRefused();
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _csrfRetried?: boolean;
      _authRetried?: boolean;
      /**
       * Opt this request out of the 401 recovery below.
       *
       * For best-effort work that deliberately outlives the session it belongs
       * to -- the push cleanup a sign-out starts and does not wait for. Left in,
       * its 401 lands after the session is already gone and drives a refresh
       * attempt and a hard `window.location.replace('/login')`, racing the
       * sign-out's own navigation and discarding its toast.
       */
      _skipAuthRedirect?: boolean;
    };

    // Handle 502 (backend unavailable) or network errors (no response at all).
    // A client-side timeout (axios code ECONNABORTED / ERR_CANCELED) means the
    // backend was simply slow to answer this specific request; it does NOT
    // indicate the backend is down, so skip the banner in that case.
    const isClientTimeout =
      error.code === 'ECONNABORTED' || error.code === 'ERR_CANCELED';
    if (
      !isClientTimeout &&
      (error.response?.status === 502 || !error.response)
    ) {
      const { useConnectionStore } = await import('@/store/connectionStore');
      useConnectionStore.getState().setBackendDown();
      return Promise.reject(error);
    }

    // Handle 403 CSRF errors — attempt transparent refresh and retry
    if (
      error.response?.status === 403 &&
      !originalRequest?._csrfRetried &&
      typeof (error.response?.data as any)?.message === 'string' &&
      (error.response.data as any).message.includes('CSRF token')
    ) {
      originalRequest._csrfRetried = true;

      if (!isRefreshingCsrf) {
        isRefreshingCsrf = true;
        csrfRefreshPromise = refreshCsrfToken();
      }

      const refreshed = await csrfRefreshPromise;
      isRefreshingCsrf = false;
      csrfRefreshPromise = null;

      if (refreshed) {
        const newCsrfToken = Cookies.get('csrf_token');
        if (newCsrfToken && originalRequest.headers) {
          originalRequest.headers['X-CSRF-Token'] = newCsrfToken;
        }
        return apiClient(originalRequest);
      }

      logger.warn('CSRF refresh failed, session expired');
    }

    // Handle 401 — attempt token refresh before logging out
    if (
      error.response?.status === 401 &&
      !originalRequest?._authRetried &&
      !originalRequest?._skipAuthRedirect &&
      !isLoggingOut &&
      !isSigningOut() &&
      !isUnauthEndpoint(originalRequest?.url)
    ) {
      originalRequest._authRetried = true;

      // If a refresh is already in progress, queue this request
      if (isRefreshingToken) {
        return new Promise<InternalAxiosRequestConfig>((resolve, reject) => {
          failedQueue.push({ resolve, reject, config: originalRequest });
        }).then((config) => apiClient(config));
      }

      isRefreshingToken = true;
      tokenRefreshPromise = attemptTokenRefresh();

      const refreshed = await tokenRefreshPromise;
      isRefreshingToken = false;
      tokenRefreshPromise = null;

      if (refreshed) {
        // Update CSRF token for retried requests
        const newCsrfToken = Cookies.get('csrf_token');
        if (newCsrfToken && originalRequest.headers) {
          originalRequest.headers['X-CSRF-Token'] = newCsrfToken;
        }
        processQueue(true);
        return apiClient(originalRequest);
      }

      // Refresh failed — log out
      processQueue(false);
      isLoggingOut = true;
      logger.warn('Token refresh failed, logging out');
      const { logout } = useAuthStore.getState();
      logout();

      try {
        await axios.post('/api/v1/auth/logout', {}, { withCredentials: true });
      } catch (_) {
        // Ignore
      }

      if (
        typeof window !== 'undefined' &&
        !window.location.pathname.includes('/login')
      ) {
        // Use replace() rather than assigning href so the post-401 page does
        // not stay in history. On PWAs (especially iOS standalone), an
        // assigned href can be deferred during BFCache restore and leave the
        // app stuck on the splash screen until force-quit; replace() is
        // synchronous and doesn't accumulate a back-button trap.
        window.location.replace('/login');
      }
      isLoggingOut = false;
    }

    return Promise.reject(error);
  },
);

export default apiClient;
