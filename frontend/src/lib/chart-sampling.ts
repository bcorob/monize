/**
 * Chart down-sampling: the reduction a long series needs before it can be
 * drawn, and nothing else.
 *
 * A chart cannot render a thousand points legibly, so a long series is reduced
 * first. That reduction is a *rendering* decision: no count, total, export or
 * other business figure may be derived from a reduced series. The Debt Payoff
 * Timeline reported "Payments Made" as the number of retained chart samples,
 * so a loan with 300 payments claimed about 60 (issue #1244).
 *
 * A series is one of two kinds, and they reduce differently:
 *
 *   - A **stock** -- a balance, a running total -- has a value AT a point in
 *     time. Showing every Nth point drops resolution; every point still drawn
 *     still means exactly what it meant. `sampleStockSeries`.
 *   - A **flow** -- the principal and interest a period paid -- only means
 *     anything OVER an interval. Dropping a point deletes the interval it
 *     stood for, so the periods between two drawn bars silently vanish.
 *     `bucketFlowSeries` sums contiguous groups instead, so every input row
 *     reaches the output.
 *
 * Picking the wrong one is the defect, not a matter of taste: a sampled flow
 * chart is a chart of a subset presented as the whole.
 */

/**
 * The point budget a recharts category axis stays legible within. Shared so
 * the two reductions below, and any test that reasons about them, name one
 * number.
 */
export const CHART_MAX_POINTS = 60;

/**
 * Every Nth row of a stock series, always including the first and the last, and
 * always including any row `keep` marks.
 *
 * The result holds at most `maxPoints` strided rows plus the final row and
 * whatever `keep` saved -- a budget, not an exact count. Ask it for the series
 * to DRAW; never for how many of anything there are.
 *
 * `keep` exists for the points that carry meaning beyond their value -- the
 * last historical row and the first projected one, which the balance chart
 * joins its two areas at and draws its "Today" line on. Sampled away, the
 * marker lands on whichever month the stride happened to retain, which can be
 * years off.
 *
 * Returns a new array; the rows themselves are passed through by reference.
 */
export function sampleStockSeries<T>(
  rows: readonly T[],
  options: {
    maxPoints?: number;
    keep?: (row: T, index: number) => boolean;
  } = {},
): T[] {
  const maxPoints = options.maxPoints ?? CHART_MAX_POINTS;
  if (rows.length <= maxPoints || maxPoints <= 0) return [...rows];

  const step = Math.ceil(rows.length / maxPoints);
  const indices = new Set<number>();
  for (let i = 0; i < rows.length; i += step) indices.add(i);
  indices.add(rows.length - 1);
  if (options.keep) {
    for (let i = 0; i < rows.length; i++) {
      if (options.keep(rows[i], i)) indices.add(i);
    }
  }
  return [...indices].sort((a, b) => a - b).map((index) => rows[index]);
}

/**
 * A flow series reduced by SUMMING contiguous groups, so no period is dropped.
 *
 * `combine` receives each group in order, with the group's position among the
 * groups, and returns the row to draw -- it owns the aggregation (summing the
 * amounts, labelling the span) because only the caller knows what its fields
 * mean. The position is there so a bucket can carry an identity its label
 * cannot supply: two buckets legitimately share a label (the month a real
 * payment and a projected one both fall in appears once on each side of the
 * boundary), and a recharts category axis, tooltip lookup and ReferenceLine all
 * key on the datum's own value.
 *
 * `boundary`, when supplied, forces a group break between two rows it answers
 * differently for. The payoff charts use it so a bucket never straddles the
 * history/projection line: one bar cannot honestly be half measured and half
 * predicted.
 *
 * The group size is `ceil(rows.length / maxPoints)`, so a series with no
 * boundaries lands within the budget. Boundaries are the one thing that may
 * push past it: each run is grouped from its own start, so the bound is
 * `maxPoints + (runs - 1)` -- and a series with more runs than the budget
 * yields one bar per run, because merging across a boundary is the one thing
 * this may not do. Both reductions therefore hand back a budget, never a
 * count.
 */
export function bucketFlowSeries<T, R>(
  rows: readonly T[],
  combine: (group: T[], index: number) => R,
  options: {
    maxPoints?: number;
    boundary?: (row: T) => unknown;
  } = {},
): R[] {
  const maxPoints = options.maxPoints ?? CHART_MAX_POINTS;
  if (rows.length === 0) return [];
  if (rows.length <= maxPoints || maxPoints <= 0) {
    return rows.map((row, index) => combine([row], index));
  }

  const groupSize = Math.ceil(rows.length / maxPoints);
  const groups: T[][] = [];
  let current: T[] = [];
  let currentKey: unknown;
  for (const row of rows) {
    const key = options.boundary ? options.boundary(row) : undefined;
    const crossesBoundary = current.length > 0 && key !== currentKey;
    if (crossesBoundary || current.length === groupSize) {
      groups.push(current);
      current = [];
    }
    if (current.length === 0) currentKey = key;
    current.push(row);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, index) => combine(group, index));
}

/**
 * Separates a chart row's position from its label inside an axis key.
 *
 * The position comes FIRST so the separator is unambiguous whatever the label
 * holds: `axisTickLabel` cuts at the first occurrence, and no label -- a
 * localized month, a range spanning two of them -- begins with one.
 */
const AXIS_KEY_SEPARATOR = '|';

/**
 * A chart row's identity on a category axis: its position, then its label.
 *
 * A label is not an identity. Two rows legitimately share one -- the month a
 * real payment and a projected payment both fall in is one row on each side of
 * the history/projection line, and a bucketed flow row is labelled as the span
 * it covers -- while recharts keys its category axis, its tooltip lookup and
 * every ReferenceLine on the datum's own value. Two rows under one label
 * collapse onto one category, and a marker drawn there lands on whichever came
 * first. Give the chart `axisKey` as its `dataKey` and `axisTickLabel` as its
 * `tickFormatter`: the identity is unique, the tick still reads "Aug 2026".
 */
export function axisKeyFor(position: number, label: string): string {
  return `${position}${AXIS_KEY_SEPARATOR}${label}`;
}

/**
 * The label an axis key prints.
 *
 * A value that is not an axis key comes back unchanged: recharts hands a tick
 * formatter whatever the axis holds, and a formatter that throws takes the
 * chart with it.
 */
export function axisTickLabel(value: string | number): string {
  const key = String(value);
  const separator = key.indexOf(AXIS_KEY_SEPARATOR);
  return separator === -1 ? key : key.slice(separator + 1);
}
