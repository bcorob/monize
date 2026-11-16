'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AuthShell } from '@/components/auth/AuthShell';
import { authApi } from '@/lib/auth';

type Status = 'confirming' | 'success' | 'error';

function ConfirmEmailChangeContent() {
  const t = useTranslations('auth.confirmEmailChange');
  const ta = useTranslations('auth');
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  // A missing token can never confirm, so start straight in the error state.
  const [status, setStatus] = useState<Status>(token ? 'confirming' : 'error');
  // The token is single-use: React's double-invoked effect (dev/strict mode)
  // must not spend it twice and turn a success into an error.
  const confirmStarted = useRef(false);

  useEffect(() => {
    if (!token || confirmStarted.current) return;
    confirmStarted.current = true;
    (async () => {
      try {
        await authApi.confirmEmailChange(token);
        setStatus('success');
      } catch {
        setStatus('error');
      }
    })();
  }, [token]);

  if (status === 'confirming') {
    return (
      <div className="text-center text-gray-500 dark:text-gray-400">
        {t('confirming')}
      </div>
    );
  }

  const isSuccess = status === 'success';
  return (
    <div className="text-center space-y-4">
      <div
        className={
          isSuccess
            ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg p-4'
            : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4'
        }
      >
        <p
          className={
            isSuccess
              ? 'text-sm text-green-800 dark:text-green-200'
              : 'text-sm text-red-800 dark:text-red-200'
          }
        >
          {isSuccess ? t('successMessage') : t('errorMessage')}
        </p>
      </div>
      <Link
        href="/login"
        className="inline-block font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
      >
        {ta('backToSignIn')}
      </Link>
    </div>
  );
}

export default function ConfirmEmailChangePage() {
  const t = useTranslations('auth.confirmEmailChange');
  const tc = useTranslations('common');
  return (
    <AuthShell title={t('title')} subtitle={t('subtitle')}>
      <Suspense fallback={<div className="text-center text-gray-500 dark:text-gray-400">{tc('loading')}</div>}>
        <ConfirmEmailChangeContent />
      </Suspense>
    </AuthShell>
  );
}
