import { describe, expect, it } from 'vitest';
import {
  applyPortfolioWindowStart,
  resolvePortfolioRangeWindow,
} from './portfolio-range-window';
import { resolveRangePreset } from '@/lib/date-range';

// Monday 28 September 2026, the day issue #1461 was reported on.
const NOW = new Date(2026, 8, 28);

const windowFor = (range: string, extra = {}) =>
  resolvePortfolioRangeWindow(range, { now: NOW, ...extra });

describe('resolvePortfolioRangeWindow', () => {
  /**
   * A chart opens its series on the close its figures are measured from, and
   * the figures are measured over the server's own preset window. This table
   * is the mirror of `presetEarliestDate` / `presetWindowStart` in
   * `backend/src/net-worth/portfolio-period-presets.util.ts`, pinned to the
   * same day in `portfolio-period-presets.util.spec.ts`: change one and the
   * other fails.
   */
  it('opens each preset where the server measures it from', () => {
    expect(windowFor('1w')).toEqual({
      start: '2026-09-20',
      periodStart: '2026-09-21',
      end: '2026-09-28',
    });
    expect(windowFor('1m').start).toBe('2026-08-29');
    expect(windowFor('3m').start).toBe('2026-06-30');
    expect(windowFor('ytd').start).toBe('2025-12-31');
    expect(windowFor('1y').start).toBe('2025-09-28');
    expect(windowFor('2y').start).toBe('2024-09-28');
    expect(windowFor('5y').start).toBe('2021-09-28');
  });

  it('measures a range from its own first day unless it reports against the prior close', () => {
    for (const range of ['1m', '3m', '6m', 'ytd', '1y', '2y', '5y']) {
      const window = windowFor(range);
      expect(window.start).toBe(window.periodStart);
    }
  });

  /**
   * MTD opens on the 1st and is measured from the close before the month:
   * the last day of the previous month, which is where its series is drawn
   * from, and the day the period result is sent as its baseline.
   */
  it('draws MTD from the last day of the previous month', () => {
    expect(windowFor('mtd')).toEqual({
      start: '2026-08-31',
      periodStart: '2026-09-01',
      end: '2026-09-28',
    });
  });

  it('steps a leap-day anniversary back to 28 February, as the server does', () => {
    const leap = new Date(2028, 1, 29);
    expect(resolvePortfolioRangeWindow('1y', { now: leap }).start).toBe(
      '2027-02-28',
    );
    expect(resolvePortfolioRangeWindow('5y', { now: leap }).start).toBe(
      '2023-02-28',
    );
  });

  it('opens 6M on the same day six months earlier', () => {
    expect(windowFor('6m').start).toBe('2026-03-28');
  });

  /**
   * A rule naming an exact day has no month-aligned reading, so alignment is
   * ignored where one applies. Under the shared resolver the report's 5Y
   * opened on the first of a month.
   */
  it('ignores month alignment where an exact day is named', () => {
    expect(windowFor('5y', { alignment: 'month' }).start).toBe('2021-09-28');
    expect(windowFor('1y', { alignment: 'month' }).start).toBe('2025-09-28');
    expect(windowFor('ytd', { alignment: 'month' }).start).toBe('2025-12-31');
  });

  it('leaves 1D to the shared resolver, a day early', () => {
    // The intraday session is the server's; the daily fallback is a week.
    const base = resolveRangePreset('1d', { now: NOW });
    expect(windowFor('1d')).toEqual({
      start: '2026-09-20',
      periodStart: base.start,
      end: base.end,
    });
  });

  it('passes an unknown range straight through', () => {
    const base = resolveRangePreset('7y', { now: NOW });
    expect(windowFor('7y')).toEqual({ ...base, periodStart: base.start });
  });

  it('keeps a custom range custom', () => {
    expect(
      resolvePortfolioRangeWindow('custom', {
        now: NOW,
        startDate: '2024-03-04',
        endDate: '2024-05-06',
      }),
    ).toEqual({
      start: '2024-03-04',
      periodStart: '2024-03-04',
      end: '2024-05-06',
    });
  });

  it('leaves All with no start to send', () => {
    expect(windowFor('all')).toEqual({
      start: '',
      periodStart: '',
      end: '2026-09-28',
    });
  });

  it('always ends today', () => {
    for (const range of ['1w', 'mtd', '1y', '3m', 'ytd', '5y']) {
      expect(windowFor(range).end).toBe('2026-09-28');
    }
  });

  describe('YTD', () => {
    /**
     * The year is measured from the close of the previous year's last trading
     * session. 31 December carries that close even when it fell on a weekend
     * or holiday, because a day is valued from the latest close on or before
     * it. Opening on the year's first trading day dropped that day's move.
     */
    it('opens on the previous 31 December on the first and last days of the year', () => {
      const on = (now: Date) =>
        resolvePortfolioRangeWindow('ytd', { now }).start;
      expect(on(new Date(2026, 0, 1))).toBe('2025-12-31');
      expect(on(new Date(2026, 11, 31))).toBe('2025-12-31');
    });
  });
});

describe('applyPortfolioWindowStart', () => {
  /**
   * The report and the Investments chart hand in the window `useDateRange`
   * already resolved, which is what carries a user's custom dates. The rule
   * must layer onto that rather than re-deriving it.
   */
  it('overrides the start of a window it is handed, keeping the end', () => {
    expect(
      applyPortfolioWindowStart(
        '1y',
        { start: '2025-09-01', end: '2026-09-28' },
        { now: NOW },
      ),
    ).toEqual({
      start: '2025-09-28',
      periodStart: '2025-09-28',
      end: '2026-09-28',
    });
  });

  it('opens an inherited prior-close range a day before the window it is handed', () => {
    expect(
      applyPortfolioWindowStart(
        'mtd',
        { start: '2026-09-01', end: '2026-09-28' },
        { now: NOW },
      ),
    ).toEqual({
      start: '2026-08-31',
      periodStart: '2026-09-01',
      end: '2026-09-28',
    });
  });
});
