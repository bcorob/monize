'use client';

import { ReactNode } from 'react';

interface DonutCenterTotalProps {
  /** Caption above the figure, e.g. "Total". */
  label: ReactNode;
  /**
   * The aggregate figure to show in the hole. Already localized by the caller
   * (through `useNumberFormat`), so this component never formats a number
   * itself -- it only positions one.
   */
  value: ReactNode;
  /**
   * Width in pixels the caption and figure may take, for a chart that knows
   * its hole's size; they wrap inside it rather than running onto the ring.
   */
  maxWidth?: number;
  className?: string;
}

/**
 * The total that belongs in a donut's empty centre, absolutely positioned over
 * the chart so the hole stops being wasted space on a phone.
 *
 * It is an OVERLAY, not part of the chart: the caller makes the chart's own box
 * `relative` and drops this beside the `ResponsiveContainer`. The container is
 * `pointer-events-none` so a hover still reaches the slices beneath it, while
 * the figure itself re-enables pointer events so a `PartialTotal` marker inside
 * `value` stays hoverable. The figure is sized to its own content (not a
 * full-width block), so pointer events return ONLY over the text and the ring
 * around the hole keeps receiving hover everywhere else.
 *
 * The figure is never truncated: money must stay legible, and a `PartialTotal`
 * passed as `value` carries a trailing `*` marker and its info trigger that
 * clipping would hide -- a subtotal must not be dressed up as a total. It wraps
 * if it must rather than losing a character.
 *
 * The figure is passed already formatted -- this file names no formatter and no
 * separator, which is what keeps it out of the number-locale guard: a number a
 * person reads is localized by the caller's `useNumberFormat`, here as
 * everywhere.
 */
export function DonutCenterTotal({ label, value, maxWidth, className }: DonutCenterTotalProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center ${className ?? ''}`}
    >
      <div className="flex max-w-full flex-col items-center" style={maxWidth === undefined ? undefined : { maxWidth }}>
        <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
        <span className="pointer-events-auto mt-0.5 inline-flex max-w-full flex-wrap items-center justify-center text-base font-semibold text-gray-900 dark:text-gray-100 sm:text-lg">
          {value}
        </span>
      </div>
    </div>
  );
}
