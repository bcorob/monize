'use client';

import { useTranslations } from 'next-intl';
import { CalendarDaysIcon, TableCellsIcon } from '@heroicons/react/24/outline';
import type { ViewMode } from '@/store/viewModeStore';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (view: ViewMode) => void;
}

/**
 * The segmented control that switches a screen between its table and its
 * month calendar.
 *
 * Icons rather than words, because of where it sits: the calendar toolbar's
 * right-hand end beside a legend, and the register's grey strip beside the
 * "Showing 1-25 of 90" line. Both rows compete for width on a phone, and a
 * table and a month grid are two of the few things a pictogram says faster than
 * a label. The words survive as the accessible name and the tooltip, so the
 * control is still named for a screen reader and for anyone who hovers it.
 *
 * It wears `InvestmentViewToggle`'s chrome, deliberately: the two sit side by
 * side in the Investments toolbar, so a second styling of the same idea would
 * read as two different kinds of switch. Both take it from
 * `segmented-control.ts` rather than each spelling it out, which is how the
 * two last drifted apart.
 */
export function ViewModeToggle({ value, onChange }: ViewModeToggleProps) {
  const t = useTranslations('calendar');

  return (
    <div
      className={SEGMENTED_GROUP_CLASS}
      role="group"
      aria-label={t('view.label')}
    >
      <button
        type="button"
        onClick={() => onChange('table')}
        aria-pressed={value === 'table'}
        aria-label={t('view.table')}
        title={t('view.table')}
        className={`${segmentClass(value === 'table')} px-2`}
      >
        <TableCellsIcon className="w-4 h-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onChange('calendar')}
        aria-pressed={value === 'calendar'}
        aria-label={t('view.calendar')}
        title={t('view.calendar')}
        className={`${segmentClass(value === 'calendar')} px-2`}
      >
        <CalendarDaysIcon className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
