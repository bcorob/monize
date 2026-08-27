import apiClient from './api';
import {
  CustomReport,
  CreateCustomReportData,
  UpdateCustomReportData,
  ReportResult,
  TimeframeType,
} from '@/types/custom-report';
import { getCached, setCache, invalidateCache } from './apiCache';

// The saved-reports list lives under one cache key; keep the key and TTL in one
// place so getAll and the optimistic favourite patch below cannot drift.
const REPORTS_CACHE_KEY = 'reports:all';
const REPORTS_CACHE_TTL = 300_000; // 5 minutes

export interface ExecuteReportParams {
  timeframeType?: TimeframeType;
  startDate?: string;
  endDate?: string;
}

export const customReportsApi = {
  // Create a new custom report
  create: async (data: CreateCustomReportData): Promise<CustomReport> => {
    const response = await apiClient.post<CustomReport>('/reports/custom', data);
    invalidateCache('reports:');
    return response.data;
  },

  // Get all custom reports for the current user
  getAll: async (): Promise<CustomReport[]> => {
    const cached = getCached<CustomReport[]>(REPORTS_CACHE_KEY);
    if (cached) return cached;
    const response = await apiClient.get<CustomReport[]>('/reports/custom');
    setCache(REPORTS_CACHE_KEY, response.data, REPORTS_CACHE_TTL);
    return response.data;
  },

  // Get a specific custom report by ID
  getById: async (id: string): Promise<CustomReport> => {
    const response = await apiClient.get<CustomReport>(`/reports/custom/${id}`);
    return response.data;
  },

  // Update a custom report
  update: async (id: string, data: UpdateCustomReportData): Promise<CustomReport> => {
    const response = await apiClient.patch<CustomReport>(`/reports/custom/${id}`, data);
    invalidateCache('reports:');
    return response.data;
  },

  // Delete a custom report
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/reports/custom/${id}`);
    invalidateCache('reports:');
  },

  // Execute a custom report and get aggregated data
  execute: async (id: string, params?: ExecuteReportParams): Promise<ReportResult> => {
    const response = await apiClient.post<ReportResult>(
      `/reports/custom/${id}/execute`,
      params || {},
    );
    return response.data;
  },

  // Toggle favourite status
  toggleFavourite: async (id: string, isFavourite: boolean): Promise<CustomReport> => {
    // Reflect the new favourite in the shared list cache the moment the toggle
    // starts, so a surface re-reading getAll before the request settles -- the
    // report switcher mounting as the user navigates straight to the report they
    // just starred -- already shows the new order (issue #1224). The
    // invalidateCache below drops this optimistic copy once the server answers,
    // on either path, so the next read reconciles against the server.
    const cached = getCached<CustomReport[]>(REPORTS_CACHE_KEY);
    if (cached) {
      setCache(
        REPORTS_CACHE_KEY,
        cached.map((report) =>
          report.id === id ? { ...report, isFavourite } : report,
        ),
        REPORTS_CACHE_TTL,
      );
    }
    try {
      const response = await apiClient.patch<CustomReport>(`/reports/custom/${id}`, {
        isFavourite,
      });
      invalidateCache('reports:');
      return response.data;
    } catch (error) {
      invalidateCache('reports:');
      throw error;
    }
  },
};
