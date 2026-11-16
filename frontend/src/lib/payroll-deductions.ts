import apiClient from './api';
import { dedupe, invalidateCache } from './apiCache';
import type {
  CreatePayrollDeductionRuleData,
  CreatePayrollDeductionRulesData,
  ExpectedAmountSuggestion,
  PayrollDeductionHistory,
  PayrollDeductionReport,
  PayrollDeductionRule,
  UpdatePayrollDeductionRuleData,
} from '@/types/payroll-deduction';

/**
 * Short-lived: every rule carries today's `paidToDate` and `remaining`, and a
 * post or a register edit elsewhere moves them.
 */
const READ_TTL_MS = 30_000;

/**
 * A rule changes what the forecast projects and what the next posting books,
 * and the scheduled read model carries the figures, so a write drops both
 * caches.
 */
function afterWrite(): void {
  invalidateCache('payroll-deductions:');
  invalidateCache('scheduled:');
}

export const payrollDeductionsApi = {
  list: async (): Promise<PayrollDeductionRule[]> =>
    dedupe(
      'payroll-deductions:list',
      async () => {
        const response = await apiClient.get<PayrollDeductionRule[]>('/payroll-deductions');
        return response.data;
      },
      READ_TTL_MS,
    ),

  /** What each ruled category collected in its closed periods. */
  history: async (): Promise<PayrollDeductionHistory[]> =>
    dedupe(
      'payroll-deductions:history',
      async () => {
        const response = await apiClient.get<PayrollDeductionHistory[]>('/payroll-deductions/history');
        return response.data;
      },
      READ_TTL_MS,
    ),

  /** The payroll deductions report for the periods starting in `year`. */
  report: async (year: number): Promise<PayrollDeductionReport> =>
    dedupe(
      `payroll-deductions:report:${year}`,
      async () => {
        const response = await apiClient.get<PayrollDeductionReport>('/payroll-deductions/report', {
          params: { year },
        });
        return response.data;
      },
      READ_TTL_MS,
    ),

  suggest: async (
    scheduledTransactionId: string,
    categoryId: string,
    resetDate?: string,
  ): Promise<ExpectedAmountSuggestion> => {
    const response = await apiClient.get<ExpectedAmountSuggestion>('/payroll-deductions/suggest', {
      params: { scheduledTransactionId, categoryId, ...(resetDate && { resetDate }) },
    });
    return response.data;
  },

  create: async (data: CreatePayrollDeductionRuleData): Promise<PayrollDeductionRule> => {
    const response = await apiClient.post<PayrollDeductionRule>('/payroll-deductions', data);
    afterWrite();
    return response.data;
  },

  /** Every line of one bill in one request; none is written when one is refused. */
  createMany: async (data: CreatePayrollDeductionRulesData): Promise<PayrollDeductionRule[]> => {
    const response = await apiClient.post<PayrollDeductionRule[]>('/payroll-deductions/batch', data);
    afterWrite();
    return response.data;
  },

  update: async (id: string, data: UpdatePayrollDeductionRuleData): Promise<PayrollDeductionRule> => {
    const response = await apiClient.patch<PayrollDeductionRule>(`/payroll-deductions/${id}`, data);
    afterWrite();
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/payroll-deductions/${id}`);
    afterWrite();
  },
};
