import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { builtInReportsApi } from './built-in-reports';

vi.mock('./api', () => ({
  default: { get: vi.fn() },
}));

describe('builtInReportsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  const params = { startDate: '2025-01-01', endDate: '2025-01-31' } as any;

  it('getSpendingByCategory fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { categories: [] } });
    await builtInReportsApi.getSpendingByCategory(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/spending-by-category', { params });
  });

  it('getSpendingByPayee fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { payees: [] } });
    await builtInReportsApi.getSpendingByPayee(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/spending-by-payee', { params });
  });

  it('getIncomeBySource fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { sources: [] } });
    await builtInReportsApi.getIncomeBySource(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/income-by-source', { params });
  });

  it('getMonthlySpendingTrend fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { months: [] } });
    await builtInReportsApi.getMonthlySpendingTrend(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/monthly-spending-trend', { params });
  });

  it('getIncomeVsExpenses fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getIncomeVsExpenses(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/income-vs-expenses', { params });
  });

  it('getCashFlow fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getCashFlow(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/cash-flow', { params });
  });

  it('getSpendingByCategory sends the tag filter and nothing else new', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getSpendingByCategory({ ...params, tagKey: 'scope', tagValue: 'household' });
    expect(apiClient.get).toHaveBeenLastCalledWith('/built-in-reports/spending-by-category', {
      params: { ...params, tagKey: 'scope', tagValue: 'household' },
    });
  });

  it.each([
    ['getIncomeBySource', '/built-in-reports/income-by-source'],
    ['getCashFlow', '/built-in-reports/cash-flow'],
    ['getIncomeVsExpenses', '/built-in-reports/income-vs-expenses'],
    ['getSpendingByCategory', '/built-in-reports/spending-by-category'],
    ['getMonthlyCategoryBreakdown', '/built-in-reports/monthly-category-breakdown'],
  ] as const)('%s sends accountIds as one comma-separated value and omits an empty selection', async (method, url) => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi[method]({ ...params, accountIds: ['a1', 'a2'] });
    expect(apiClient.get).toHaveBeenLastCalledWith(url, {
      params: { ...params, accountIds: 'a1,a2' },
    });
    await builtInReportsApi[method]({ ...params, accountIds: [] });
    expect(apiClient.get).toHaveBeenLastCalledWith(url, { params });
  });

  it.each([
    ['getCashFlow', '/built-in-reports/cash-flow'],
    ['getIncomeVsExpenses', '/built-in-reports/income-vs-expenses'],
  ] as const)('%s sends transferScopeAccountIds as one comma-separated value and omits an empty one', async (method, url) => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi[method]({ ...params, transferScopeAccountIds: ['a1', 'a2'] });
    expect(apiClient.get).toHaveBeenLastCalledWith(url, {
      params: { ...params, transferScopeAccountIds: 'a1,a2' },
    });
    await builtInReportsApi[method]({ ...params, transferScopeAccountIds: [] });
    expect(apiClient.get).toHaveBeenLastCalledWith(url, { params });
  });

  it('getYearOverYear defaults to 2 years', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getYearOverYear();
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/year-over-year', {
      params: { yearsToCompare: 2 },
    });
  });

  it('getYearOverYear passes custom years', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getYearOverYear(5);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/year-over-year', {
      params: { yearsToCompare: 5 },
    });
  });

  it('getWeekendVsWeekday fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getWeekendVsWeekday(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/weekend-vs-weekday', { params });
  });

  it('getSpendingAnomalies defaults threshold to 2', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getSpendingAnomalies();
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/spending-anomalies', {
      params: { threshold: 2 },
    });
  });

  it('getTaxSummary fetches with year', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getTaxSummary(2024);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/tax-summary', {
      params: { year: 2024 },
    });
  });

  it('getRecurringExpenses defaults minOccurrences to 3', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getRecurringExpenses();
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/recurring-expenses', {
      params: { minOccurrences: 3 },
    });
  });

  it('getRecurringExpenses sends the range when one is given', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getRecurringExpenses(4, '5y');
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/recurring-expenses', {
      params: { minOccurrences: 4, range: '5y' },
    });
  });

  it('getBillPaymentHistory fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getBillPaymentHistory(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/bill-payment-history', { params });
  });

  it('getUncategorizedTransactions fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getUncategorizedTransactions({ ...params, limit: 50 });
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/uncategorized-transactions', {
      params: { ...params, limit: 50 },
    });
  });

  it('getDuplicateTransactions fetches with sensitivity', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getDuplicateTransactions({ ...params, sensitivity: 'high' });
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/duplicate-transactions', {
      params: { ...params, sensitivity: 'high' },
    });
  });

  it('getMonthlyComparison fetches with the month param and returns data', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { month: '2024-03', categories: [] } });
    const result = await builtInReportsApi.getMonthlyComparison('2024-03');
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/monthly-comparison', {
      params: { month: '2024-03' },
    });
    expect(result).toEqual({ month: '2024-03', categories: [] });
  });

  it('getCashFlowSankey sends the scope as one comma-separated value', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { nodes: [] } });
    await builtInReportsApi.getCashFlowSankey({ ...params, accountIds: ['a-1', 'a-2'], depth: 2 });
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/cash-flow-sankey', {
      params: { ...params, depth: 2, accountIds: 'a-1,a-2' },
    });
  });

  it('getCashFlowSankey leaves an empty scope to the server default', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { nodes: [] } });
    await builtInReportsApi.getCashFlowSankey({ ...params, accountIds: [] });
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/cash-flow-sankey', { params });
  });
});
