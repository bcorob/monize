import { sumMoney } from '@/lib/format';
import type { HeldSeries } from '@/lib/bond-series';

/** One row of a bond breakdown: a label and its gross value; null is unknown, never zero. */
export interface BondBreakdownRow {
  key: string;
  label: string;
  value: number | null;
}

/** A group's value: null unless every part is known (a subtotal is not a total). */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return sumMoney(values as number[]);
}

function seriesValue(series: HeldSeries): number | null {
  return series.grossValue === null ? null : Number(series.grossValue);
}

/** Largest first, unknown rows after the known ones. */
function byValueDesc(a: BondBreakdownRow, b: BondBreakdownRow): number {
  if (a.value === null && b.value === null) return a.label.localeCompare(b.label);
  if (a.value === null) return 1;
  if (b.value === null) return -1;
  return b.value - a.value;
}

/** One row per held series, by its gross value. */
export function breakdownBySeries(held: readonly HeldSeries[]): BondBreakdownRow[] {
  return held
    .map((s) => ({ key: s.instrumentId, label: s.seriesCode, value: seriesValue(s) }))
    .sort(byValueDesc);
}

/** The held series grouped by the year of their maturity date, oldest year first. */
export function breakdownByMaturityYear(
  held: readonly HeldSeries[],
): BondBreakdownRow[] {
  const byYear = new Map<string, Array<number | null>>();
  for (const s of held) {
    const year = s.maturityDate.slice(0, 4);
    const list = byYear.get(year);
    if (list === undefined) byYear.set(year, [seriesValue(s)]);
    else list.push(seriesValue(s));
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, values]) => ({ key: year, label: year, value: sumKnown(values) }));
}

/**
 * The shares of the rows, in percent units, keyed by row. Only when every row is
 * known and the total is positive: a share of an incomplete total is not a share.
 * `complete` says whether the rows can be read as a whole.
 */
export function breakdownShares(rows: readonly BondBreakdownRow[]): {
  complete: boolean;
  shares: Map<string, number>;
} {
  const complete = rows.length > 0 && rows.every((r) => r.value !== null);
  const shares = new Map<string, number>();
  if (!complete) return { complete, shares };
  const total = sumMoney(rows.map((r) => r.value as number));
  if (total > 0) {
    for (const r of rows) shares.set(r.key, ((r.value as number) / total) * 100);
  }
  return { complete, shares };
}
