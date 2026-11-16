import { describe, it, expect } from 'vitest';
import {
  buildAssumptions,
  buildHistoryPoints,
  fractionToPercent,
  monthRange,
  offerBenchmarks,
  sortOffer,
} from './bond-offer';
import type { HistorySeries, OfferSeries } from '@/types/bond';

function offer(
  seriesCode: string,
  periodMonths: number,
  periodCount: number,
  annualized: string | null,
  rule: Partial<OfferSeries['rateRule']> = {},
): OfferSeries {
  return {
    instrumentId: seriesCode,
    issuerCountryCode: 'PL',
    issuerCode: 'PL_MF',
    programCode: 'X',
    seriesCode,
    currency: 'PLN',
    saleWindow: { from: '2026-10-01', to: '2026-10-31' },
    periodMonths,
    periodCount,
    lengthDays: null,
    rateRule: {
      type: 'FIXED',
      benchmarkId: null,
      annualRate: '0.0300',
      firstPeriodRate: null,
      addend: null,
      benchmarkFloor: null,
      ...rule,
    },
    capitalization: 'NONE',
    redemption: null,
    termsSource: { provider: 'p', url: 'u', document: 'd' },
    projection: {
      maturityValue: null,
      totalReturn: null,
      annualizedReturn: annualized,
      projected: false,
      assumptions: [],
      projectionMissing: [],
    },
  };
}

describe('sortOffer by length', () => {
  it('orders a term counted in days beside one counted in months', () => {
    const months = offer('M', 1, 1, '0.0300');
    const days = { ...offer('D', 0, 0, '0.0300'), lengthDays: 28 };
    const long = { ...offer('L', 0, 0, '0.0300'), lengthDays: 120 };
    expect(sortOffer([long, months, days], 'length', 'asc').map((s) => s.seriesCode)).toEqual([
      'D',
      'M',
      'L',
    ]);
  });
});

describe('sortOffer', () => {
  const a = offer('A', 12, 3, '0.0440');
  const b = offer('B', 3, 1, '0.0300', { annualRate: '0.0250' });
  const c = offer('C', 12, 4, null, { type: 'BENCHMARK_PLUS_SPREAD', annualRate: null, firstPeriodRate: '0.0560' });
  const d = offer('D', 12, 1, '0.0440');

  it('puts an unknown figure last in both directions', () => {
    expect(sortOffer([c, a, b], 'annualizedReturn', 'desc').map((s) => s.seriesCode)).toEqual(['A', 'B', 'C']);
    expect(sortOffer([c, a, b], 'annualizedReturn', 'asc').map((s) => s.seriesCode)).toEqual(['B', 'A', 'C']);
  });

  it('sorts by the whole length in months', () => {
    expect(sortOffer([a, b, c, d], 'length', 'asc').map((s) => s.seriesCode)).toEqual(['B', 'D', 'A', 'C']);
  });

  it('sorts by the first-period rate, a fixed rule using its annual rate', () => {
    expect(sortOffer([a, b, c], 'firstPeriodRate', 'desc').map((s) => s.seriesCode)).toEqual(['C', 'A', 'B']);
  });

  it('keeps the server order for ties and does not mutate its input', () => {
    const input = [d, a];
    expect(sortOffer(input, 'annualizedReturn', 'desc').map((s) => s.seriesCode)).toEqual(['D', 'A']);
    expect(input.map((s) => s.seriesCode)).toEqual(['D', 'A']);
  });
});

describe('offerBenchmarks', () => {
  it('lists each benchmark once, in first-seen order, and none for fixed rules', () => {
    const cpi = { type: 'INFLATION_PLUS_MARGIN_AS_RATE' as const, benchmarkId: 'PL_CPI_GUS_YOY' };
    const nbp = { type: 'BENCHMARK_PLUS_SPREAD' as const, benchmarkId: 'PL_NBP_REFERENCE' };
    expect(
      offerBenchmarks([offer('A', 12, 1, null), offer('B', 12, 1, null, cpi), offer('C', 12, 1, null, nbp), offer('D', 12, 1, null, cpi)]),
    ).toEqual(['PL_CPI_GUS_YOY', 'PL_NBP_REFERENCE']);
  });
});

describe('assumptions', () => {
  it('sends the typed percents as fractions, ordered, and skips cleared or out-of-range fields', () => {
    expect(
      buildAssumptions({ PL_NBP_REFERENCE: 4, PL_CPI_GUS_YOY: 2.9, GONE: undefined, TOO_BIG: 101, TOO_SMALL: -51 }),
    ).toEqual([
      { benchmarkId: 'PL_CPI_GUS_YOY', value: '0.0290' },
      { benchmarkId: 'PL_NBP_REFERENCE', value: '0.0400' },
    ]);
  });

  it('keeps zero, a legitimate assumption', () => {
    expect(buildAssumptions({ PL_CPI_GUS_YOY: 0 })).toEqual([{ benchmarkId: 'PL_CPI_GUS_YOY', value: '0.0000' }]);
  });

  it('shows a fraction as a percent to two places', () => {
    expect(fractionToPercent('0.0290')).toBe(2.9);
    expect(fractionToPercent('-0.005')).toBe(-0.5);
  });
});

describe('history points', () => {
  const s = (code: string, from: string, rate: string | null, annual: string | null, fee: string | null): HistorySeries => ({
    seriesCode: code,
    saleWindow: { from, to: from.slice(0, 8) + '28' },
    firstPeriodRate: rate,
    annualRate: annual,
    addend: rate === null ? null : '0.0200',
    fee,
    proceedsFloor: null,
    termsVersion: 1,
    termsSource: { provider: 'p', url: 'u', document: 'd' },
  });

  it('has one point per month of the coverage, with null values for a missing month', () => {
    const points = buildHistoryPoints(
      [s('A', '2025-11-01', '0.0560', null, '2.00'), s('C', '2026-01-01', null, '0.0600', null)],
      { from: '2025-11', to: '2026-01', missingMonths: ['2025-12'] },
    );
    expect(points).toEqual([
      { month: '2025-11', seriesCode: 'A', rate: 5.6, addend: 2, fee: 2 },
      { month: '2025-12', seriesCode: null, rate: null, addend: null, fee: null },
      { month: '2026-01', seriesCode: 'C', rate: 6, addend: null, fee: null },
    ]);
  });

  it('falls back to the span of the series when the coverage has no bounds', () => {
    const points = buildHistoryPoints([s('A', '2026-02-01', '0.05', null, null)], {
      from: null,
      to: null,
      missingMonths: [],
    });
    expect(points.map((p) => p.month)).toEqual(['2026-02']);
    expect(buildHistoryPoints([], { from: null, to: null, missingMonths: [] })).toEqual([]);
  });

  it('leaves a series without a sale window out of the chart', () => {
    const noWindow = { ...s('A', '2026-02-01', '0.05', null, null), saleWindow: null };
    expect(buildHistoryPoints([noWindow], { from: '2026-02', to: '2026-02', missingMonths: [] })).toEqual([
      { month: '2026-02', seriesCode: null, rate: null, addend: null, fee: null },
    ]);
  });

  it('crosses a year boundary and rejects a malformed bound', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthRange('2025-13', '2026-02')).toEqual([]);
    expect(monthRange('2026-03', '2026-01')).toEqual([]);
  });
});
