'use client';

import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';

interface GroupToggleButtonProps {
  open: boolean;
  onToggle: () => void;
  /** The group's name (a year). */
  label: string;
  /** What the group holds, already translated ("12 prices"). */
  detail: string;
}

/**
 * The header of a collapsible year group: chevron, the year and a count.
 * Shared by the price history and the bond terms history so the two read the
 * same. The group's border and its body stay with the caller.
 */
export function GroupToggleButton({
  open,
  onToggle,
  label,
  detail,
}: GroupToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${HOVER_ROW_ON_CARD}`}
    >
      <ChevronRightIcon
        className={`h-4 w-4 flex-shrink-0 text-gray-400 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        aria-hidden="true"
      />
      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {label}
      </span>
      <span className="text-xs text-gray-500 dark:text-gray-400">{detail}</span>
    </button>
  );
}
