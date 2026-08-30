import { describe, it, expect } from 'vitest';
import { financialTodayYmd } from './financial-today';
import { getLocalDateString } from './utils';

/**
 * The calendar day is pinned to an INSTANT and read in a named zone, so every
 * case here discriminates on the machine that runs it. A boundary test written
 * against the runner's own `TZ` only fails when CI happens to be set to the
 * wrong side of it -- which is how the UTC reading survived a green suite.
 */
describe('financialTodayYmd', () => {
  it('reads the day in a positive offset that UTC has not reached yet', () => {
    // 00:30 on the 30th in Warsaw (UTC+2); UTC still says the 29th.
    const instant = new Date('2026-08-29T22:30:00Z');
    expect(financialTodayYmd('Europe/Warsaw', instant)).toBe('2026-08-30');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-08-29');
  });

  it('reads the day in a negative offset that UTC has already left', () => {
    // 22:30 on the 29th in New York (UTC-4); UTC has rolled to the 30th.
    const instant = new Date('2026-08-30T02:30:00Z');
    expect(financialTodayYmd('America/New_York', instant)).toBe('2026-08-29');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-08-30');
  });

  it('spans a full day at the extreme offsets', () => {
    // UTC+14 and UTC-11 are 25 hours apart, so one instant is three calendar
    // days wide across the users of one deployment.
    const instant = new Date('2026-08-29T12:00:00Z');
    expect(financialTodayYmd('Pacific/Kiritimati', instant)).toBe('2026-08-30');
    expect(financialTodayYmd('Pacific/Niue', instant)).toBe('2026-08-29');
  });

  it('falls back to the browser zone for the "browser" sentinel and for none', () => {
    // The same fallback the backend takes: `RequestContextInterceptor` reads
    // the stored preference first and the browser's `X-Client-Timezone` after
    // it, and the sentinel is what the preference holds until a user picks one.
    const instant = new Date('2026-08-29T22:30:00Z');
    const browserDay = getLocalDateString(instant);
    expect(financialTodayYmd('browser', instant)).toBe(browserDay);
    expect(financialTodayYmd(undefined, instant)).toBe(browserDay);
  });

  it('defaults the instant to now', () => {
    expect(financialTodayYmd('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
