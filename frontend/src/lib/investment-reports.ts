import apiClient from './api';
import {
  InvestmentReport,
  CreateInvestmentReportData,
  UpdateInvestmentReportData,
  InvestmentReportResult,
} from '@/types/investment-report';
import { getCached, setCache, invalidateCache } from './apiCache';

// The saved investment-reports list lives under one cache key; keep the key and
// TTL in one place so getAll and the optimistic favourite patch cannot drift.
const INVESTMENT_REPORTS_CACHE_KEY = 'investment-reports:all';
const INVESTMENT_REPORTS_CACHE_TTL = 300_000; // 5 minutes

export interface ExecuteInvestmentReportParams {
  asOfDate?: string;
  /**
   * Override the accounts to run against for this execution. Empty array means
   * all accounts. Omit to fall back to the report's saved config.
   */
  accountIds?: string[];
}

export const investmentReportsApi = {
  create: async (data: CreateInvestmentReportData): Promise<InvestmentReport> => {
    const response = await apiClient.post<InvestmentReport>('/reports/investment', data);
    invalidateCache('investment-reports:');
    return response.data;
  },

  getAll: async (): Promise<InvestmentReport[]> => {
    const cached = getCached<InvestmentReport[]>(INVESTMENT_REPORTS_CACHE_KEY);
    if (cached) return cached;
    const response = await apiClient.get<InvestmentReport[]>('/reports/investment');
    setCache(INVESTMENT_REPORTS_CACHE_KEY, response.data, INVESTMENT_REPORTS_CACHE_TTL);
    return response.data;
  },

  getById: async (id: string): Promise<InvestmentReport> => {
    const response = await apiClient.get<InvestmentReport>(`/reports/investment/${id}`);
    return response.data;
  },

  update: async (
    id: string,
    data: UpdateInvestmentReportData,
  ): Promise<InvestmentReport> => {
    const response = await apiClient.patch<InvestmentReport>(`/reports/investment/${id}`, data);
    invalidateCache('investment-reports:');
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/reports/investment/${id}`);
    invalidateCache('investment-reports:');
  },

  execute: async (
    id: string,
    params?: ExecuteInvestmentReportParams,
  ): Promise<InvestmentReportResult> => {
    const response = await apiClient.post<InvestmentReportResult>(
      `/reports/investment/${id}/execute`,
      params || {},
    );
    return response.data;
  },

  toggleFavourite: async (id: string, isFavourite: boolean): Promise<InvestmentReport> => {
    // Reflect the new favourite in the shared list cache the moment the toggle
    // starts, so a surface re-reading getAll before the request settles -- the
    // report switcher mounting as the user navigates straight to the report they
    // just starred -- already shows the new order (issue #1224). The
    // invalidateCache below drops this optimistic copy once the server answers,
    // on either path, so the next read reconciles against the server.
    const cached = getCached<InvestmentReport[]>(INVESTMENT_REPORTS_CACHE_KEY);
    if (cached) {
      setCache(
        INVESTMENT_REPORTS_CACHE_KEY,
        cached.map((report) =>
          report.id === id ? { ...report, isFavourite } : report,
        ),
        INVESTMENT_REPORTS_CACHE_TTL,
      );
    }
    try {
      const response = await apiClient.patch<InvestmentReport>(`/reports/investment/${id}`, {
        isFavourite,
      });
      invalidateCache('investment-reports:');
      return response.data;
    } catch (error) {
      invalidateCache('investment-reports:');
      throw error;
    }
  },
};
