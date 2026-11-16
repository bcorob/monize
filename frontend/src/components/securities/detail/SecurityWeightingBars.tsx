'use client';

import { useMemo } from 'react';
import { chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';

/** One slice of a breakdown: a name and its share as a decimal 0-1. */
export interface WeightingSlice {
  name: string;
  weight: number;
}

interface SecurityWeightingBarsProps {
  slices: readonly WeightingSlice[] | null | undefined;
  /** Shown in place of the bars when there is nothing stored. */
  emptyMessage: string;
  /** Caption under the bars when the shares do not add up to 100%. */
  remainderLabel?: (percent: string) => string;
}

/**
 * A breakdown of one security across a dimension -- sectors, countries, and
 * (once the field exists) asset classes.
 *
 * Horizontal bars, sorted largest first, in a single hue. This is one series
 * answering "how big is each share", not eleven categories needing eleven
 * colours: a pie of eleven sectors needs a legend to be read at all, and
 * colour-coding rows whose names are already printed beside them adds nothing
 * but a colourblindness problem. Each share is labelled directly, so the bar is
 * a second reading of the number rather than the only one.
 *
 * Bars are drawn against 100%, so a 32% share fills a third of its track and the
 * empty remainder is part of the reading. They were briefly scaled against the
 * largest share instead, which drew the biggest sector full width whatever its
 * size -- a bar claiming everything beside a label saying 32% contradicts the
 * number it is supposed to restate, and that is worse than the sliver bars the
 * relative scaling was avoiding.
 *
 * Renders its empty state, not empty bars, when the data is absent. A security
 * with no sector data is not a security with zero-length bars.
 *
 * A long breakdown scrolls inside a capped height rather than growing the card
 * or hiding rows behind a button. The card sits beside the price chart, so its
 * height must not depend on whether a fund reports three sectors or eleven, nor
 * on which tab is open. An expander left a gap under the chart, and cutting the
 * list needed a click to answer a question the bars exist to answer at a glance.
 * The scrollbar is `scrollbar-slim`: the native one is a wide arrowed control
 * drawn against the figures, which is what made this look broken the first time
 * round.
 */
export function SecurityWeightingBars({
  slices,
  emptyMessage,
  remainderLabel,
}: SecurityWeightingBarsProps) {
  const { formatPercent } = useNumberFormat();

  const rows = useMemo(() => {
    const usable = (slices ?? []).filter(
      (slice) => !!slice.name && isFinite(slice.weight) && slice.weight > 0,
    );
    // Largest first: the question this answers is "what is it mostly".
    return [...usable].sort((a, b) => b.weight - a.weight);
  }, [slices]);

  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  // Providers report the classified part only, so a fund can add up to less than
  // 100%. Saying so beats letting the reader assume the rest is missing data.
  const remainder = 1 - total;
  const showRemainder =
    !!remainderLabel && rows.length > 0 && remainder > 0.005;

  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">{emptyMessage}</p>
    );
  }

  return (
    // A column, so the list can take the leftover height and the remainder note
    // stays pinned under it.
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Both a cap and a flex basis, and the cap is the part that works.
          `flex-1` alone cannot bound this: the column's height comes from the
          grid row, the row's height comes from its tallest item, and if this list
          is that item then it is sizing itself against itself. So the height has
          to be definite somewhere, and `max-h` is where. `flex-1` still lets the
          list take the slack when the chart beside it is taller. `pr-1` keeps the
          percentages off the scrollbar thumb. */}
      {/* On a phone the rows are compact bordered TILES in a two-column grid --
          a full-width horizontal bar per share eats the vertical space this
          capped card is trying to save, and the number is the reading anyway.
          From `sm` up it is the single-column bar list it has always been
          (`sm:block sm:space-y-2`), the grid inert. One `<li>` per share at
          every width, so the name and its percentage each appear exactly once. */}
      <ul className="scrollbar-slim grid max-h-56 min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:block sm:gap-0 sm:space-y-2">
        {rows.map((row) => {
          const percent = formatPercent(row.weight * 100);
          return (
            <li
              key={row.name}
              className="rounded-lg border border-gray-200 p-2 dark:border-gray-700 sm:rounded-none sm:border-0 sm:p-0"
            >
              <div className="flex items-baseline justify-between gap-2 sm:gap-3">
                <span className="truncate text-sm text-gray-700 dark:text-gray-300">
                  {row.name}
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100">
                  {percent}
                </span>
              </div>
              {/* The track is recessive; the fill carries the one hue. Rounded
                  ends, thin mark, anchored to the left baseline. Hidden on the
                  phone tile, where the percentage stands on its own. */}
              <div
                className="mt-1 hidden h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700 sm:block"
                role="img"
                aria-label={`${row.name}: ${percent}`}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    // Against the whole, not against the largest slice. The
                    // floor is only so a rounding-error share still draws
                    // something; its number is printed beside it either way.
                    width: `${Math.max(row.weight * 100, 0.5)}%`,
                    backgroundColor: chartColors.primary,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {showRemainder && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {remainderLabel(formatPercent(remainder * 100))}
        </p>
      )}
    </div>
  );
}
