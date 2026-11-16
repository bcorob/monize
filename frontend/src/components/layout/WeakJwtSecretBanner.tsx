'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { adminApi, DeploymentStatus } from '@/lib/admin';
import { createLogger } from '@/lib/logger';

const logger = createLogger('WeakJwtSecretBanner');

/**
 * Where a dismissal is remembered. `sessionStorage`, deliberately: the banner
 * reports a security misconfiguration only the operator can fix, so it comes
 * back in every new browser session until JWT_SECRET is replaced, rather than
 * staying silenced forever by one click. It holds a flag and nothing else, and
 * no zustand store persists it (`src/store/persisted-storage.guard.test.ts`
 * governs those).
 */
export const WEAK_JWT_SECRET_BANNER_DISMISSED_KEY = 'monize:weak-jwt-secret-banner-dismissed';

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(WEAK_JWT_SECRET_BANNER_DISMISSED_KEY) === '1';
  } catch {
    // Storage blocked: the banner shows, and dismissing lasts for this page.
    return false;
  }
}

function rememberDismissed(): void {
  try {
    window.sessionStorage.setItem(WEAK_JWT_SECRET_BANNER_DISMISSED_KEY, '1');
  } catch {
    // As above.
  }
}

/**
 * Admin-only banner for a JWT_SECRET that is long enough to boot but weak (a
 * published placeholder, or a typed pattern). The server starts with it and
 * says so in its log and in a weekly system alert; this is the copy an
 * administrator sees without opening either. Regular users never fetch the
 * status, and could not fix it.
 */
export function WeakJwtSecretBanner() {
  const t = useTranslations('layout');
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  const isAdmin = isAuthenticated && user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    adminApi
      .getDeploymentStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err) => {
        // Non-critical: the same finding reaches the admin as a system alert.
        logger.debug('Failed to fetch deployment status', err);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin || dismissed || status?.jwtSecretWeakness == null) return null;

  const handleDismiss = () => {
    rememberDismissed();
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 px-4 py-2 text-center text-sm text-amber-800 dark:text-amber-200"
    >
      <span className="font-semibold">{t('jwtSecretBanner.label')}</span>{' '}
      {t.rich('jwtSecretBanner.detail', {
        code: (chunks) => (
          <code className="bg-amber-100 dark:bg-amber-800/50 px-1 rounded text-xs">{chunks}</code>
        ),
        users: (chunks) => (
          <Link
            href="/admin/users"
            className="underline font-medium hover:text-amber-900 dark:hover:text-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
          >
            {chunks}
          </Link>
        ),
      })}
      <button
        type="button"
        onClick={handleDismiss}
        className="ml-3 text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 underline text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
        aria-label={t('jwtSecretBanner.dismissAriaLabel')}
      >
        {t('jwtSecretBanner.dismiss')}
      </button>
    </div>
  );
}
