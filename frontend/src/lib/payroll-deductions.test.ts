import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { clearAllCache } from './apiCache';
import { payrollDeductionsApi } from './payroll-deductions';

vi.mock('./api', () => ({
  default: { get: vi.fn() },
}));

describe('payrollDeductionsApi.report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
  });

  it('asks for the year, and reads each year once within the cache window', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { year: 2025 } });
    await expect(payrollDeductionsApi.report(2025)).resolves.toEqual({ year: 2025 });
    await payrollDeductionsApi.report(2025);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith('/payroll-deductions/report', { params: { year: 2025 } });

    await payrollDeductionsApi.report(2026);
    expect(apiClient.get).toHaveBeenLastCalledWith('/payroll-deductions/report', { params: { year: 2026 } });
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });
});
