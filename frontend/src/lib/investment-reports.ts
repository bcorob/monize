import apiClient from './api';
import {
  InvestmentReport,
  CreateInvestmentReportData,
  UpdateInvestmentReportData,
  InvestmentReportResult,
} from '@/types/investment-report';
import { InvestmentTransactionSummary } from '@/types/investment';
import { dedupe, patchCached, invalidateCache } from './apiCache';

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

/** The filter the transaction-history report is showing, for its KPIs. */
export interface InvestmentTransactionSummaryParams {
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  actions?: string[];
}

export const investmentReportsApi = {
  /**
   * Volume, count and by-action subtotals over the WHOLE filtered set.
   *
   * Asked of the server rather than added up beside the table: the rows are in
   * each security's own currency, and the client fetches only a bounded number
   * of pages, so a figure derived here would be an unlabelled cross-currency sum
   * of part of the data (issue #1394).
   */
  getTransactionSummary: async (
    params: InvestmentTransactionSummaryParams,
  ): Promise<InvestmentTransactionSummary> => {
    const response = await apiClient.get<InvestmentTransactionSummary>(
      '/reports/investment-transactions/summary',
      {
        params: {
          accountIds: params.accountIds?.length ? params.accountIds.join(',') : undefined,
          startDate: params.startDate || undefined,
          endDate: params.endDate || undefined,
          actions: params.actions?.length ? params.actions.join(',') : undefined,
        },
      },
    );
    return response.data;
  },

  create: async (data: CreateInvestmentReportData): Promise<InvestmentReport> => {
    const response = await apiClient.post<InvestmentReport>('/reports/investment', data);
    invalidateCache('investment-reports:');
    return response.data;
  },

  getAll: async (): Promise<InvestmentReport[]> => {
    return dedupe(INVESTMENT_REPORTS_CACHE_KEY, async () => {
      const response = await apiClient.get<InvestmentReport[]>('/reports/investment');
      return response.data;
    }, INVESTMENT_REPORTS_CACHE_TTL);
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
    patchCached<InvestmentReport[]>(
      INVESTMENT_REPORTS_CACHE_KEY,
      (list) =>
        list.map((report) =>
          report.id === id ? { ...report, isFavourite } : report,
        ),
      INVESTMENT_REPORTS_CACHE_TTL,
    );
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
