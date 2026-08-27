import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDateFormat } from './useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { formatDate as formatDateUtil } from '@/lib/utils';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) =>
    selector({ preferences: { dateFormat: 'YYYY-MM-DD' } })
  ),
}));

vi.mock('@/lib/utils', () => ({
  formatDate: vi.fn((date: Date | string, fmt: string) => `formatted:${fmt}`),
  formatMonth: vi.fn((month: string, fmt: string) => `month:${fmt}`),
  formatDateWithoutYear: vi.fn(
    (date: Date | string, pattern: string) => `noYear:${pattern}`,
  ),
}));

describe('useDateFormat with a "browser" UI language', () => {
  afterEach(() => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { dateFormat: 'YYYY-MM-DD' } }),
    );
  });

  it('does not pass the "browser" sentinel through as an Intl locale', () => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { dateFormat: 'browser', language: 'browser' } }),
    );
    const { result } = renderHook(() => useDateFormat());
    result.current.formatDate('2025-01-15');
    expect(vi.mocked(formatDateUtil)).toHaveBeenLastCalledWith(
      '2025-01-15',
      'browser',
      undefined,
    );
  });
});

describe('useDateFormat', () => {
  it('returns formatDate/formatMonth functions and dateFormat', () => {
    const { result } = renderHook(() => useDateFormat());
    expect(result.current.dateFormat).toBe('YYYY-MM-DD');
    expect(typeof result.current.formatDate).toBe('function');
    expect(typeof result.current.formatMonth).toBe('function');
  });

  it('formatDate delegates to utils formatDate', () => {
    const { result } = renderHook(() => useDateFormat());
    const formatted = result.current.formatDate('2025-01-15');
    expect(formatted).toBe('formatted:YYYY-MM-DD');
  });

  it('formatMonth delegates to utils formatMonth', () => {
    const { result } = renderHook(() => useDateFormat());
    const formatted = result.current.formatMonth('2025-01');
    expect(formatted).toBe('month:YYYY-MM-DD');
  });

  it('formatDateWithoutYear delegates with the resolved pattern, not the raw preference', () => {
    // The distinction matters at `browser`: a sentinel does not say whether
    // the day or the month comes first, which is the one thing dropping the
    // year has to preserve.
    const { result } = renderHook(() => useDateFormat());
    expect(result.current.formatDateWithoutYear('2025-01-15')).toBe('noYear:YYYY-MM-DD');
  });

  it('resolves the sentinel before shortening, so browser never reaches the formatter', () => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { dateFormat: 'browser', language: 'en-US' } }),
    );
    const { result } = renderHook(() => useDateFormat());
    expect(result.current.formatDateWithoutYear('2025-01-15')).not.toContain('browser');
  });
});
