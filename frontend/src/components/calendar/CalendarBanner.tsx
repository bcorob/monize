'use client';

import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

/**
 * One cause a figure in this month is missing, and what would repair it.
 *
 * A withheld figure names its cause where it is withheld; the banner is the
 * month's composition of every cause present, so a reader who sees three
 * unknown markers learns once why, rather than hunting three tooltips.
 */
export interface CalendarCause {
  /** Stable per cause, so the same cause is not listed twice. */
  key: string;
  message: string;
}

interface CalendarBannerProps {
  causes: readonly CalendarCause[];
}

export function CalendarBanner({ causes }: CalendarBannerProps) {
  const t = useTranslations('calendar');

  if (causes.length === 0) return null;

  return (
    <div
      className="mb-3 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/20"
      role="status"
    >
      <ExclamationTriangleIcon
        className="w-5 h-5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div>
        <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
          {t('banner.title')}
        </p>
        <ul className="mt-1 space-y-0.5 text-sm text-amber-700 dark:text-amber-300">
          {causes.map((cause) => (
            <li key={cause.key}>{cause.message}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
