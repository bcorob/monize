import apiClient from './api';
import { Account } from '@/types/account';
import { TransactionStatus } from '@/types/transaction';
/**
 * Mirrors `BACKFILL_RANGES` in the backend's `backfill-prices-query.dto.ts`.
 * The server validates against its own allowlist; this keeps a caller from
 * sending a range the DTO would reject.
 */
export type BackfillRange = '1y' | '2y' | '5y' | '10y' | 'ytd' | 'max';
import {
  PortfolioSummary,
  AssetAllocation,
  InvestmentTransaction,
  CreateInvestmentTransactionData,
  Holding,
  RealizedGainEntry,
  CapitalGainEntry,
  Security,
  CreateSecurityData,
  CreateSecurityPriceData,
  PaginatedInvestmentTransactions,
  TopMover,
  FavouriteSecurityQuote,
  SectorWeightingResult,
  CountryWeightingResult,
  AssetClassWeightingResult,
  SecurityPrice,
  MarketIndex,
  PerformanceComparison,
  SecurityDocument,
  CreateSecurityDocumentData,
  SecurityNewsResult,
  SecurityTransactionHistory,
  SecurityDetail,
} from '@/types/investment';
import { IntradayBreakdown } from '@/types/net-worth';
import { getCached, setCache, invalidateBalanceCaches, invalidateCache } from './apiCache';

export const investmentsApi = {
  // Get portfolio summary
  getPortfolioSummary: async (accountIds?: string[]): Promise<PortfolioSummary> => {
    const cacheKey = `investments:summary:${accountIds?.join(',') || 'all'}`;
    const cached = getCached<PortfolioSummary>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<PortfolioSummary>('/portfolio/summary', {
      params: accountIds && accountIds.length > 0 ? { accountIds: accountIds.join(',') } : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Get asset allocation
  getAssetAllocation: async (accountIds?: string[]): Promise<AssetAllocation> => {
    const cacheKey = `investments:allocation:${accountIds?.join(',') || 'all'}`;
    const cached = getCached<AssetAllocation>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<AssetAllocation>('/portfolio/allocation', {
      params: accountIds && accountIds.length > 0 ? { accountIds: accountIds.join(',') } : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Get portfolio "exposure by tag" allocation. Overlapping exposure: a
  // multi-tagged holding counts in full under each tag, so percentages can sum
  // to more than 100%.
  getAllocationByTag: async (accountIds?: string[]): Promise<AssetAllocation> => {
    const cacheKey = `investments:allocation-by-tag:${accountIds?.join(',') || 'all'}`;
    const cached = getCached<AssetAllocation>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<AssetAllocation>('/portfolio/allocation/by-tag', {
      params: accountIds && accountIds.length > 0 ? { accountIds: accountIds.join(',') } : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // List the KEY:VALUE tag keys present on the portfolio's securities (e.g.
  // "country", "sector"), so the UI can offer an aggregate-by-key chart.
  getPortfolioTagKeys: async (accountIds?: string[]): Promise<string[]> => {
    const cacheKey = `investments:tag-keys:${accountIds?.join(',') || 'all'}`;
    const cached = getCached<string[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<string[]>('/portfolio/tag-keys', {
      params:
        accountIds && accountIds.length > 0
          ? { accountIds: accountIds.join(',') }
          : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Get portfolio allocation aggregated by the value of one KEY:VALUE tag key
  // (e.g. key "country" -> a slice per country). Value-weighted; a mixed
  // holding tagged under several values counts in full under each.
  getAllocationByTagKey: async (
    key: string,
    accountIds?: string[],
  ): Promise<AssetAllocation> => {
    const cacheKey = `investments:allocation-by-tag-key:${key}:${accountIds?.join(',') || 'all'}`;
    const cached = getCached<AssetAllocation>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<AssetAllocation>(
      '/portfolio/allocation/by-tag-key',
      {
        params: {
          key,
          ...(accountIds && accountIds.length > 0
            ? { accountIds: accountIds.join(',') }
            : {}),
        },
      },
    );
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Suggest a description and website for a security from the Yahoo provider
  // profile (advisory pre-fill for the "Fetch from Yahoo" button). Not cached.
  // `website` is null for funds, where Yahoo publishes no URL, and there is no
  // investor-relations address to suggest: no provider carries one.
  getSuggestedDescription: async (
    symbol: string,
    exchange?: string,
  ): Promise<{
    symbol: string;
    description: string | null;
    website: string | null;
  }> => {
    const response = await apiClient.get<{
      symbol: string;
      description: string | null;
      website: string | null;
    }>('/securities/profile-description', {
      params: { symbol, ...(exchange ? { exchange } : {}) },
    });
    return response.data;
  },

  // Get all investment accounts
  getInvestmentAccounts: async (): Promise<Account[]> => {
    const cacheKey = 'investments:accounts';
    const cached = getCached<Account[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<Account[]>('/portfolio/accounts');
    setCache(cacheKey, response.data);
    return response.data;
  },

  // Intraday portfolio value series (1D / 1W / 1M ranges).
  // Bypasses apiCache; the chart caches in sessionStorage instead so a manual
  // Refresh can selectively invalidate just the intraday entries.
  getIntradayValue: async (params: {
    range: '1d' | '1w' | '1m';
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<{
    points: Array<{ timestamp: string; value: number }>;
    interval: '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m';
    currency: string;
    range: '1d' | '1w' | '1m';
    fetchedAt: string;
    skippedSymbols: string[];
    failedSymbols: string[];
    fallbackToDaily: boolean;
  }> => {
    const response = await apiClient.get('/portfolio/intraday-value', { params });
    return response.data;
  },

  // Per-security intraday breakdown (1D / 1W / 1M ranges) for the Portfolio
  // Value Over Time report's "by security" view. Carries the same availability
  // metadata as getIntradayValue so the caller can apply identical fallback
  // handling. Backend caches for 60s; not cached in sessionStorage here.
  getIntradayBreakdown: async (params: {
    range: '1d' | '1w' | '1m';
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<IntradayBreakdown> => {
    const response = await apiClient.get<IntradayBreakdown>(
      '/portfolio/intraday-breakdown',
      { params },
    );
    return response.data;
  },

  // Get top movers (daily price changes)
  getTopMovers: async (): Promise<TopMover[]> => {
    const cacheKey = 'investments:topMovers';
    const cached = getCached<TopMover[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<TopMover[]>('/portfolio/top-movers');
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Get all holdings
  getHoldings: async (accountId?: string): Promise<Holding[]> => {
    const response = await apiClient.get<Holding[]>('/holdings', {
      params: accountId ? { accountId } : undefined,
    });
    return response.data;
  },

  // Rebuild all holdings from transaction history. Useful for fixing data
  // after imports or split-ratio corrections leave holdings out of sync
  // with the transaction log.
  rebuildHoldings: async (): Promise<{
    holdingsCreated: number;
    holdingsUpdated: number;
    holdingsDeleted: number;
  }> => {
    const response = await apiClient.post<{
      holdingsCreated: number;
      holdingsUpdated: number;
      holdingsDeleted: number;
    }>('/holdings/rebuild');
    invalidateCache('investments:');
    return response.data;
  },

  // Holding state for (account, security) replayed as of a date. Used by
  // the SPLIT form to show the user what their position looked like just
  // before the split was applied, rather than the live holdings.
  getHoldingAt: async (params: {
    accountId: string;
    securityId: string;
    asOfDate: string;
    excludeTransactionId?: string;
  }): Promise<{ quantity: number; averageCost: number }> => {
    const response = await apiClient.get<{
      quantity: number;
      averageCost: number;
    }>('/holdings/at', { params });
    return response.data;
  },

  // Get investment transactions with pagination
  getTransactions: async (params?: {
    accountIds?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
    symbol?: string;
    action?: string;
  }): Promise<PaginatedInvestmentTransactions> => {
    const response = await apiClient.get<PaginatedInvestmentTransactions>(
      '/investment-transactions',
      { params },
    );
    return response.data;
  },

  // Get realized gains per SELL transaction (proper cost basis via replay)
  getRealizedGains: async (params?: {
    accountIds?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<RealizedGainEntry[]> => {
    const response = await apiClient.get<RealizedGainEntry[]>(
      '/investment-transactions/realized-gains',
      { params },
    );
    return response.data;
  },

  // Per-period capital gain breakdown (realized + unrealized) by security.
  getCapitalGains: async (params: {
    accountIds?: string;
    startDate: string;
    endDate: string;
    granularity?: 'month' | 'day';
  }): Promise<CapitalGainEntry[]> => {
    const response = await apiClient.get<CapitalGainEntry[]>(
      '/investment-transactions/capital-gains',
      { params },
    );
    return response.data;
  },

  // Create investment transaction
  createTransaction: async (
    data: CreateInvestmentTransactionData,
  ): Promise<InvestmentTransaction> => {
    const response = await apiClient.post<InvestmentTransaction>(
      '/investment-transactions',
      data,
    );
    invalidateBalanceCaches();
    return response.data;
  },

  // Transfer a security between two investment accounts, preserving cost
  // basis. Creates both legs (TRANSFER_OUT in source, TRANSFER_IN in
  // destination) atomically on the backend.
  transferSecurity: async (data: {
    fromAccountId: string;
    toAccountId: string;
    securityId: string;
    transactionDate: string;
    quantity: number;
    costPerShare: number;
    description?: string;
  }): Promise<{
    transferOut: InvestmentTransaction;
    transferIn: InvestmentTransaction;
  }> => {
    const response = await apiClient.post<{
      transferOut: InvestmentTransaction;
      transferIn: InvestmentTransaction;
    }>('/investment-transactions/transfer-security', data);
    invalidateBalanceCaches();
    return response.data;
  },

  // Update investment transaction
  updateTransaction: async (
    id: string,
    // destinationAccountId is only used when editing a security-transfer leg,
    // to reroute the paired leg's account.
    data: Partial<CreateInvestmentTransactionData> & {
      destinationAccountId?: string;
    },
  ): Promise<InvestmentTransaction> => {
    const response = await apiClient.patch<InvestmentTransaction>(
      `/investment-transactions/${id}`,
      data,
    );
    invalidateBalanceCaches();
    return response.data;
  },

  // Update only the status of an investment transaction (the register's
  // click-to-cycle path). Crossing the VOID boundary moves holdings and the
  // linked cash balance server-side, so the balance caches are invalidated
  // exactly as transactionsApi.updateStatus does.
  updateStatus: async (
    id: string,
    status: TransactionStatus,
  ): Promise<InvestmentTransaction> => {
    const response = await apiClient.patch<InvestmentTransaction>(
      `/investment-transactions/${id}/status`,
      { status },
    );
    invalidateBalanceCaches();
    return response.data;
  },

  // Get a single investment transaction by ID
  getTransaction: async (id: string): Promise<InvestmentTransaction> => {
    const response = await apiClient.get<InvestmentTransaction>(
      `/investment-transactions/${id}`,
    );
    return response.data;
  },

  // Full transaction history for a security with running share totals and the
  // accounts (including closed) it was used in.
  getSecurityTransactionHistory: async (
    securityId: string,
  ): Promise<SecurityTransactionHistory> => {
    const response = await apiClient.get<SecurityTransactionHistory>(
      `/investment-transactions/security/${securityId}/history`,
    );
    return response.data;
  },

  // Delete investment transaction
  deleteTransaction: async (id: string): Promise<void> => {
    await apiClient.delete(`/investment-transactions/${id}`);
    invalidateBalanceCaches();
  },

  // Get all securities
  getSecurities: async (includeInactive = false): Promise<Security[]> => {
    const response = await apiClient.get<Security[]>('/securities', {
      params: includeInactive ? { includeInactive: true } : undefined,
    });
    return response.data;
  },

  // Get favourite securities with latest price and daily change (for the dashboard widget)
  getFavouriteSecurities: async (): Promise<FavouriteSecurityQuote[]> => {
    const cacheKey = 'investments:favouriteSecurities';
    const cached = getCached<FavouriteSecurityQuote[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<FavouriteSecurityQuote[]>('/securities/favourites');
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Toggle a security's favourite flag. Invalidates the cached favourites list
  // so the dashboard widget reflects the change on next load.
  setSecurityFavourite: async (id: string, isFavourite: boolean): Promise<Security> => {
    const response = await apiClient.patch<Security>(`/securities/${id}`, { isFavourite });
    invalidateCache('investments:favouriteSecurities');
    return response.data;
  },

  // Get a single security by ID
  getSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.get<Security>(`/securities/${id}`);
    return response.data;
  },

  // The security plus its position, per-account breakdown and lifetime totals,
  // for the security detail page. Deliberately uncached: it is the page's
  // primary data, and a stale position after a trade would be misleading.
  getSecurityDetail: async (id: string): Promise<SecurityDetail> => {
    const response = await apiClient.get<SecurityDetail>(`/securities/${id}/detail`);
    return response.data;
  },

  // Country names for the manual ETF/fund allocation picker: canonical list
  // plus any custom countries the user has saved, base-currency country first.
  getCountryOptions: async (): Promise<string[]> => {
    const response = await apiClient.get<string[]>('/securities/country-options');
    return response.data;
  },

  // Asset-class names for the manual ETF/fund allocation picker: exactly the
  // free-text classes the user has already saved on a security.
  getAssetOptions: async (): Promise<string[]> => {
    const response = await apiClient.get<string[]>('/securities/asset-options');
    return response.data;
  },

  // Remove an asset class from the picker list. It is also dropped from every
  // security that used it; the freed weight becomes part of that security's
  // computed "Other" remainder rather than being re-apportioned.
  deleteAssetOption: async (
    name: string,
  ): Promise<{ name: string; removedFrom: number }> => {
    const response = await apiClient.delete<{ name: string; removedFrom: number }>(
      '/securities/asset-options',
      { params: { name } },
    );
    return response.data;
  },

  // Create security
  createSecurity: async (data: CreateSecurityData): Promise<Security> => {
    const response = await apiClient.post<Security>('/securities', data);
    return response.data;
  },

  // Update security
  updateSecurity: async (id: string, data: Partial<CreateSecurityData>): Promise<Security> => {
    const response = await apiClient.patch<Security>(`/securities/${id}`, data);
    return response.data;
  },

  // Deactivate security
  deactivateSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.post<Security>(`/securities/${id}/deactivate`);
    return response.data;
  },

  // Activate security
  activateSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.post<Security>(`/securities/${id}/activate`);
    return response.data;
  },

  // Delete security (only if no holdings or transactions reference it)
  deleteSecurity: async (id: string): Promise<void> => {
    await apiClient.delete(`/securities/${id}`);
  },

  // Get security IDs that have investment transactions
  getUsedSecurityIds: async (): Promise<string[]> => {
    const response = await apiClient.get<string[]>('/securities/used');
    return response.data;
  },

  // Search securities
  searchSecurities: async (query: string): Promise<Security[]> => {
    const response = await apiClient.get<Security[]>('/securities/search', {
      params: { q: query },
    });
    return response.data;
  },

  // Lookup security info from Yahoo Finance
  lookupSecurity: async (
    query: string,
    preferredExchanges?: string[],
    provider?: 'yahoo' | 'msn' | 'auto',
  ): Promise<{
    symbol: string;
    name: string;
    exchange: string | null;
    securityType: string | null;
    currencyCode: string | null;
    provider?: 'yahoo' | 'msn';
    msnInstrumentId?: string | null;
  } | null> => {
    const params: Record<string, string> = { q: query };
    if (preferredExchanges && preferredExchanges.length > 0) {
      params.exchanges = preferredExchanges.join(',');
    }
    if (provider) {
      params.provider = provider;
    }
    const response = await apiClient.get('/securities/lookup', {
      params,
    });
    return response.data;
  },

  lookupSecurityCandidates: async (
    query: string,
    preferredExchanges?: string[],
    provider?: 'yahoo' | 'msn' | 'auto',
  ): Promise<
    Array<{
      symbol: string;
      name: string;
      exchange: string | null;
      securityType: string | null;
      currencyCode: string | null;
      provider?: 'yahoo' | 'msn';
      msnInstrumentId?: string | null;
    }>
  > => {
    const params: Record<string, string> = { q: query };
    if (preferredExchanges && preferredExchanges.length > 0) {
      params.exchanges = preferredExchanges.join(',');
    }
    if (provider) {
      params.provider = provider;
    }
    const response = await apiClient.get('/securities/lookup/candidates', {
      params,
    });
    return response.data || [];
  },

  // Refresh all security prices from Yahoo Finance
  refreshPrices: async (): Promise<{
    totalSecurities: number;
    updated: number;
    failed: number;
    skipped: number;
    results: Array<{
      symbol: string;
      success: boolean;
      price?: number;
      error?: string;
    }>;
    lastUpdated: string;
  }> => {
    // The default 10s axios timeout is too short for this endpoint -- it
    // hits Yahoo Finance once per active security and can easily exceed
    // 10s for larger catalogs. Give it 2 minutes.
    const response = await apiClient.post('/securities/prices/refresh', undefined, {
      timeout: 120_000,
    });
    invalidateCache('investments:');
    return response.data;
  },

  // Refresh prices for specific securities only
  refreshSelectedPrices: async (securityIds: string[]): Promise<{
    totalSecurities: number;
    updated: number;
    failed: number;
    skipped: number;
    results: Array<{
      symbol: string;
      success: boolean;
      price?: number;
      error?: string;
    }>;
    lastUpdated: string;
  }> => {
    const response = await apiClient.post(
      '/securities/prices/refresh/selected',
      { securityIds },
      { timeout: 120_000 },
    );
    invalidateCache('investments:');
    return response.data;
  },

  // Force-refresh historical prices for a single security across the full
  // period the user has held it, overwriting existing rows.
  //
  // `range` asks for a fixed history window instead ('5y', 'max', ...), which
  // also drops the holding-period clip: without it the write stops at the first
  // transaction date, so a security bought recently can hold no history from
  // before the purchase — which is what a backtest or the GEM report needs.
  backfillSecurityPrices: async (
    securityId: string,
    range?: BackfillRange,
  ): Promise<{
    symbol: string;
    success: boolean;
    pricesLoaded?: number;
    error?: string;
    provider?: string;
  }> => {
    // Hits the quote provider for the security's full history, so give it the
    // same generous timeout as the bulk refresh endpoints.
    const response = await apiClient.post(
      `/securities/${securityId}/prices/backfill`,
      undefined,
      { timeout: 120_000, params: range ? { range } : undefined },
    );
    invalidateCache('investments:');
    return response.data;
  },

  // Get price update status
  getPriceStatus: async (): Promise<{ lastUpdated: string | null }> => {
    const response = await apiClient.get('/securities/prices/status');
    return response.data;
  },

  // Quote provider configuration status (e.g. whether MSN_API_KEY is set)
  getProviderStatus: async (): Promise<{
    yahoo: { ready: boolean };
    msn: { ready: boolean };
  }> => {
    const response = await apiClient.get<{
      yahoo: { ready: boolean };
      msn: { ready: boolean };
    }>('/securities/providers/status');
    return response.data;
  },

  // Get price history for a security
  getSecurityNews: async (securityId: string): Promise<SecurityNewsResult> => {
    const response = await apiClient.get<SecurityNewsResult>(
      `/securities/${securityId}/news`,
    );
    return response.data;
  },

  getSecurityDocuments: async (securityId: string): Promise<SecurityDocument[]> => {
    const response = await apiClient.get<SecurityDocument[]>(
      `/securities/${securityId}/documents`,
    );
    return response.data;
  },

  createSecurityDocument: async (
    securityId: string,
    data: CreateSecurityDocumentData,
  ): Promise<SecurityDocument> => {
    const response = await apiClient.post<SecurityDocument>(
      `/securities/${securityId}/documents`,
      data,
    );
    return response.data;
  },

  updateSecurityDocument: async (
    securityId: string,
    documentId: string,
    data: Partial<CreateSecurityDocumentData>,
  ): Promise<SecurityDocument> => {
    const response = await apiClient.patch<SecurityDocument>(
      `/securities/${securityId}/documents/${documentId}`,
      data,
    );
    return response.data;
  },

  deleteSecurityDocument: async (
    securityId: string,
    documentId: string,
  ): Promise<void> => {
    await apiClient.delete(`/securities/${securityId}/documents/${documentId}`);
  },

  /**
   * Stored closes for a security.
   *
   * Prefer a date window over a `limit`. The rows come back newest-first, so a
   * limit shorter than the history silently drops its oldest end -- which is
   * the opposite of what a chart asking for "the last five years" wants, and
   * invisible in the response. A windowed request returns the whole window.
   *
   * The window is part of the cache key: two different windows are two
   * different answers, and sharing an entry between them would serve one for
   * the other.
   */
  getSecurityPrices: async (
    securityId: string,
    options: { startDate?: string; endDate?: string; limit?: number } = {},
  ): Promise<SecurityPrice[]> => {
    const { startDate = '', endDate = '', limit } = options;
    const cacheKey = `investments:prices:${securityId}:${startDate}:${endDate}:${limit ?? ''}`;
    const cached = getCached<SecurityPrice[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<SecurityPrice[]>(`/securities/${securityId}/prices`, {
      params: {
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  /**
   * The benchmark catalog, with the history actually stored for each entry so
   * the picker can grey out an index that cannot yet be drawn.
   */
  getMarketIndexes: async (): Promise<MarketIndex[]> => {
    const cacheKey = 'investments:market-indexes';
    const cached = getCached<MarketIndex[]>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<MarketIndex[]>('/investments/performance/indexes');
    setCache(cacheKey, response.data, 300_000);
    return response.data;
  },

  /**
   * Cumulative percent return for securities and indexes over one window.
   *
   * Deliberately uncached: the response carries `excluded` and `status`, which
   * change as the provider backfills an index, and serving a stale "we could
   * not price this" is worse than a round trip.
   */
  getPerformanceComparison: async (params: {
    securityIds?: string[];
    indexCodes?: string[];
    startDate?: string;
    endDate?: string;
  }): Promise<PerformanceComparison> => {
    const response = await apiClient.get<PerformanceComparison>(
      '/investments/performance/comparison',
      {
        params: {
          ...(params.securityIds?.length ? { securityIds: params.securityIds.join(',') } : {}),
          ...(params.indexCodes?.length ? { indexCodes: params.indexCodes.join(',') } : {}),
          ...(params.startDate ? { startDate: params.startDate } : {}),
          ...(params.endDate ? { endDate: params.endDate } : {}),
        },
      },
    );
    return response.data;
  },

  // Create a manual price entry for a security
  createSecurityPrice: async (securityId: string, data: CreateSecurityPriceData): Promise<SecurityPrice> => {
    const response = await apiClient.post<SecurityPrice>(`/securities/${securityId}/prices`, data);
    invalidateCache('investments:prices:');
    return response.data;
  },

  // Update a price entry
  updateSecurityPrice: async (securityId: string, priceId: number, data: Partial<CreateSecurityPriceData>): Promise<SecurityPrice> => {
    const response = await apiClient.patch<SecurityPrice>(`/securities/${securityId}/prices/${priceId}`, data);
    invalidateCache('investments:prices:');
    return response.data;
  },

  // Delete a price entry
  deleteSecurityPrice: async (securityId: string, priceId: number): Promise<void> => {
    await apiClient.delete(`/securities/${securityId}/prices/${priceId}`);
    invalidateCache('investments:prices:');
  },

  // Get sector weightings
  getSectorWeightings: async (accountIds?: string[], securityIds?: string[]): Promise<SectorWeightingResult> => {
    const params: Record<string, string> = {};
    if (accountIds && accountIds.length > 0) params.accountIds = accountIds.join(',');
    if (securityIds && securityIds.length > 0) params.securityIds = securityIds.join(',');
    const cacheKey = `investments:sectorWeightings:${params.accountIds || 'all'}:${params.securityIds || 'all'}`;
    const cached = getCached<SectorWeightingResult>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<SectorWeightingResult>('/portfolio/sector-weightings', {
      params: Object.keys(params).length > 0 ? params : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  getCountryWeightings: async (accountIds?: string[], securityIds?: string[]): Promise<CountryWeightingResult> => {
    const params: Record<string, string> = {};
    if (accountIds && accountIds.length > 0) params.accountIds = accountIds.join(',');
    if (securityIds && securityIds.length > 0) params.securityIds = securityIds.join(',');
    const cacheKey = `investments:countryWeightings:${params.accountIds || 'all'}:${params.securityIds || 'all'}`;
    const cached = getCached<CountryWeightingResult>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<CountryWeightingResult>('/portfolio/country-weightings', {
      params: Object.keys(params).length > 0 ? params : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },

  // Asset-class look-through: funds split by the manual asset allocation saved
  // on the security, everything else placed by security type.
  getAssetClassWeightings: async (accountIds?: string[], securityIds?: string[]): Promise<AssetClassWeightingResult> => {
    const params: Record<string, string> = {};
    if (accountIds && accountIds.length > 0) params.accountIds = accountIds.join(',');
    if (securityIds && securityIds.length > 0) params.securityIds = securityIds.join(',');
    const cacheKey = `investments:assetClassWeightings:${params.accountIds || 'all'}:${params.securityIds || 'all'}`;
    const cached = getCached<AssetClassWeightingResult>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.get<AssetClassWeightingResult>('/portfolio/asset-class-weightings', {
      params: Object.keys(params).length > 0 ? params : undefined,
    });
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },
};
