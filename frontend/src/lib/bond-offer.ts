import { percentToFraction } from '@/components/securities/detail/SecurityBondScenarioPanel';
import type { BondAssumption, HistorySeries, OfferSeries } from '@/types/bond';

/**
 * The country requested only while a security's valuation, which names its
 * program's own country, has not arrived. A bond's offer and history always ask
 * for the program's `issuerCountryCode`.
 */
export const BOND_OFFER_COUNTRY = 'PL';

/** The bounds, in percent, an assumed benchmark value may take; the server's own. */
export const ASSUMPTION_MIN_PERCENT = -50;
export const ASSUMPTION_MAX_PERCENT = 100;

export type OfferSortField = 'annualizedReturn' | 'length' | 'firstPeriodRate';
export type OfferSortDirection = 'asc' | 'desc';

/** Length of the term in months: period length times the number of periods. */
export function offerLengthMonths(series: OfferSeries): number {
  return series.periodMonths * series.periodCount;
}

/** Days in an average month, to put a term counted in days beside one counted in months. */
const DAYS_PER_MONTH = 365 / 12;

/** The term in months for ordering, from the days when the series is counted in days. */
function offerLengthForSort(series: OfferSeries): number {
  return series.lengthDays !== null
    ? series.lengthDays / DAYS_PER_MONTH
    : offerLengthMonths(series);
}

/**
 * The first period's rate as stated, or a fixed rule's one rate; null when the
 * terms state neither. A decimal string, converted only at the boundary.
 */
export function offerFirstPeriodRate(series: OfferSeries): string | null {
  return series.rateRule.firstPeriodRate ?? series.rateRule.annualRate;
}

function sortValue(series: OfferSeries, field: OfferSortField): number | null {
  switch (field) {
    case 'annualizedReturn':
      return series.projection.annualizedReturn === null
        ? null
        : Number(series.projection.annualizedReturn);
    case 'length':
      return offerLengthForSort(series);
    case 'firstPeriodRate': {
      const rate = offerFirstPeriodRate(series);
      return rate === null ? null : Number(rate);
    }
  }
}

/**
 * The offer in the chosen order. A figure that is unknown (null) always sorts
 * last, whatever the direction, so an unknown is never ranked as the best or
 * the worst. Ties keep the server's order.
 */
export function sortOffer(
  series: readonly OfferSeries[],
  field: OfferSortField,
  direction: OfferSortDirection,
): OfferSeries[] {
  const sign = direction === 'asc' ? 1 : -1;
  return series
    .map((s, index) => ({ s, index, v: sortValue(s, field) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.index - b.index;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return a.v === b.v ? a.index - b.index : (a.v - b.v) * sign;
    })
    .map((entry) => entry.s);
}

/** Each benchmark the rows read, once, in first-seen order. */
export function offerBenchmarks(series: readonly OfferSeries[]): string[] {
  const ids: string[] = [];
  for (const s of series) {
    const id = s.rateRule.benchmarkId;
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A fraction string as a percent number to 2 places, the resolution `percentToFraction` sends. */
export function fractionToPercent(fraction: string): number {
  return Math.round(Number(fraction) * 10000) / 100;
}

/** The `assume` entries for the percents a reader typed; a cleared field sends none. */
export function buildAssumptions(
  typed: Readonly<Record<string, number | undefined>>,
): BondAssumption[] {
  return Object.entries(typed)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .filter(
      ([, percent]) =>
        Number.isFinite(percent) &&
        percent >= ASSUMPTION_MIN_PERCENT &&
        percent <= ASSUMPTION_MAX_PERCENT,
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([benchmarkId, percent]) => ({
      benchmarkId,
      value: percentToFraction(percent),
    }));
}

/** One sale month of the history; a rate or the fee is null where the catalog holds no series. */
export interface HistoryPoint {
  /** YYYY-MM */
  month: string;
  seriesCode: string | null;
  /** Percent. The first-period rate, or a fixed rule's annual rate. */
  rate: number | null;
  /** Percent. The margin or spread. */
  addend: number | null;
  /** Currency units per bond. */
  fee: number | null;
}

const MONTH = /^(\d{4})-(\d{2})$/;

/** The months from `from` to `to` inclusive, as YYYY-MM; empty on a malformed bound. */
export function monthRange(from: string, to: string): string[] {
  const a = MONTH.exec(from);
  const b = MONTH.exec(to);
  if (!a || !b) return [];
  if (Number(a[2]) < 1 || Number(a[2]) > 12 || Number(b[2]) < 1 || Number(b[2]) > 12) return [];
  const months: string[] = [];
  let year = Number(a[1]);
  let month = Number(a[2]);
  const endIndex = Number(b[1]) * 12 + Number(b[2]);
  while (year * 12 + month <= endIndex) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

const percentOf = (fraction: string | null): number | null =>
  fraction === null ? null : Math.round(Number(fraction) * 1000000) / 10000;

/**
 * One point per sale month across the coverage, so a month the catalog does not
 * hold is a point with null values (a gap in the line), never a value carried
 * over or interpolated from its neighbours. Without coverage bounds the range
 * is the months the series themselves span.
 */
export function buildHistoryPoints(
  series: readonly HistorySeries[],
  coverage: { from: string | null; to: string | null; missingMonths: readonly string[] },
): HistoryPoint[] {
  const byMonth = new Map<string, HistorySeries>();
  for (const s of series) {
    // A series with no sale window has no month to sit in; the table still lists it.
    if (s.saleWindow === null) continue;
    const month = s.saleWindow.from.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, s);
  }
  const months = [...byMonth.keys(), ...coverage.missingMonths].sort();
  const from = coverage.from ?? months[0];
  const to = coverage.to ?? months[months.length - 1];
  if (from === undefined || to === undefined) return [];
  return monthRange(from, to).map((month) => {
    const s = byMonth.get(month);
    if (s === undefined) {
      return { month, seriesCode: null, rate: null, addend: null, fee: null };
    }
    return {
      month,
      seriesCode: s.seriesCode,
      rate: percentOf(s.firstPeriodRate ?? s.annualRate),
      addend: percentOf(s.addend),
      fee: s.fee === null ? null : Number(s.fee),
    };
  });
}

/** True for an https address only; a plain http one is not made a link where this is used. */
export function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url);
}
