import { describe, it, expect } from 'vitest';
import {
  CHART_MAX_POINTS,
  axisKeyFor,
  axisTickLabel,
  bucketFlowSeries,
  sampleStockSeries,
} from './chart-sampling';

describe('sampleStockSeries', () => {
  it('leaves a series that already fits alone', () => {
    const rows = Array.from({ length: CHART_MAX_POINTS }, (_, i) => i);
    expect(sampleStockSeries(rows)).toEqual(rows);
  });

  it('returns a copy rather than the caller\'s array', () => {
    const rows = [1, 2, 3];
    expect(sampleStockSeries(rows)).not.toBe(rows);
  });

  it('reduces a long series to at most the point budget, plus the kept rows', () => {
    const rows = Array.from({ length: 360 }, (_, i) => i);
    const sampled = sampleStockSeries(rows);
    // A stride of ceil(360/60) = 6 yields 60 rows (0, 6, ... 354); index 359 is
    // not among them and is appended, so the budget is a bound and not a count.
    expect(sampled).toHaveLength(CHART_MAX_POINTS + 1);
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(359);
  });

  it('always keeps the last row, even when the stride steps past it', () => {
    const rows = Array.from({ length: 121 }, (_, i) => i);
    const sampled = sampleStockSeries(rows);
    expect(sampled[sampled.length - 1]).toBe(120);
  });

  it('keeps the rows `keep` marks, whatever the stride', () => {
    const rows = Array.from({ length: 600 }, (_, i) => i);
    // 401 is not a multiple of the stride (10), so only `keep` saves it.
    const sampled = sampleStockSeries(rows, { keep: (row) => row === 401 });
    expect(sampled).toContain(401);
  });

  it('emits every index once, in order', () => {
    const rows = Array.from({ length: 200 }, (_, i) => i);
    const sampled = sampleStockSeries(rows, { keep: (_row, index) => index % 4 === 0 });
    expect(new Set(sampled).size).toBe(sampled.length);
    expect([...sampled].sort((a, b) => a - b)).toEqual(sampled);
  });

  it('handles an empty series', () => {
    expect(sampleStockSeries([])).toEqual([]);
  });
});

describe('bucketFlowSeries', () => {
  const sum = (group: number[]) => group.reduce((total, n) => total + n, 0);

  it('passes a series that already fits through one row at a time', () => {
    const rows = [1, 2, 3];
    expect(bucketFlowSeries(rows, sum)).toEqual([1, 2, 3]);
  });

  it('conserves every value -- no period is dropped', () => {
    const rows = Array.from({ length: 500 }, (_, i) => i + 1);
    const bucketed = bucketFlowSeries(rows, sum);
    expect(sum(bucketed)).toBe(sum(rows));
  });

  it('stays within the point budget', () => {
    const rows = Array.from({ length: 500 }, () => 1);
    expect(bucketFlowSeries(rows, sum).length).toBeLessThanOrEqual(CHART_MAX_POINTS);
  });

  it('never merges across a boundary', () => {
    // 101 historical rows then 99 projected. The group size is ceil(200/60) = 4
    // and the groups start at 0, 4, 8 ... 100, so the transition falls INSIDE
    // the group starting at 100 -- the boundary has to flush it early. Splitting
    // 100/100 instead puts the transition exactly on a group start, where the
    // case passes with the boundary mechanism deleted.
    const rows = [
      ...Array.from({ length: 101 }, () => ({ value: 1, projected: false })),
      ...Array.from({ length: 99 }, () => ({ value: 1, projected: true })),
    ];
    const bucketed = bucketFlowSeries(
      rows,
      (group) => ({
        value: group.reduce((total, row) => total + row.value, 0),
        kinds: new Set(group.map((row) => row.projected)).size,
      }),
      { boundary: (row) => row.projected },
    );
    expect(bucketed.every((bucket) => bucket.kinds === 1)).toBe(true);
    expect(bucketed.reduce((total, bucket) => total + bucket.value, 0)).toBe(200);
    // The flush is visible: one bucket is shorter than the group size because
    // the run ended inside it.
    expect(bucketed.some((bucket) => bucket.value === 1)).toBe(true);
  });

  it('hands each bucket its own position', () => {
    // A bucket's label is not an identity -- two buckets can share one -- so the
    // position is what a caller builds an axis key from.
    const rows = Array.from({ length: 200 }, () => 1);
    const positions = bucketFlowSeries(rows, (_group, index) => index);
    expect(positions).toEqual(positions.map((_value, index) => index));

    // And on the pass-through path, where the series already fits.
    expect(bucketFlowSeries([1, 2, 3], (_group, index) => index)).toEqual([0, 1, 2]);
  });

  it('keeps one bucket per run when the runs outnumber the budget', () => {
    // Alternating rows: 120 runs of one row each. Merging any two would put two
    // kinds in one bar, so the budget yields to the boundary.
    const rows = Array.from({ length: 120 }, (_, i) => i % 2 === 0);
    const bucketed = bucketFlowSeries(rows, (group) => group.length, {
      boundary: (row) => row,
      maxPoints: 10,
    });
    expect(bucketed).toHaveLength(120);
  });

  it('handles an empty series', () => {
    expect(bucketFlowSeries([], sum)).toEqual([]);
  });
});

describe('axis keys', () => {
  it('gives two rows under one label two identities', () => {
    // The month a real payment and a projected one share is one chart row on
    // each side of the line. Recharts keys its axis, its tooltip lookup and
    // every ReferenceLine on the datum's own value, so under one label the two
    // collapse onto one category.
    const historical = axisKeyFor(0, 'Aug 2026');
    const projected = axisKeyFor(1, 'Aug 2026');
    expect(historical).not.toBe(projected);
    expect(axisTickLabel(historical)).toBe('Aug 2026');
    expect(axisTickLabel(projected)).toBe('Aug 2026');
  });

  it('prints back a label holding the separator', () => {
    // The position comes first precisely so the cut is unambiguous.
    expect(axisTickLabel(axisKeyFor(7, 'a|b'))).toBe('a|b');
  });

  it('prints back a bucket span', () => {
    expect(axisTickLabel(axisKeyFor(12, 'Sep 2026 \u2013 Nov 2026'))).toBe(
      'Sep 2026 \u2013 Nov 2026',
    );
  });

  it('passes through a value that is not an axis key', () => {
    // Recharts hands a tick formatter whatever the axis holds, and a formatter
    // that throws takes the chart with it.
    expect(axisTickLabel('Aug 2026')).toBe('Aug 2026');
    expect(axisTickLabel(100)).toBe('100');
  });
});
