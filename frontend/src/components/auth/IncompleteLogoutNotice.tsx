'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { authApi } from '@/lib/auth';
import {
  isLogoutIncomplete,
  clearLogoutIncomplete,
} from '@/lib/logout-state';

/**
 * Shown on the login screen when the last sign-out cleared local state but the
 * server never confirmed it. The refresh cookie is HttpOnly, so at that point
 * the session may still be usable from another tab or a later refresh -- which
 * the ordinary signed-out screen would silently present as a completed logout.
 *
 * The retry is the only thing that can actually finish the job, so it stays on
 * screen until it succeeds rather than disappearing on a timer.
 */
export function IncompleteLogoutNotice() {
  const t = useTranslations('auth');
  // Read once on first render: sessionStorage is not reactive, and the flag only
  // changes here (on a successful retry) or on the next sign-out.
  const [visible, setVisible] = useState(() => isLogoutIncomplete());
  const [isRetrying, setIsRetrying] = useState(false);

  if (!visible) return null;

  const retry = async () => {
    setIsRetrying(true);
    try {
      await authApi.logout();
      clearLogoutIncomplete();
      setVisible(false);
      toast.success(t('signIn.logoutRetrySucceeded'));
    } catch {
      // Still unreachable. Keep the warning up -- the session is still live.
      toast.error(t('signIn.logoutRetryFailed'));
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div
      role="alert"
      className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-3"
    >
      <p className="text-sm text-amber-800 dark:text-amber-200">
        {t('signIn.logoutNotConfirmedDetail')}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={retry}
        isLoading={isRetrying}
      >
        {t('signIn.retryLogout')}
      </Button>
    </div>
  );
}
