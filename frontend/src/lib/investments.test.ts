import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { investmentsApi } from './investments';
import { scheduledTransactionsApi } from './scheduled-transactions';
import { invalidateCache } from './apiCache';
import { API_MAX_PAGE_LIMIT } from './api-page-limits';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('investmentsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache('investments:');
    // The scheduled read model is cached across modules; clear it so one test's
    // populated `scheduled:all` cannot serve the next.
    invalidateCache('scheduled:');
  });

  it('getPortfolioSummary fetches /portfolio/summary', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { totalValue: 1000 } });
    await investmentsApi.getPortfolioSummary();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/summary', { params: undefined });
  });

  it('getPortfolioSummary passes accountIds', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { totalValue: 1000 } });
    await investmentsApi.getPortfolioSummary(['a1', 'a2']);
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/summary', {
      params: { accountIds: 'a1,a2' },
    });
  });

  it('getAssetAllocation fetches /portfolio/allocation', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await investmentsApi.getAssetAllocation();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/allocation', { params: undefined });
  });

  it('getInvestmentAccounts fetches /portfolio/accounts', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getInvestmentAccounts();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/accounts');
  });

  it('getTopMovers fetches /portfolio/top-movers', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getTopMovers();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/top-movers');
  });

  it('getIntradayBreakdown fetches /portfolio/intraday-breakdown', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { series: [], points: [], fallbackToDaily: false },
    });
    await investmentsApi.getIntradayBreakdown({ range: '1d', accountIds: 'a1' });
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/intraday-breakdown', {
      params: { range: '1d', accountIds: 'a1' },
    });
  });

  it('getFavouriteSecurities fetches /securities/favourites', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getFavouriteSecurities();
    expect(apiClient.get).toHaveBeenCalledWith('/securities/favourites');
  });

  it('getFavouriteSecurities returns cached result on second call', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ securityId: '1' }] });
    await investmentsApi.getFavouriteSecurities();
    await investmentsApi.getFavouriteSecurities();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('setSecurityFavourite patches the security and invalidates the cache', async () => {
    // Prime the favourites cache.
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ securityId: '1' }] });
    await investmentsApi.getFavouriteSecurities();

    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 's-1', isFavourite: true } });
    await investmentsApi.setSecurityFavourite('s-1', true);
    expect(apiClient.patch).toHaveBeenCalledWith('/securities/s-1', { isFavourite: true });

    // Cache was invalidated, so the next read hits the API again.
    vi.mocked(apiClient.get).mockClear();
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getFavouriteSecurities();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('getHoldings fetches /holdings with optional accountId', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getHoldings('a1');
    expect(apiClient.get).toHaveBeenCalledWith('/holdings', { params: { accountId: 'a1' } });
  });

  it('getHoldings without accountId passes undefined params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getHoldings();
    expect(apiClient.get).toHaveBeenCalledWith('/holdings', { params: undefined });
  });

  it('getTransactions fetches /investment-transactions', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [], total: 0 } });
    await investmentsApi.getTransactions({ page: 1, limit: 20 });
    expect(apiClient.get).toHaveBeenCalledWith('/investment-transactions', {
      params: { page: 1, limit: 20 },
    });
  });

  describe('getAllTransactionPages', () => {
    /** A page of `count` rows, reporting whether another follows it. */
    function page(count: number, hasMore: boolean, idPrefix = 'it') {
      return {
        data: Array.from({ length: count }, (_, i) => ({ id: `${idPrefix}-${i}` })),
        pagination: { page: 1, limit: API_MAX_PAGE_LIMIT, total: 0, totalPages: 0, hasMore },
      };
    }

    it('never asks for more rows than the endpoint accepts', async () => {
      // The whole point of the helper. `GET /investment-transactions` answers
      // 400 above this, and the caller's .catch() turns that into a zero.
      vi.mocked(apiClient.get).mockResolvedValue({ data: page(1, false) });
      await investmentsApi.getAllTransactionPages({ accountIds: 'a-1' });

      const limits = vi
        .mocked(apiClient.get)
        .mock.calls.map(([, config]) => (config as { params: { limit: number } }).params.limit);
      expect(limits.every((limit) => limit <= API_MAX_PAGE_LIMIT)).toBe(true);
    });

    it('walks past the first page and returns every row', async () => {
      vi.mocked(apiClient.get)
        .mockResolvedValueOnce({ data: page(2, true, 'p1') })
        .mockResolvedValueOnce({ data: page(1, false, 'p2') });

      const rows = await investmentsApi.getAllTransactionPages({ action: 'DIVIDEND' });

      expect(rows.map((r) => r.id)).toEqual(['p1-0', 'p1-1', 'p2-0']);
      expect(apiClient.get).toHaveBeenCalledTimes(2);
      expect(vi.mocked(apiClient.get).mock.calls[1][1]).toMatchObject({
        params: { page: 2, action: 'DIVIDEND' },
      });
    });

    it('stops on an empty page even when the server still claims more', async () => {
      // Without this the walk spins to MAX_PAGES against a backend whose
      // hasMore is wrong, which is a hang rather than a wrong number.
      vi.mocked(apiClient.get)
        .mockResolvedValueOnce({ data: page(1, true, 'p1') })
        .mockResolvedValue({ data: page(0, true) });

      const rows = await investmentsApi.getAllTransactionPages();

      expect(rows.map((r) => r.id)).toEqual(['p1-0']);
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });

    it('passes the filter through and does not swallow a failure', async () => {
      // A rejection has to reach the caller: a caller that cannot tell a failed
      // lookup from an empty result reports an outage as a confident zero.
      vi.mocked(apiClient.get).mockRejectedValue(new Error('boom'));
      await expect(investmentsApi.getAllTransactionPages()).rejects.toThrow('boom');
    });
  });

  it('createTransaction posts to /investment-transactions', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'it-1' } });
    await investmentsApi.createTransaction({ action: 'BUY' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/investment-transactions', { action: 'BUY' });
  });

  it('updateTransaction patches /investment-transactions/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'it-1' } });
    await investmentsApi.updateTransaction('it-1', { quantity: 10 } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/investment-transactions/it-1', { quantity: 10 });
  });

  it('getTransaction fetches /investment-transactions/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'it-1' } });
    await investmentsApi.getTransaction('it-1');
    expect(apiClient.get).toHaveBeenCalledWith('/investment-transactions/it-1');
  });

  it('deleteTransaction deletes /investment-transactions/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await investmentsApi.deleteTransaction('it-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/investment-transactions/it-1');
  });

  it('getSecurities fetches /securities', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getSecurities();
    expect(apiClient.get).toHaveBeenCalledWith('/securities', { params: undefined });
  });

  it('getSecurities passes includeInactive', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getSecurities(true);
    expect(apiClient.get).toHaveBeenCalledWith('/securities', { params: { includeInactive: true } });
  });

  it('getSecurity fetches /securities/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.getSecurity('s-1');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/s-1');
  });

  it('createSecurity posts to /securities', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.createSecurity({ symbol: 'AAPL' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/securities', { symbol: 'AAPL' });
  });

  it('updateSecurity patches /securities/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.updateSecurity('s-1', { name: 'Apple' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/securities/s-1', { name: 'Apple' });
  });

  // Issue #1167 review: the scheduled read model caches server-derived
  // current-settlement-pair FX fields. A security currency edit (same id) makes
  // that cached payload stale, so getAll() must hit the backend again rather
  // than serving the pre-edit forecast rate from the 120s cache. This asserts
  // the actual stale-read behaviour (a second GET), not merely that
  // invalidateCache() was called.
  it('invalidates the scheduled forecast read model when a security is updated', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [
        {
          id: 'st-1',
          investmentForecastExchangeRate: 1.5,
          investmentSecurity: { id: 's-1', currencyCode: 'EUR' },
        },
      ],
    });
    const first = await scheduledTransactionsApi.getAll();
    expect(first[0].investmentForecastExchangeRate).toBe(1.5);
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    // A cached read within the TTL does not hit the backend again.
    await scheduledTransactionsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    vi.mocked(apiClient.patch).mockResolvedValue({
      data: { id: 's-1', currencyCode: 'USD' },
    });
    await investmentsApi.updateSecurity('s-1', { currencyCode: 'USD' } as any);

    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [
        {
          id: 'st-1',
          investmentForecastExchangeRate: 1.35,
          investmentSecurity: { id: 's-1', currencyCode: 'USD' },
        },
      ],
    });
    const refreshed = await scheduledTransactionsApi.getAll();

    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(apiClient.get).toHaveBeenLastCalledWith('/scheduled-transactions');
    expect(refreshed[0].investmentForecastExchangeRate).toBe(1.35);
  });

  it('deactivateSecurity posts to /securities/:id/deactivate', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.deactivateSecurity('s-1');
    expect(apiClient.post).toHaveBeenCalledWith('/securities/s-1/deactivate');
  });

  it('activateSecurity posts to /securities/:id/activate', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 's-1' } });
    await investmentsApi.activateSecurity('s-1');
    expect(apiClient.post).toHaveBeenCalledWith('/securities/s-1/activate');
  });

  it('searchSecurities fetches /securities/search', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.searchSecurities('AAPL');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/search', { params: { q: 'AAPL' } });
  });

  it('lookupSecurity fetches /securities/lookup', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { symbol: 'AAPL', name: 'Apple' } });
    const result = await investmentsApi.lookupSecurity('AAPL');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/lookup', { params: { q: 'AAPL' } });
    expect(result!.symbol).toBe('AAPL');
  });

  it('refreshPrices posts to /securities/prices/refresh', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 5 } });
    const result = await investmentsApi.refreshPrices();
    // Per-request 120s timeout overrides the global 10s default; the
    // refresh-all endpoint hits Yahoo for every active security and
    // routinely takes longer than 10s on portfolios with many holdings.
    expect(apiClient.post).toHaveBeenCalledWith(
      '/securities/prices/refresh',
      undefined,
      { timeout: 120_000 },
    );
    expect(result.updated).toBe(5);
  });

  it('refreshSelectedPrices posts with securityIds', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { updated: 2 } });
    await investmentsApi.refreshSelectedPrices(['s-1', 's-2']);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/securities/prices/refresh/selected',
      { securityIds: ['s-1', 's-2'] },
      { timeout: 120_000 },
    );
  });

  it('backfillSecurityPrices posts to the per-security backfill endpoint', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { symbol: 'AAPL', success: true, pricesLoaded: 100 },
    });
    const result = await investmentsApi.backfillSecurityPrices('s-1');
    // Generous timeout: fetches the security's full provider history.
    expect(apiClient.post).toHaveBeenCalledWith(
      '/securities/s-1/prices/backfill',
      undefined,
      { timeout: 120_000, params: undefined },
    );
    expect(result.pricesLoaded).toBe(100);
  });

  // A range asks for a fixed window and drops the holding-period clip, so it
  // has to reach the server as a query param rather than being dropped here.
  it('backfillSecurityPrices forwards an explicit range', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { symbol: 'AAPL', success: true, pricesLoaded: 2500 },
    });
    await investmentsApi.backfillSecurityPrices('s-1', 'max');
    expect(apiClient.post).toHaveBeenCalledWith(
      '/securities/s-1/prices/backfill',
      undefined,
      { timeout: 120_000, params: { range: 'max' } },
    );
  });

  it('getPriceStatus fetches /securities/prices/status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { lastUpdated: '2025-01-01' } });
    const result = await investmentsApi.getPriceStatus();
    expect(result.lastUpdated).toBe('2025-01-01');
  });

  it('getSectorWeightings fetches /portfolio/sector-weightings', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [], totalPortfolioValue: 0 } });
    await investmentsApi.getSectorWeightings();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/sector-weightings', {
      params: undefined,
    });
  });

  it('getSectorWeightings passes accountIds and securityIds as CSV', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [] } });
    await investmentsApi.getSectorWeightings(['a1', 'a2'], ['s1']);
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/sector-weightings', {
      params: { accountIds: 'a1,a2', securityIds: 's1' },
    });
  });

  it('getAssetClassWeightings fetches /portfolio/asset-class-weightings', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { items: [], totalPortfolioValue: 0 },
    });
    await investmentsApi.getAssetClassWeightings();
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/asset-class-weightings', {
      params: undefined,
    });
  });

  it('getAssetClassWeightings passes accountIds and securityIds as CSV', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [] } });
    await investmentsApi.getAssetClassWeightings(['a1', 'a2'], ['s1']);
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/asset-class-weightings', {
      params: { accountIds: 'a1,a2', securityIds: 's1' },
    });
  });

  it('rebuildHoldings posts to /holdings/rebuild', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { holdingsCreated: 1, holdingsUpdated: 2, holdingsDeleted: 0 },
    });
    const result = await investmentsApi.rebuildHoldings();
    expect(apiClient.post).toHaveBeenCalledWith('/holdings/rebuild');
    expect(result.holdingsUpdated).toBe(2);
  });

  it('getHoldingAt passes params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { quantity: 10, averageCost: 50 } });
    await investmentsApi.getHoldingAt({
      accountId: 'a-1',
      securityId: 's-1',
      asOfDate: '2025-01-01',
    });
    expect(apiClient.get).toHaveBeenCalledWith('/holdings/at', {
      params: { accountId: 'a-1', securityId: 's-1', asOfDate: '2025-01-01' },
    });
  });

  it('getRealizedGains fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getRealizedGains({ accountIds: 'a-1' });
    expect(apiClient.get).toHaveBeenCalledWith('/investment-transactions/realized-gains', {
      params: { accountIds: 'a-1' },
    });
  });

  it('getCapitalGains fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getCapitalGains({ startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(apiClient.get).toHaveBeenCalledWith('/investment-transactions/capital-gains', {
      params: { startDate: '2025-01-01', endDate: '2025-12-31' },
    });
  });

  it('deleteSecurity deletes /securities/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await investmentsApi.deleteSecurity('s-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/securities/s-1');
  });

  it('getUsedSecurityIds fetches /securities/used', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: ['s-1', 's-2'] });
    const result = await investmentsApi.getUsedSecurityIds();
    expect(apiClient.get).toHaveBeenCalledWith('/securities/used');
    expect(result).toHaveLength(2);
  });

  it('lookupSecurity passes preferredExchanges and provider', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { symbol: 'AAPL' } });
    await investmentsApi.lookupSecurity('AAPL', ['NASDAQ', 'NYSE'], 'yahoo');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/lookup', {
      params: { q: 'AAPL', exchanges: 'NASDAQ,NYSE', provider: 'yahoo' },
    });
  });

  it('lookupSecurityCandidates returns empty array when data is falsy', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: null });
    const result = await investmentsApi.lookupSecurityCandidates('AAPL');
    expect(result).toEqual([]);
  });

  it('lookupSecurityCandidates passes options', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.lookupSecurityCandidates('AAPL', ['NASDAQ'], 'msn');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/lookup/candidates', {
      params: { q: 'AAPL', exchanges: 'NASDAQ', provider: 'msn' },
    });
  });

  it('getProviderStatus fetches provider status', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { yahoo: { ready: true }, msn: { ready: false } },
    });
    const result = await investmentsApi.getProviderStatus();
    expect(apiClient.get).toHaveBeenCalledWith('/securities/providers/status');
    expect(result.msn.ready).toBe(false);
  });

  it('getSecurityPrices sends no limit by default, so the server picks it', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getSecurityPrices('s-1');
    expect(apiClient.get).toHaveBeenCalledWith('/securities/s-1/prices', {
      params: {},
    });
  });

  it('getSecurityPrices sends a date window without a limit', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getSecurityPrices('s-1', {
      startDate: '2020-01-01',
      endDate: '2025-12-31',
    });
    // A limit alongside a window would truncate the window's oldest end, which
    // is the defect this signature exists to prevent.
    expect(apiClient.get).toHaveBeenCalledWith('/securities/s-1/prices', {
      params: { startDate: '2020-01-01', endDate: '2025-12-31' },
    });
  });

  it('getSecurityPrices keys its cache on the window, not just the security', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 1 }] });
    await investmentsApi.getSecurityPrices('s-1', { startDate: '2020-01-01' });
    await investmentsApi.getSecurityPrices('s-1', { startDate: '2024-01-01' });
    // Two windows are two answers; sharing an entry would serve one for the
    // other.
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('getMarketIndexes fetches the benchmark catalog', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getMarketIndexes();
    expect(apiClient.get).toHaveBeenCalledWith('/investments/performance/indexes');
  });

  it('getPerformanceComparison joins its selections and omits blanks', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { series: [] } });
    await investmentsApi.getPerformanceComparison({
      securityIds: ['a', 'b'],
      indexCodes: ['SP500'],
      startDate: '',
      endDate: '2025-12-31',
    });
    expect(apiClient.get).toHaveBeenCalledWith(
      '/investments/performance/comparison',
      {
        params: {
          securityIds: 'a,b',
          indexCodes: 'SP500',
          endDate: '2025-12-31',
        },
      },
    );
  });

  it('createSecurityPrice posts to /securities/:id/prices', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'p-1' } });
    await investmentsApi.createSecurityPrice('s-1', { price: 100 } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/securities/s-1/prices', { price: 100 });
  });

  it('updateSecurityPrice patches a price entry', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'p-1' } });
    await investmentsApi.updateSecurityPrice('s-1', 1, { price: 110 } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/securities/s-1/prices/1', { price: 110 });
  });

  it('deleteSecurityPrice deletes a price entry', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await investmentsApi.deleteSecurityPrice('s-1', 1);
    expect(apiClient.delete).toHaveBeenCalledWith('/securities/s-1/prices/1');
  });

  it('getPortfolioSummary returns cached result on second call', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { totalValue: 1000 } });
    await investmentsApi.getPortfolioSummary();
    await investmentsApi.getPortfolioSummary();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('getAssetAllocation returns cached result on second call', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await investmentsApi.getAssetAllocation();
    await investmentsApi.getAssetAllocation();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('getInvestmentAccounts returns cached result on second call', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getInvestmentAccounts();
    await investmentsApi.getInvestmentAccounts();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('getTopMovers returns cached result on second call', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await investmentsApi.getTopMovers();
    await investmentsApi.getTopMovers();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('getPortfolioSummary with empty accountIds passes undefined params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { totalValue: 0 } });
    await investmentsApi.getPortfolioSummary([]);
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/summary', { params: undefined });
  });

  it('getAssetAllocation with empty accountIds passes undefined params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await investmentsApi.getAssetAllocation([]);
    expect(apiClient.get).toHaveBeenCalledWith('/portfolio/allocation', { params: undefined });
  });

  it('transferSecurity posts both legs and invalidates the cache', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { transferOut: { id: 'out' }, transferIn: { id: 'in' } },
    });
    const data = {
      fromAccountId: 'a1',
      toAccountId: 'a2',
      securityId: 's1',
      transactionDate: '2025-01-01',
      quantity: 10,
      costPerShare: 5,
    };
    const result = await investmentsApi.transferSecurity(data);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/investment-transactions/transfer-security',
      data,
    );
    expect(result).toEqual({
      transferOut: { id: 'out' },
      transferIn: { id: 'in' },
    });
  });

  it('getSecurityTransactionHistory fetches the security history', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { transactions: [] } });
    const result = await investmentsApi.getSecurityTransactionHistory('s1');
    expect(apiClient.get).toHaveBeenCalledWith(
      '/investment-transactions/security/s1/history',
    );
    expect(result).toEqual({ transactions: [] });
  });
});
