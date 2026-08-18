'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { DateInput } from './DateInput';

interface DateRangeSelectorProps {
  /** Ordered list of preset range keys to display as buttons. */
  ranges: readonly string[];
  /**
   * Localized label per range key. Without it the keys are labelled by
   * `formatLabel`, whose output is English ("All Time") -- fine for the
   * abbreviation presets the dashboard widgets use, but not for a caller whose
   * labels are words. Supply this whenever a label has to be translated.
   */
  labels?: Readonly<Record<string, string>>;
  /** Currently selected range. */
  value: string;
  /** Called when a range button is clicked. */
  onChange: (range: string) => void;
  /** Whether to show a "Custom" button with date inputs. Default: false. */
  showCustom?: boolean;
  /** Custom start date (YYYY-MM-DD). Required when showCustom is true. */
  customStartDate?: string;
  /** Called when custom start date changes. */
  onCustomStartDateChange?: (date: string) => void;
  /** Custom end date (YYYY-MM-DD). Required when showCustom is true. */
  customEndDate?: string;
  /** Called when custom end date changes. */
  onCustomEndDateChange?: (date: string) => void;
  /** Active button colour class. Default: 'bg-blue-600'. */
  activeColour?: string;
  /** Button size variant. Default: 'md'. */
  size?: 'sm' | 'md';
  /** Additional className for the root container. */
  className?: string;
}

const formatLabel = (range: string): string => {
  if (range === 'ytd') return 'YTD';
  if (range === 'all') return 'All Time';
  return range.toUpperCase();
};

export function DateRangeSelector({
  ranges,
  labels,
  value,
  onChange,
  showCustom = false,
  customStartDate = '',
  onCustomStartDateChange,
  customEndDate = '',
  onCustomEndDateChange,
  activeColour = 'bg-blue-600',
  size = 'md',
  className,
}: DateRangeSelectorProps) {
  const t = useTranslations('common');
  const sizeClasses = size === 'sm'
    ? 'px-3 py-1 text-xs'
    : 'px-3 py-1.5 text-sm';

  const inactiveClasses = 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600';

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {ranges.map((range) => (
          <button
            key={range}
            onClick={() => onChange(range)}
            className={cn(
              sizeClasses,
              'font-medium rounded-md transition-colors',
              value === range
                ? `${activeColour} text-white`
                : inactiveClasses
            )}
          >
            {labels?.[range] ?? formatLabel(range)}
          </button>
        ))}
        {showCustom && (
          <button
            onClick={() => onChange('custom')}
            className={cn(
              sizeClasses,
              'font-medium rounded-md transition-colors',
              value === 'custom'
                ? `${activeColour} text-white`
                : inactiveClasses
            )}
          >
            {t('dateRange.custom')}
          </button>
        )}
      </div>
      {showCustom && value === 'custom' && (
        <div className="flex gap-4 mt-4">
          {/* `onDateChange` is the whole contract: it fires with a canonical
              YYYY-MM-DD however the user entered the date. The raw `onChange`
              beside it only ever fired from the native input a touch device
              still uses, where it reported the same change a second time; on
              the desktop text field it was never called at all. */}
          <DateInput
            label={t('dateRange.startDate')}
            value={customStartDate}
            onDateChange={(date) => onCustomStartDateChange?.(date)}
          />
          <DateInput
            label={t('dateRange.endDate')}
            value={customEndDate}
            onDateChange={(date) => onCustomEndDateChange?.(date)}
          />
        </div>
      )}
    </div>
  );
}
