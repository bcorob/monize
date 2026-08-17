/**
 * Chart colour tokens for Recharts components.
 *
 * These are CSS variable references, not hex values: passing them straight
 * into Recharts `fill` / `stroke` / `stopColor` props makes every chart
 * follow the active colour theme AND light/dark mode automatically, with no
 * JS recomputation on theme change. The variables are defined in
 * `src/app/globals.css` (defaults) and overridden per theme in
 * `src/app/themes.css`.
 *
 * Do not use these for user-chosen entity colours (tags, categories,
 * payees) -- those come from the database and are intentionally not themed.
 */
export const chartColors = {
  /** Accent-coloured series (balance lines, primary bars). Follows the theme accent. */
  primary: 'var(--chart-primary)',
  /** Income / gains / positive values. */
  income: 'var(--chart-income)',
  /** Expenses / losses / negative values. */
  expense: 'var(--chart-expense)',
  /** Warnings, projections, secondary highlights. */
  warning: 'var(--chart-warning)',
  /** CartesianGrid stroke and axis lines. */
  grid: 'var(--chart-grid)',
  /** Axis tick label fill. */
  axis: 'var(--chart-axis)',
  /**
   * The card colour behind the chart. Use it for the ring around a marker dot
   * (min/max flags, active points): the ring exists to separate the dot from
   * the line beneath it, so it has to be the background, not white -- a white
   * ring on a dark card is an outline rather than a gap.
   */
  surface: 'var(--chart-surface)',
  /**
   * Unclassified data -- an "Other" slice, an item with no colour assigned.
   * Deliberately recessive so it never reads as a real series.
   */
  neutral: 'var(--chart-neutral)',
} as const;

/** Categorical palette for multi-series charts (pies, stacked bars, multi-line). */
export const CHART_SERIES = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
  'var(--chart-9)',
  'var(--chart-10)',
] as const;

/** Cycle through the categorical palette for series index `i`. */
export function chartSeriesColor(i: number): string {
  return CHART_SERIES[i % CHART_SERIES.length];
}

/**
 * Categorical colour for series `i` in a chart that *also* draws a
 * `chartColors.primary` series -- a total, a benchmark, an aggregate line the
 * members sit beside.
 *
 * `--chart-1` is the theme accent in every palette, which is what
 * `--chart-primary` is too, so `chartSeriesColor(0)` would hand the first
 * member the total's own colour and make the two indistinguishable in the
 * chart, the legend and the tooltip. The first slot is excluded from the cycle
 * entirely rather than merely deferred -- a modulo over the full palette gives
 * it back on the tenth series, which is the same collision arriving late. Use
 * `chartSeriesColor` when there is no primary series to collide with.
 */
export function chartSeriesColorAsidePrimary(i: number): string {
  const usable = CHART_SERIES.length - 1;
  return CHART_SERIES[1 + (i % usable)];
}
