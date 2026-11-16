import { sumMoney } from '@/lib/format';
import type {
  BondInstrumentSummary,
  BondRateRule,
  OfferSeries,
  BondLotValuation,
  BondValuation,
  SecurityBondSeries,
  SecurityBondValuation,
} from '@/types/bond';

/** The stored series of one program in one currency, ordered by code. */
export function programSeries(
  instruments: readonly BondInstrumentSummary[],
  programCode: string,
  currency: string,
  countryCode?: string,
): BondInstrumentSummary[] {
  return instruments
    .filter(
      (i) =>
        i.programCode === programCode &&
        i.currencyCode === currency &&
        (countryCode === undefined || i.issuerCountryCode === countryCode),
    )
    .sort((a, b) => a.seriesCode.localeCompare(b.seriesCode));
}

/**
 * Newest sale window first; a series with no window after those with one,
 * ties and the unwindowed by code. A new array: the input is not reordered.
 */
export function sortBySaleWindowDesc(
  instruments: readonly BondInstrumentSummary[],
): BondInstrumentSummary[] {
  return [...instruments].sort((a, b) => {
    const af = a.saleWindow?.from ?? null;
    const bf = b.saleWindow?.from ?? null;
    if (af !== bf) {
      if (af === null) return 1;
      if (bf === null) return -1;
      return bf.localeCompare(af);
    }
    return a.seriesCode.localeCompare(b.seriesCode);
  });
}

/**
 * The calendar month (YYYY-MM) a sale window spans exactly, from its first day
 * to its last; null when it is any other period.
 */
export function saleWindowMonth(window: { from: string; to: string }): string | null {
  const m = /^(\d{4})-(\d{2})-01$/.exec(window.from);
  if (m === null) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return window.to === `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` ? `${m[1]}-${m[2]}` : null;
}

/** A money total over decimal strings: null unless every part is known (a subtotal is not a total). */
function sumKnown(values: ReadonlyArray<string | null>): string | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return String(sumMoney(values.map((v) => Number(v))));
}

/** The lots of one held series, with the figures the "Your series" row shows. */
export interface HeldSeries {
  instrumentId: string;
  /** From the lots' own valuation, the one place every lot carries it. */
  seriesCode: string;
  series: SecurityBondSeries | null;
  lots: BondLotValuation[];
  quantity: number;
  /** Distinct purchase dates, oldest first (YYYY-MM-DD). */
  purchaseDates: string[];
  /** Each is null unless every lot of the series has the figure. */
  grossValue: string | null;
  accruedInterest: string | null;
  earlyRedemptionValue: string | null;
  /** The lot bought last: its current period is the one a new reader cares about. */
  latestLot: BondLotValuation;
  /** The latest maturity among the lots (YYYY-MM-DD); lots of one series share it. */
  maturityDate: string;
  /** The earliest `nextRateReset` among the series' lots; null when none has one. */
  nextRateReset: string | null;
  /** True when a lot is not fully valued. */
  incomplete: boolean;
}

/** The valuation's lots grouped by series, in the order each series first appears. */
export function groupLotsBySeries(valuation: SecurityBondValuation): HeldSeries[] {
  const order: string[] = [];
  const byId = new Map<string, BondLotValuation[]>();
  for (const lot of valuation.lots) {
    const list = byId.get(lot.instrumentId);
    if (list === undefined) {
      byId.set(lot.instrumentId, [lot]);
      order.push(lot.instrumentId);
    } else {
      list.push(lot);
    }
  }
  return order.map((instrumentId) => {
    const lots = byId.get(instrumentId) ?? [];
    const dates = [...new Set(lots.map((l) => l.purchaseDate))].sort();
    const latestLot = lots.reduce((best, l) =>
      l.purchaseDate > best.purchaseDate ? l : best,
    );
    const resets = lots
      .map((l) => l.valuation.nextRateReset)
      .filter((d): d is string => d !== null)
      .sort();
    const v = (pick: (x: BondValuation) => string | null) =>
      sumKnown(lots.map((l) => pick(l.valuation)));
    return {
      instrumentId,
      seriesCode: latestLot.valuation.seriesCode,
      series: valuation.series.find((s) => s.instrumentId === instrumentId) ?? null,
      lots,
      quantity: lots.reduce((sum, l) => sum + l.quantity, 0),
      purchaseDates: dates,
      grossValue: v((x) => x.grossValue),
      accruedInterest: v((x) => x.accruedInterest),
      earlyRedemptionValue: v((x) => x.earlyRedemptionValue),
      latestLot,
      maturityDate: lots
        .map((l) => l.valuation.maturityDate)
        .reduce((a, b) => (b > a ? b : a)),
      nextRateReset: resets[0] ?? null,
      incomplete: lots.some((l) => l.valuation.valuationComplete === false),
    };
  });
}

/** What a program's terms say, read from its newest series. */
export interface ProgramFacts {
  /** The series the facts come from. */
  seriesCode: string;
  rateRule: BondRateRule;
  /** Whole months from purchase to maturity; null when it cannot be told. */
  lengthMonths: number | null;
  /** Null when the source does not say (a held lot carries no capitalization). */
  capitalization: 'NONE' | 'COMPOUND_AT_PERIOD_END' | null;
  /** Months in one interest period; null when the source does not say (a held lot carries none). */
  periodMonths: number | null;
  /** True when the terms allow no early redemption (maturity only). */
  redeemableAtMaturityOnly: boolean;
  /** Early redemption fee per bond, a decimal string; null when there is none. */
  fee: string | null;
  /** Null when the proceeds are not floored. */
  floor: 'ALL_PERIODS' | 'FIRST_PERIOD' | null;
}

function monthsBetween(from: string, to: string): number | null {
  const a = /^(\d{4})-(\d{2})-\d{2}$/.exec(from);
  const b = /^(\d{4})-(\d{2})-\d{2}$/.exec(to);
  if (a === null || b === null) return null;
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}

/**
 * The program's rate rule, length, capitalization, fee and floor from its
 * newest series: the newest series on sale when there is one (its terms are
 * complete), otherwise the series bought last. Null when neither exists.
 */
export function programFacts(
  offerSeries: readonly OfferSeries[],
  held: readonly HeldSeries[],
  programCode: string,
): ProgramFacts | null {
  const onSale = offerSeries
    .filter((s) => s.programCode === programCode)
    .sort((a, b) => b.saleWindow.from.localeCompare(a.saleWindow.from))[0];
  if (onSale !== undefined) {
    const fee = onSale.redemption?.penalties.find((p) => p.type === 'FIXED_FEE_PER_UNIT');
    return {
      seriesCode: onSale.seriesCode,
      rateRule: onSale.rateRule,
      lengthMonths: onSale.periodMonths * onSale.periodCount,
      capitalization: onSale.capitalization,
      periodMonths: onSale.periodMonths,
      redeemableAtMaturityOnly: onSale.redemption === null,
      fee: fee?.type === 'FIXED_FEE_PER_UNIT' ? fee.amount : null,
      floor: onSale.redemption?.proceedsFloor?.appliesTo ?? null,
    };
  }
  const newest = [...held].sort((a, b) =>
    b.latestLot.purchaseDate.localeCompare(a.latestLot.purchaseDate),
  )[0];
  if (newest === undefined) return null;
  const redemption = newest.series?.redemptionTerms ?? null;
  const fee = redemption?.penalties.find((p) => p.type === 'FIXED_FEE_PER_UNIT');
  return {
    seriesCode: newest.seriesCode,
    rateRule: newest.latestLot.valuation.rateRule,
    lengthMonths: monthsBetween(newest.latestLot.purchaseDate, newest.maturityDate),
    capitalization: null,
    periodMonths: null,
    redeemableAtMaturityOnly: newest.series !== null && redemption === null,
    fee: fee?.type === 'FIXED_FEE_PER_UNIT' ? fee.amount : null,
    floor: redemption?.proceedsFloor?.appliesTo ?? null,
  };
}
