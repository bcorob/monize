import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@/test/render';
import { useChartMonthFormat } from './useChartMonthFormat';
import { usePreferencesStore } from '@/store/preferencesStore';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) =>
    selector({ preferences: { language: 'en' } }),
  ),
}));

const withLanguage = (language: string | undefined) =>
  vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
    selector({ preferences: { language } }),
  );

describe('useChartMonthFormat', () => {
  beforeEach(() => {
    withLanguage('en');
  });

  it('renders a month key as a localized month name, not a numeric tick', () => {
    const { result } = renderHook(() => useChartMonthFormat());
    // The whole point of the hook: `01/2026` is what the table formatter gives
    // an axis, and it is a number where a month belongs.
    expect(result.current('2026-01')).toBe('Jan 2026');
  });

  it('honours the UI language, so the month name is not always English', () => {
    withLanguage('de');
    const { result } = renderHook(() => useChartMonthFormat());
    // de-DE shortens January to "Jan." -- the assertion is that it differs
    // from the English rendering, not the exact CLDR spelling.
    expect(result.current('2026-01')).not.toBe('Jan 2026');
    expect(result.current('2026-01')).toMatch(/2026/);
  });

  it('accepts a narrower pattern for a crowded axis', () => {
    const { result } = renderHook(() => useChartMonthFormat());
    expect(result.current('2026-01', 'MMM yy')).toBe('Jan 26');
  });

  it('reads the month as local, never shifting across a timezone boundary', () => {
    const { result } = renderHook(() => useChartMonthFormat());
    // A UTC-parsed '2026-01' renders as December in any negative offset.
    expect(result.current('2026-01')).toContain('Jan');
    expect(result.current('2026-12')).toContain('Dec');
  });

  it('treats the "browser" and pseudo-locale sentinels as no locale', () => {
    for (const language of ['browser', 'xx', undefined]) {
      withLanguage(language);
      const { result } = renderHook(() => useChartMonthFormat());
      // Whatever the runtime default is, it must be a real rendering rather
      // than an Intl error from a sentinel passed through as a locale tag.
      expect(result.current('2026-01')).toMatch(/2026/);
    }
  });

  describe('a key it cannot parse', () => {
    /**
     * `Intl.DateTimeFormat.format(Invalid Date)` throws a RangeError, and these
     * formatters run inside recharts tick and tooltip renders -- where a throw
     * blanks the whole report subtree. recharts types the tooltip `label` as
     * optional, so `String(label)` really can be the text below.
     */
    it.each([
      ['undefined'],
      [''],
      ['2026'],
      ['not-a-month'],
      ['2026-1'],
      ['2026-13'],
      ['2026-00'],
      ['2026-01-15'],
    ])('returns %j unchanged instead of throwing', (input) => {
      const { result } = renderHook(() => useChartMonthFormat());
      expect(() => result.current(input)).not.toThrow();
      expect(result.current(input)).toBe(input);
    });

    it('does not roll an out-of-range month into a plausible wrong one', () => {
      const { result } = renderHook(() => useChartMonthFormat());
      // `new Date(2026, 12, 1)` is January 2027, which would render as a real
      // month and hide the malformed key.
      expect(result.current('2026-13')).not.toContain('2027');
    });
  });
});
