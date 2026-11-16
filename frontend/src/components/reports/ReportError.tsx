'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';

interface ReportErrorProps {
  /** Optional override message; defaults to a generic load-failure note. */
  message?: string;
  /** When provided, renders a "Try Again" button that re-runs the fetch. */
  onRetry?: () => void;
}

/**
 * Shared error panel for report components. Reports previously swallowed fetch
 * errors and rendered an empty state, leaving the user unsure whether there was
 * genuinely no data or the request had failed. Paired with `useReportData`, this
 * gives every adopting report a visible, retryable error state.
 */
export function ReportError({ message, onRetry }: ReportErrorProps) {
  const t = useTranslations('reports');
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
      <p className="text-sm text-red-600 dark:text-red-400">
        {message || t('error.defaultMessage')}
      </p>
      {onRetry && (
        <Button type="button" size="sm" onClick={onRetry} className="mt-3">
          {t('error.retry')}
        </Button>
      )}
    </div>
  );
}
