'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /**
   * Drawn in place of the label. The label stays the accessible name and the
   * tooltip, so an icon segment is still named for a screen reader and for
   * anyone who hovers it.
   */
  icon?: ReactNode;
}

interface WidgetSegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  className?: string;
  /** Names the group for a screen reader when the segments are icons. */
  ariaLabel?: string;
}

/**
 * A small segmented button group for widget settings that are a mutually
 * exclusive choice (e.g. region/exchange/country, overview/by day).
 *
 * Its own chrome rather than `ui/segmented-control.ts`: these sit on a widget
 * header, not in a toolbar pill. An option may carry an `icon`, which is how a
 * widget fits two switches on one header line -- and the icon control keeps
 * this chrome rather than borrowing `ViewModeToggle`'s, because the two sit
 * side by side and a second styling of the same idea reads as two different
 * kinds of switch.
 */
export function WidgetSegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: WidgetSegmentedControlProps<T>) {
  return (
    <div
      className={cn('flex flex-wrap gap-2', className)}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          aria-label={option.icon ? option.label : undefined}
          title={option.icon ? option.label : undefined}
          className={cn(
            'text-sm font-medium rounded-md transition-colors motion-reduce:transition-none',
            option.icon ? 'px-2 py-1.5' : 'px-3 py-1.5',
            value === option.value
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600',
          )}
        >
          {option.icon ?? option.label}
        </button>
      ))}
    </div>
  );
}
