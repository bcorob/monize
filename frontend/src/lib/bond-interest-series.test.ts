import { describe, it, expect } from 'vitest';
import { buildBondInterestSeries } from './bond-interest-series';
import type { BondRateScheduleEntry } from '@/types/bond';

const entry = (
  index: number,
  over: Partial<BondRateScheduleEntry> = {},
): BondRateScheduleEntry => ({
  index,
  start: `${2026 + index}-10-01`,
  end: `${2027 + index}-10-01`,
  annualRate: '0.0500',
  rateSource: 'DERIVED',
  benchmark: null,
  addend: null,
  interest: '0',
  fixedPart: '0',
  benchmarkPart: '0',
  addendPart: '0',
  announcedPart: '0',
  ...over,
});

// EDO1036, per bond (values computed independently with python fractions): period 1
// 5.35 fixed; period 2 (base 105.35, CPI 3.4% + 2%) 3.5819 + 2.107; period 3
// projected at CPI 5% (base 111.0389): 5.551945 + 2.220778.
const edo = [
  entry(1, { rateSource: 'TERMS', interest: '5.35', fixedPart: '5.35' }),
  entry(2, {
    interest: '5.6889',
    benchmarkPart: '3.5819',
    addendPart: '2.107',
  }),
  entry(3, {
    rateSource: 'PROJECTED',
    interest: '7.772723',
    benchmarkPart: '5.551945',
    addendPart: '2.220778',
  }),
];

describe('buildBondInterestSeries', () => {
  it('sums the per-period parts cumulatively for the whole holding', () => {
    const { points, unknownFromPeriod, hasAnnounced } = buildBondInterestSeries(
      edo,
      10,
    );
    expect(unknownFromPeriod).toBeNull();
    expect(hasAnnounced).toBe(false);
    expect(points.map((p) => [p.index, p.projected])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(points[0]).toMatchObject({ fixed: 53.5, margin: 0, inflation: 0 });
    expect(points[1]).toMatchObject({
      fixed: 53.5,
      margin: 21.07,
      inflation: 35.819,
    });
    // Per bond, period 3: 2.107 + 2.220778 = 4.327778 and 3.5819 + 5.551945 =
    // 9.133845, each shown to the 4 places the running total is kept in.
    expect(buildBondInterestSeries(edo, 1).points[2]).toMatchObject({
      fixed: 5.35,
      margin: 4.3278,
      inflation: 9.1338,
    });
  });

  it('does not accumulate float error over many periods', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      entry(i + 1, { fixedPart: '0.1', interest: '0.1' }),
    );
    expect(buildBondInterestSeries(many, 1).points[9].fixed).toBe(1);
  });

  it('stops at the first period with an unknown part, never carrying a subtotal on', () => {
    const unknown = entry(3, {
      annualRate: null,
      rateSource: null,
      interest: null,
      fixedPart: null,
      benchmarkPart: null,
      addendPart: null,
      announcedPart: null,
    });
    const result = buildBondInterestSeries(
      [...edo.slice(0, 2), unknown, entry(4)],
      10,
    );
    expect(result.points.map((p) => p.index)).toEqual([1, 2]);
    expect(result.unknownFromPeriod).toBe(3);
  });

  it('reports an announced period and carries it in its own series', () => {
    const result = buildBondInterestSeries(
      [
        edo[0],
        entry(2, {
          rateSource: 'ANNOUNCED',
          interest: '5.2675',
          announcedPart: '5.2675',
        }),
      ],
      2,
    );
    expect(result.hasAnnounced).toBe(true);
    expect(result.points[1]).toMatchObject({ announced: 10.535, margin: 0 });
  });

  it('is an empty known series for no periods', () => {
    expect(buildBondInterestSeries([], 3)).toEqual({
      points: [],
      unknownFromPeriod: null,
      hasAnnounced: false,
    });
  });
});
