'use client';

import { useTranslations } from 'next-intl';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { Warranty, WarrantyStatus } from '@/types/warranty';

const STATUS_VARIANT: Record<WarrantyStatus, BadgeVariant> = {
  lifetime: 'blue',
  active: 'green',
  expiring: 'amber',
  expired: 'red',
};

/** A year is 365 days here; `daysLeft` is a day count, so no calendar is consulted. */
const DAYS_PER_YEAR = 365;

type WarrantyStatusFields = Pick<Warranty, 'status' | 'daysLeft'>;

/**
 * The days-left line for a warranty, from the server's `daysLeft`: "12 days
 * left", "3 years, 321 days left" from a year up, "Expires today", "Expired 3 days ago", or `null` for a lifetime
 * warranty (which has no `daysLeft`). Formatting only; whether a warranty is
 * expiring or expired is the server's `status` (WTY-002), and nothing here
 * compares two dates.
 */
export function useWarrantyDaysLeftText(): (warranty: WarrantyStatusFields) => string | null {
  const t = useTranslations('warranties');
  const { formatNumber } = useNumberFormat();
  return (warranty) => {
    const { daysLeft } = warranty;
    if (daysLeft === null) return null;
    if (daysLeft === 0) return t('daysLeft.today');
    const count = Math.abs(daysLeft);
    if (count >= DAYS_PER_YEAR) {
      const yearsCount = Math.floor(count / DAYS_PER_YEAR);
      const daysCount = count % DAYS_PER_YEAR;
      const values = { yearsCount, daysCount, years: formatNumber(yearsCount, 0), days: formatNumber(daysCount, 0) };
      return daysLeft > 0 ? t('daysLeft.leftYears', values) : t('daysLeft.agoYears', values);
    }
    const days = formatNumber(count, 0);
    return daysLeft > 0 ? t('daysLeft.left', { count, days }) : t('daysLeft.ago', { count, days });
  };
}

interface WarrantyStatusBadgeProps {
  warranty: WarrantyStatusFields;
  /** Also print the days-left line beside the pill. */
  showDaysLeft?: boolean;
  className?: string;
}

/**
 * A warranty's status pill, fed by the server's `status` and `daysLeft`
 * (docs/specs/warranty-tracker.md WTY-002). Every surface that shows a
 * warranty's status draws it through this, so the colour and the copy for a
 * status are decided once.
 */
export function WarrantyStatusBadge({ warranty, showDaysLeft = false, className }: WarrantyStatusBadgeProps) {
  const t = useTranslations('warranties');
  const daysLeftText = useWarrantyDaysLeftText();
  const daysText = showDaysLeft ? daysLeftText(warranty) : null;

  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 ${className ?? ''}`}>
      <Badge variant={STATUS_VARIANT[warranty.status]}>{t(`status.${warranty.status}`)}</Badge>
      {daysText !== null && (
        <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{daysText}</span>
      )}
    </span>
  );
}
