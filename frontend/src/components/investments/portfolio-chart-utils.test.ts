import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildIntradayCacheKey,
  ChartFlagShadowFilter,
  clearAllIntradayCache,
  computeMinMaxFlagIndices,
  computeTightYAxisDomain,
  INTRADAY_CACHE_PREFIX,
  INTRADAY_RANGES,
  intradayRangeParam,
  niceAxisStep,
  trimIntradayPoints,
  readIntradayCache,
  renderChartFlagDot,
  renderMinMaxFlagDots,
  writeIntradayCache,
} from './portfolio-chart-utils';

describe('intradayRangeParam', () => {
  it('serves mtd from the rolling 1m series', () => {
    expect(intradayRangeParam('mtd')).toBe('1m');
  });

  it('passes every other intraday range through unchanged', () => {
    for (const range of ['1d', '1w', '1m']) {
      expect(intradayRangeParam(range)).toBe(range);
    }
  });

  it('maps every intraday range onto one the endpoint accepts', () => {
    // The backend's IntradayValueQueryDto enum. A range added to
    // INTRADAY_RANGES without a mapping here is a 400 at runtime.
    const accepted = new Set(['1d', '1w', '1m']);
    for (const range of INTRADAY_RANGES) {
      expect(accepted.has(intradayRangeParam(range))).toBe(true);
    }
  });
});

describe('trimIntradayPoints', () => {
  const points = [
    { timestamp: '2026-07-28T13:30:00.000Z', value: 1 },
    { timestamp: '2026-08-01T13:30:00.000Z', value: 2 },
    { timestamp: '2026-08-12T13:30:00.000Z', value: 3 },
  ];

  it('drops the bars the rolling month reached back into', () => {
    expect(trimIntradayPoints(points, 'mtd', '2026-08-01')).toEqual([
      points[1],
      points[2],
    ]);
  });

  it('keeps a bar that starts exactly on the window boundary', () => {
    expect(
      trimIntradayPoints(points, 'mtd', '2026-08-01').map((p) => p.timestamp),
    ).toContain('2026-08-01T13:30:00.000Z');
  });

  it('leaves the other ranges alone -- their series is already the window', () => {
    for (const range of ['1d', '1w']) {
      expect(trimIntradayPoints(points, range, '2026-08-01')).toBe(points);
    }
  });

  it('does not trim without a window start', () => {
    expect(trimIntradayPoints(points, 'mtd', '')).toBe(points);
  });
});

/**
 * A 1D chart opens at the day's open, which is what every quote source shows.
 * A 1M chart is a different claim: the month is measured from a close, so
 * opening partway through the session a month ago mixes a mid-session price
 * into a series of closes and reports a change covering part of a session
 * nobody asked about.
 */
describe('trimIntradayToFirstDayClose (via trimIntradayPoints)', () => {
  const session = (day: string, times: string[], from = 0) =>
    times.map((t, i) => ({
      timestamp: `${day}T${t}:00.000Z`,
      value: from + i,
    }));

  it('drops every bar of the first day except its last', () => {
    const points = [
      ...session('2026-07-13', ['13:30', '15:00', '19:59'], 10),
      ...session('2026-07-14', ['13:30', '19:59'], 20),
    ];

    expect(trimIntradayPoints(points, '1m', '')).toEqual([
      points[2],
      points[3],
      points[4],
    ]);
  });

  it('leaves later days untouched, however many bars they have', () => {
    const points = [
      ...session('2026-07-13', ['13:30', '19:59'], 10),
      ...session('2026-07-14', ['13:30', '15:00', '19:59'], 20),
    ];

    expect(trimIntradayPoints(points, '1m', '').length).toBe(4);
  });

  /**
   * Collapsing a single-day series would leave one point and no chart, so the
   * series is kept whole. It cannot be wrong in the way this guards against:
   * with one day there is no earlier close to measure from either way.
   */
  it('leaves a one-day series alone', () => {
    const points = session('2026-07-13', ['13:30', '15:00', '19:59']);
    expect(trimIntradayPoints(points, '1m', '')).toBe(points);
  });

  it('is a no-op when the first day already has one bar', () => {
    const points = [
      ...session('2026-07-13', ['19:59']),
      ...session('2026-07-14', ['13:30', '19:59'], 20),
    ];
    expect(trimIntradayPoints(points, '1m', '')).toBe(points);
  });

  it('handles an empty series', () => {
    expect(trimIntradayPoints([], '1m', '')).toEqual([]);
  });

  /**
   * 1W and MTD are measured from the prior close already
   * (`PRIOR_CLOSE_BASELINE_RANGES`), so their first bar is not the baseline and
   * collapsing it would only throw away detail.
   */
  it('does not touch 1D, 1W or MTD', () => {
    const points = [
      ...session('2026-07-13', ['13:30', '15:00', '19:59'], 10),
      ...session('2026-07-14', ['13:30', '19:59'], 20),
    ];
    for (const range of ['1d', '1w']) {
      expect(trimIntradayPoints(points, range, '')).toBe(points);
    }
    // MTD still gets its own window trim, and nothing else.
    expect(trimIntradayPoints(points, 'mtd', '2026-07-13').length).toBe(5);
  });
});

describe('buildIntradayCacheKey', () => {
  it('builds key with defined account ids (sorted)', () => {
    const key = buildIntradayCacheKey('1d', ['z', 'a', 'm'], 'USD');
    expect(key).toBe(`${INTRADAY_CACHE_PREFIX}1d|a,m,z|USD`);
  });

  it('builds key with undefined account ids (null coalescing)', () => {
    const key = buildIntradayCacheKey('1w', undefined, 'EUR');
    expect(key).toBe(`${INTRADAY_CACHE_PREFIX}1w||EUR`);
  });

  it('builds key with empty account ids array', () => {
    const key = buildIntradayCacheKey('1m', [], 'GBP');
    expect(key).toBe(`${INTRADAY_CACHE_PREFIX}1m||GBP`);
  });
});

describe('readIntradayCache', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns null when key does not exist', () => {
    expect(readIntradayCache('missing-key')).toBeNull();
  });

  it('returns parsed payload when key exists', () => {
    const payload = {
      fetchedAt: 1000,
      points: [{ timestamp: '2024-01-01T10:00:00Z', value: 100 }],
      interval: '1m' as const,
      currency: 'USD',
      fallbackToDaily: false,
      skippedSymbols: [],
    };
    sessionStorage.setItem('test-key', JSON.stringify(payload));
    expect(readIntradayCache('test-key')).toEqual(payload);
  });

  it('returns null when stored value is invalid JSON', () => {
    sessionStorage.setItem('bad-key', '{not valid json}');
    expect(readIntradayCache('bad-key')).toBeNull();
  });
});

describe('writeIntradayCache', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  const payload = {
    fetchedAt: 2000,
    points: [],
    interval: '5m' as const,
    currency: 'USD',
    fallbackToDaily: false,
    skippedSymbols: ['AAPL'],
    failedSymbols: [],
  };

  it('writes payload to sessionStorage', () => {
    writeIntradayCache('write-key', payload);
    const stored = sessionStorage.getItem('write-key');
    expect(JSON.parse(stored!)).toEqual(payload);
  });

  it('does not throw when sessionStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() => writeIntradayCache('key', payload)).not.toThrow();
  });
});

describe('clearAllIntradayCache', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes all keys with the intraday cache prefix', () => {
    sessionStorage.setItem(`${INTRADAY_CACHE_PREFIX}1d||USD`, 'a');
    sessionStorage.setItem(`${INTRADAY_CACHE_PREFIX}1w||EUR`, 'b');
    sessionStorage.setItem('unrelated-key', 'c');

    clearAllIntradayCache();

    expect(sessionStorage.getItem(`${INTRADAY_CACHE_PREFIX}1d||USD`)).toBeNull();
    expect(sessionStorage.getItem(`${INTRADAY_CACHE_PREFIX}1w||EUR`)).toBeNull();
    expect(sessionStorage.getItem('unrelated-key')).toBe('c');
  });

  it('handles empty sessionStorage without error', () => {
    expect(() => clearAllIntradayCache()).not.toThrow();
  });

  it('skips null keys returned by sessionStorage.key()', () => {
    sessionStorage.setItem(`${INTRADAY_CACHE_PREFIX}1d||USD`, 'val');
    vi.spyOn(Storage.prototype, 'key').mockImplementation((i: number) => {
      return i === 0 ? null : null;
    });
    Object.defineProperty(Storage.prototype, 'length', { get: () => 1, configurable: true });
    expect(() => clearAllIntradayCache()).not.toThrow();
  });

  it('handles sessionStorage throwing during iteration', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementationOnce(() => {
      throw new Error('storage error');
    });
    Object.defineProperty(Storage.prototype, 'length', { get: () => 1, configurable: true });
    expect(() => clearAllIntradayCache()).not.toThrow();
  });
});

describe('niceAxisStep', () => {
  it('returns 1 for zero input', () => {
    expect(niceAxisStep(0)).toBe(1);
  });

  it('returns 1 for negative input', () => {
    expect(niceAxisStep(-5)).toBe(1);
  });

  it('returns nice step when f < 1.5 (nf=1)', () => {
    // raw=1.2: exp=0, magnitude=1, f=1.2 < 1.5 → nf=1, result=1
    expect(niceAxisStep(1.2)).toBe(1);
  });

  it('returns nice step when f >= 1.5 and f < 3 (nf=2)', () => {
    // raw=2: exp=0, magnitude=1, f=2, 1.5<=2<3 → nf=2, result=2
    expect(niceAxisStep(2)).toBe(2);
  });

  it('returns nice step when f >= 3 and f < 7 (nf=5)', () => {
    // raw=5: exp=0, magnitude=1, f=5, 3<=5<7 → nf=5, result=5
    expect(niceAxisStep(5)).toBe(5);
  });

  it('returns nice step when f >= 7 (nf=10)', () => {
    // raw=9: exp=0, magnitude=1, f=9 >= 7 → nf=10, result=10
    expect(niceAxisStep(9)).toBe(10);
  });

  it('handles larger values correctly', () => {
    // raw=250: exp=2, magnitude=100, f=2.5, 1.5<=2.5<3 → nf=2, result=200
    expect(niceAxisStep(250)).toBe(200);
  });
});

describe('computeTightYAxisDomain', () => {
  it('returns [0, auto] for empty array', () => {
    expect(computeTightYAxisDomain([])).toEqual([0, 'auto']);
  });

  it('handles flat-line (range === 0)', () => {
    const [min, max] = computeTightYAxisDomain([100, 100, 100]) as [number, number];
    expect(min).toBeLessThan(100);
    expect(max).toBeGreaterThan(100);
  });

  it('handles flat-line at zero (uses Math.max(0, 1) = 1 pad)', () => {
    const [min, max] = computeTightYAxisDomain([0, 0]) as [number, number];
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(0);
  });

  it('handles values that cross zero', () => {
    const [min, max] = computeTightYAxisDomain([-10, 5]) as [number, number];
    expect(min).toBeLessThanOrEqual(-10);
    expect(max).toBeGreaterThanOrEqual(5);
  });

  it('handles all-positive values (minValue >= 0, clamps to 0)', () => {
    const [min, max] = computeTightYAxisDomain([10, 20, 30]) as [number, number];
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeGreaterThan(30);
  });

  it('handles all-negative values (minValue < 0, clamps max to 0)', () => {
    const [min, max] = computeTightYAxisDomain([-30, -20, -10]) as [number, number];
    expect(min).toBeLessThan(-30);
    expect(max).toBeLessThanOrEqual(0);
  });

  it('handles single positive value', () => {
    const [min, max] = computeTightYAxisDomain([500]) as [number, number];
    // range=0, so flat-line path
    expect(min).toBeLessThan(500);
    expect(max).toBeGreaterThan(500);
  });
});

describe('renderChartFlagDot', () => {
  const baseOpts = { cx: 100, cy: 200, index: 3, color: '#10b981', label: '$1,234' };

  it('returns a ReactElement for side=above', () => {
    const el = renderChartFlagDot({ ...baseOpts, side: 'above' });
    expect(el).toBeTruthy();
    expect(typeof el).toBe('object');
  });

  it('returns a ReactElement for side=below', () => {
    const el = renderChartFlagDot({ ...baseOpts, side: 'below' });
    expect(el).toBeTruthy();
    expect(typeof el).toBe('object');
  });

  it('returns a ReactElement for side=right', () => {
    const el = renderChartFlagDot({ ...baseOpts, side: 'right' });
    expect(el).toBeTruthy();
    expect(typeof el).toBe('object');
  });

  it('returns a ReactElement for side=left', () => {
    const el = renderChartFlagDot({ ...baseOpts, side: 'left' });
    expect(el).toBeTruthy();
    expect(typeof el).toBe('object');
  });

  it('uses default gap=24 when gap is not specified', () => {
    const el = renderChartFlagDot({ ...baseOpts, side: 'above' });
    expect(el).toBeTruthy();
  });

  it('accepts custom gap value', () => {
    const el = renderChartFlagDot({ ...baseOpts, side: 'above', gap: 12 });
    expect(el).toBeTruthy();
  });

  it('adds a dismiss control wired to onDismiss when provided', () => {
    const onDismiss = vi.fn();
    const el = renderChartFlagDot({ ...baseOpts, side: 'right', onDismiss, dismissLabel: 'Hide' });
    const children = (el.props as any).children as any[];
    const closeButton = children.find((c: any) => c && c.props && c.props.role === 'button');
    expect(closeButton).toBeTruthy();
    expect(closeButton.props['aria-label']).toBe('Hide');
    closeButton.props.onClick({ stopPropagation: () => {} });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('omits the dismiss control when onDismiss is absent', () => {
    const el = renderChartFlagDot({ ...baseOpts, side: 'right' });
    const children = (el.props as any).children as any[];
    const closeButton = children.find((c: any) => c && c.props && c.props.role === 'button');
    expect(closeButton).toBeFalsy();
  });
});

describe('ChartFlagShadowFilter', () => {
  it('returns a ReactElement', () => {
    const el = ChartFlagShadowFilter();
    expect(el).toBeTruthy();
    expect(typeof el).toBe('object');
  });
});

describe('computeMinMaxFlagIndices', () => {
  it('returns no flags for an empty series', () => {
    expect(computeMinMaxFlagIndices([])).toEqual({ maxIndex: -1, minIndex: -1, show: false });
  });

  it('suppresses the flags for a flat series', () => {
    expect(computeMinMaxFlagIndices([5, 5, 5])).toEqual({ maxIndex: 0, minIndex: 0, show: false });
  });

  it('finds the max and min indices', () => {
    expect(computeMinMaxFlagIndices([3, 9, 1, 7])).toEqual({ maxIndex: 1, minIndex: 2, show: true });
  });

  it('resolves ties to the first occurrence', () => {
    expect(computeMinMaxFlagIndices([4, 9, 9, 1, 1])).toEqual({ maxIndex: 1, minIndex: 3, show: true });
  });

  it('handles all-negative values', () => {
    expect(computeMinMaxFlagIndices([-2, -8, -1])).toEqual({ maxIndex: 2, minIndex: 1, show: true });
  });

  it('anchors the extremes to real points when the first point is a gap', () => {
    // A leading NaN (a missing-rate day in a multi-currency series) used to pin
    // both flags to index 0 with show=true, drawing callouts on a point with no
    // value. The extremes must come from the finite points instead.
    expect(computeMinMaxFlagIndices([Number.NaN, 3, 9, 1])).toEqual({
      maxIndex: 2,
      minIndex: 3,
      show: true,
    });
  });

  it('ignores gaps between finite points', () => {
    expect(computeMinMaxFlagIndices([5, Number.NaN, 2, Number.NaN, 8])).toEqual({
      maxIndex: 4,
      minIndex: 2,
      show: true,
    });
  });

  it('returns no flags when every point is a gap', () => {
    expect(computeMinMaxFlagIndices([Number.NaN, Number.NaN])).toEqual({
      maxIndex: -1,
      minIndex: -1,
      show: false,
    });
  });
});

describe('renderMinMaxFlagDots', () => {
  const flags = { maxIndex: 1, minIndex: 4, show: true };
  const base = {
    flags,
    pointCount: 6,
    highColor: '#10b981',
    lowColor: '#ef4444',
    highLabel: '$9',
    lowLabel: '$1',
  };

  it('renders an invisible dot for a non-extreme point', () => {
    const el = renderMinMaxFlagDots({ ...base, cx: 10, cy: 20, index: 2 });
    expect(el.type).toBe('circle');
  });

  it('renders a bubble group for the max point', () => {
    const el = renderMinMaxFlagDots({ ...base, cx: 10, cy: 20, index: 1 });
    expect(el.type).toBe('g');
  });

  it('renders a bubble group for the min point', () => {
    const el = renderMinMaxFlagDots({ ...base, cx: 10, cy: 20, index: 4 });
    expect(el.type).toBe('g');
  });

  it('renders an invisible dot when coordinates are missing', () => {
    const el = renderMinMaxFlagDots({ ...base, index: 1 });
    expect(el.type).toBe('circle');
  });

  it('renders an invisible dot when the flags are suppressed', () => {
    const el = renderMinMaxFlagDots({
      ...base,
      flags: { maxIndex: 0, minIndex: 0, show: false },
      cx: 10,
      cy: 20,
      index: 0,
    });
    expect(el.type).toBe('circle');
  });

  it('hides the high bubble when highDismissed is set', () => {
    const el = renderMinMaxFlagDots({ ...base, cx: 10, cy: 20, index: 1, highDismissed: true });
    expect(el.type).toBe('circle');
  });

  it('hides the low bubble when lowDismissed is set', () => {
    const el = renderMinMaxFlagDots({ ...base, cx: 10, cy: 20, index: 4, lowDismissed: true });
    expect(el.type).toBe('circle');
  });

  it('wires the high bubble dismiss control to onDismissHigh', () => {
    const onDismissHigh = vi.fn();
    const el = renderMinMaxFlagDots({
      ...base,
      cx: 10,
      cy: 20,
      index: 1,
      onDismissHigh,
      dismissLabel: 'Hide',
    });
    const children = (el.props as any).children as any[];
    const closeButton = children.find((c: any) => c && c.props && c.props.role === 'button');
    expect(closeButton).toBeTruthy();
    closeButton.props.onClick({ stopPropagation: () => {} });
    expect(onDismissHigh).toHaveBeenCalledTimes(1);
  });
});
