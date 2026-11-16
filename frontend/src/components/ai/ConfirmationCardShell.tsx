'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { PendingAction } from '@/types/ai';

interface ConfirmationCardShellProps {
  title: string;
  action: PendingAction;
  onConfirm: () => void;
  onCancel: () => void;
  /** What the card shows once the action is confirmed (message, result, link). */
  confirmed: ReactNode;
  children: ReactNode;
}

/**
 * The frame of a confirmation card: title, body and the Approve / Cancel
 * footer with its pending, saving, confirmed, cancelled, expired and error
 * states. The body and the confirmed content are the card's own.
 */
export function ConfirmationCardShell({
  title,
  action,
  onConfirm,
  onCancel,
  confirmed,
  children,
}: ConfirmationCardShellProps) {
  const t = useTranslations('ai.confirmAction');
  const { status } = action;

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/60 dark:bg-blue-900/20 overflow-hidden">
      <div className="px-3 py-2 border-b border-blue-200 dark:border-blue-900/60">
        <span className="text-sm font-semibold text-blue-800 dark:text-blue-200">{title}</span>
      </div>
      <div className="px-3 py-2 space-y-2">{children}</div>
      <div className="px-3 py-2 border-t border-blue-200 dark:border-blue-900/60">
        {status === 'pending' && (
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={onConfirm}>
              {t('approve')}
            </Button>
          </div>
        )}
        {status === 'confirming' && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" isLoading disabled>
              {t('submitting')}
            </Button>
          </div>
        )}
        {status === 'confirmed' && confirmed}
        {status === 'cancelled' && (
          <span className="text-sm text-gray-500 dark:text-gray-400">{t('cancelled')}</span>
        )}
        {status === 'expired' && (
          <span className="text-sm text-gray-500 dark:text-gray-400">{t('expired')}</span>
        )}
        {status === 'error' && (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-red-600 dark:text-red-400">{action.errorMessage || t('error')}</span>
            <Button variant="outline" size="sm" onClick={onConfirm}>
              {t('retry')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
