import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useExchangeRates, buildRateMap, convertWithRateMap } from './useExchangeRates';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) =>
    selector({ preferences: { defaultCurrency: 'CAD' } })
  ),
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getLatestRates: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { exchangeRatesApi } from '@/lib/exchange-rates';

// The fixtures are dated 2025-01-15; pin today so the age bound (45 days,
// INV-FX-001) is the thing under test and not the wall clock.
const TODAY = '2025-01-20';

function daysAgo(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('useExchangeRates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads rates on mount', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rates).toHaveLength(1);
  });

  it('convert returns unconverted amount for same currency', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(100, 'CAD', 'CAD')).toBe(100);
  });

  it('convert uses direct rate', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(100, 'USD', 'CAD')).toBeCloseTo(136, 1);
  });

  it('convert uses inverse rate', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(136, 'CAD', 'USD')).toBeCloseTo(100, 0);
  });

  it('getRate returns 1 for same currency', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.getRate('CAD', 'CAD')).toBe(1);
  });

  it('getRate returns null when no rate found', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.getRate('USD', 'GBP')).toBeNull();
  });

  it('handles API error gracefully', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockRejectedValue(new Error('API error'));
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rates).toEqual([]);
  });

  it('convertToDefault uses default currency', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.5, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convertToDefault(100, 'USD')).toBeCloseTo(150, 1);
  });

  /**
   * The old contract returned the amount unconverted, and every caller then
   * formatted it under the target currency's symbol: 100.00 USD with no USD->EUR
   * rate rendered as "100.00 EUR" and was summed into Assets and Net Worth. The
   * error is silent and scales with each unconverted account.
   */
  it('convert returns null when no rate is available (after load)', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(100, 'USD', 'GBP')).toBeNull();
  });

  it('convertToDefault returns null when no rate is available', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convertToDefault(100, 'USD')).toBeNull();
  });

  // Same currency is 1:1 by definition. That is a known rate, not a fallback,
  // and it must stay distinguishable from the missing case.
  it('converts same-currency amounts without needing a rate', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(100, 'CAD', 'CAD')).toBe(100);
  });

  it('converts a real zero rather than reporting it unknown', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.5, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.convert(0, 'USD', 'CAD')).toBe(0);
  });

  it('getRate uses direct rate', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.getRate('USD', 'CAD')).toBe(1.36);
  });

  it('getRate uses inverse rate', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 2, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.getRate('CAD', 'USD')).toBe(0.5);
  });

  it('getRate uses default currency target when not provided', async () => {
    vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    const { result } = renderHook(() => useExchangeRates());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.getRate('USD')).toBe(1.36);
  });

  describe('rate age and orientation (INV-FX-001, INV-FX-003)', () => {
    const row = (id: number, from: string, to: string, rate: number, rateDate: string) => ({
      id, fromCurrency: from, toCurrency: to, rate, rateDate, source: 'test',
    });

    it('treats a rate older than the bound as unknown, but keeps it in rates', async () => {
      vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
        row(1, 'CHF', 'USD', 1.1, '2020-03-01'),
      ]);
      const { result } = renderHook(() => useExchangeRates());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.convert(100000, 'CHF', 'USD')).toBeNull();
      expect(result.current.getRate('CHF', 'USD')).toBeNull();
      expect(result.current.getRate('USD', 'CHF')).toBeNull();
      expect(result.current.rates).toHaveLength(1);
    });

    it('converts at a 10 day old rate', async () => {
      vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
        row(1, 'USD', 'CAD', 1.3, daysAgo(10)),
      ]);
      const { result } = renderHook(() => useExchangeRates());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.convert(100, 'USD', 'CAD')).toBeCloseTo(130, 2);
    });

    it('prefers a fresh inverse row over a stale direct row', async () => {
      vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
        row(1, 'USD', 'CAD', 1.3, daysAgo(60)),
        row(2, 'CAD', 'USD', 0.7142857143, TODAY),
      ]);
      const { result } = renderHook(() => useExchangeRates());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.convert(1000, 'USD', 'CAD')).toBeCloseTo(1400, 2);
      expect(result.current.getRate('USD', 'CAD')).toBeCloseTo(1.4, 6);
    });

    it('prefers a fresh inverse row over an older direct row inside the bound', async () => {
      vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
        row(1, 'USD', 'CAD', 1.3, daysAgo(40)),
        row(2, 'CAD', 'USD', 0.7142857143, daysAgo(2)),
      ]);
      const { result } = renderHook(() => useExchangeRates());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.convert(1000, 'USD', 'CAD')).toBeCloseTo(1400, 2);
    });

    it('prefers the newer direct row over an older inverse row', async () => {
      vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
        row(1, 'USD', 'CAD', 1.3, daysAgo(1)),
        row(2, 'CAD', 'USD', 0.7142857143, daysAgo(30)),
      ]);
      const { result } = renderHook(() => useExchangeRates());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.convert(1000, 'USD', 'CAD')).toBeCloseTo(1300, 2);
    });

    it('uses the direct row on a date tie', async () => {
      vi.mocked(exchangeRatesApi.getLatestRates).mockResolvedValue([
        row(1, 'USD', 'CAD', 1.3, daysAgo(3)),
        row(2, 'CAD', 'USD', 0.7142857143, daysAgo(3)),
      ]);
      const { result } = renderHook(() => useExchangeRates());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.convert(1000, 'USD', 'CAD')).toBeCloseTo(1300, 2);
    });
  });
});

describe('buildRateMap', () => {
  it('builds lookup map from rates', () => {
    const map = buildRateMap([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.36, rateDate: '2025-01-15', source: 'test' },
    ]);
    expect(map.get('USD->CAD')).toBe(1.36);
  });

  it('keeps only the newer orientation of a pair', () => {
    const map = buildRateMap([
      { id: 1, fromCurrency: 'USD', toCurrency: 'CAD', rate: 1.3, rateDate: '2024-01-01', source: 'test' },
      { id: 2, fromCurrency: 'CAD', toCurrency: 'USD', rate: 0.7142857143, rateDate: '2024-06-01', source: 'test' },
    ]);
    expect(map.has('USD->CAD')).toBe(false);
    expect(map.get('CAD->USD')).toBe(0.7142857143);
  });
});

describe('convertWithRateMap', () => {
  const rateMap = new Map([['USD->CAD', 1.36]]);

  it('returns same amount for same currency', () => {
    expect(convertWithRateMap(100, 'CAD', 'CAD', rateMap)).toBe(100);
  });

  it('uses direct rate', () => {
    expect(convertWithRateMap(100, 'USD', 'CAD', rateMap)).toBeCloseTo(136);
  });

  it('uses inverse rate', () => {
    expect(convertWithRateMap(136, 'CAD', 'USD', rateMap)).toBeCloseTo(100, 0);
  });

  it('returns null when no rate', () => {
    expect(convertWithRateMap(100, 'GBP', 'JPY', rateMap)).toBeNull();
  });

  it('still returns a same-currency amount unchanged', () => {
    expect(convertWithRateMap(100, 'JPY', 'JPY', rateMap)).toBe(100);
  });
});
