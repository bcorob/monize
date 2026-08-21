'use client';

import { useEffect, useRef } from 'react';
import { AxiosError } from 'axios';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const logger = createLogger('PwaLifecycle');

// If the PWA was hidden longer than this, re-validate the session on resume.
// iOS frequently keeps the WebView alive in BFCache, which can leave the
// app showing stale authenticated state when the session has expired; a
// resume past this threshold (or any BFCache restore) re-checks the profile
// and, only when that check comes back an auth failure, forces a hard
// replace to /login for a clean boot.
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function PwaLifecycleHandler() {
  const lastHiddenAt = useRef<number | null>(null);
  const revalidating = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const isStandalonePwa = (): boolean => {
      try {
        return (
          window.matchMedia('(display-mode: standalone)').matches ||
          // iOS Safari standalone flag
          (window.navigator as Navigator & { standalone?: boolean }).standalone === true
        );
      } catch {
        return false;
      }
    };

    const onResume = async (source: 'visibility' | 'pageshow', persisted = false) => {
      const hiddenAt = lastHiddenAt.current;
      const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
      lastHiddenAt.current = null;

      if (revalidating.current) return;

      // pageshow with persisted=true means BFCache restore — JS state is frozen.
      // Always re-validate in this case regardless of how long it was hidden.
      const isStaleResume = persisted || hiddenFor >= STALE_THRESHOLD_MS;
      if (!isStaleResume) return;

      const { isAuthenticated } = useAuthStore.getState();
      logger.debug(
        `Resume detected (source=${source}, persisted=${persisted}, hiddenFor=${hiddenFor}ms, auth=${isAuthenticated})`
      );

      // If the user wasn't authenticated, they're already on a public page —
      // nothing to do.
      if (!isAuthenticated) return;

      revalidating.current = true;
      try {
        await authApi.getProfile();
      } catch (error) {
        const status =
          error instanceof AxiosError ? error.response?.status : undefined;

        // 502 / network: backend unreachable — let the existing connection
        // banner handle it. Don't navigate.
        if (status === 502 || (error instanceof AxiosError && !error.response)) {
          return;
        }

        // Genuine auth failure on resume. The 401 interceptor in api.ts will
        // already trigger logout + redirect on its own, but in PWA standalone
        // mode `window.location.href` redirects after a BFCache restore can
        // be unreliable. Force a hard replace to guarantee a clean boot of
        // the login page.
        if (isStandalonePwa() && typeof window !== 'undefined') {
          logger.info('PWA resume with invalid session — forcing reload to /login');
          useAuthStore.getState().logout();
          window.location.replace('/login');
        }
      } finally {
        revalidating.current = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenAt.current = Date.now();
      } else if (document.visibilityState === 'visible') {
        void onResume('visibility');
      }
    };

    const onPageShow = (event: PageTransitionEvent) => {
      // persisted=true => restored from BFCache (iOS PWA common case)
      if (event.persisted) {
        void onResume('pageshow', true);
      }
    };

    const onPageHide = () => {
      lastHiddenAt.current = Date.now();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  return null;
}
