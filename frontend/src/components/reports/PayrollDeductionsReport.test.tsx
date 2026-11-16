import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@/test/render';
import type { PayrollDeductionReport, PayrollReportCategory } from '@/types/payroll-deduction';
import { PayrollDeductionsReport } from './PayrollDeductionsReport';

const mockReport = vi.fn();
vi.mock('@/lib/payroll-deductions', () => ({
  payrollDeductionsApi: { report: (...args: unknown[]) => mockReport(...args) },
}));

const mockExportCsvSections = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportCsvSections: (...args: unknown[]) => mockExportCsvSections(...args),
}));

vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => '2026-10-27',
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (date: string) => `d:${date}` }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, code?: string) => `${code} ${n.toFixed(2)}`,
      formatPercent: (n: number, decimals = 2) => `${n.toFixed(decimals)}%`,
      formatNumber: (n: number) => String(n),
      defaultCurrency: 'CAD',
    }),
  };
});

const category = (over: Partial<PayrollReportCategory> = {}): PayrollReportCategory => ({
  key: 'cat-ei|CAD',
  categoryId: 'cat-ei',
  categoryName: 'EI',
  currencyCode: 'CAD',
  resetDate: '2026-01-01',
  billNames: ['Paycheque'],
  summary: {
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    paidToDate: 1077.48,
    foreignCurrencyRows: 0,
    paycheques: 17,
    averagePerPaycheque: 63.38,
    isCurrent: true,
    yearlyMaximum: 1077.48,
    remaining: 0,
    percentOfMaximum: 100,
    maximumReachedOn: '2026-09-15',
  },
  history: [
    {
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      paidToDate: 1077.48,
      foreignCurrencyRows: 0,
      paycheques: 17,
      averagePerPaycheque: 63.38,
      isCurrent: true,
    },
    {
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      paidToDate: 1049.12,
      foreignCurrencyRows: 2,
      paycheques: 24,
      averagePerPaycheque: 43.71,
      isCurrent: false,
    },
  ],
  ...over,
});

const cpp = category({
  key: 'cat-cpp|CAD',
  categoryId: 'cat-cpp',
  categoryName: 'CPP',
  billNames: ['Paycheque', 'Mid-month'],
  summary: {
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    paidToDate: 401,
    foreignCurrencyRows: 0,
    paycheques: 2,
    averagePerPaycheque: 200.5,
    isCurrent: true,
    yearlyMaximum: 4034.1,
    remaining: 3633.1,
    percentOfMaximum: 9.94,
    maximumReachedOn: null,
  },
  history: [
    {
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      paidToDate: 401,
      foreignCurrencyRows: 0,
      paycheques: 2,
      averagePerPaycheque: 200.5,
      isCurrent: true,
    },
  ],
});

const report = (over: Partial<PayrollDeductionReport> = {}): PayrollDeductionReport => ({
  year: 2026,
  availableYears: [2026, 2025],
  categories: [cpp, category()],
  paycheques: [
    {
      transactionId: 't1',
      transactionDate: '2026-01-15',
      payeeName: 'Employer',
      currencyCode: 'CAD',
      amounts: { 'cat-cpp|CAD': 200.5, 'cat-ei|CAD': 64 },
      total: 264.5,
    },
    {
      transactionId: 't2',
      transactionDate: '2026-01-31',
      payeeName: null,
      currencyCode: 'CAD',
      amounts: { 'cat-cpp|CAD': 200.5 },
      total: 200.5,
    },
  ],
  total: 1478.48,
  totalCurrencyCode: 'CAD',
  ...over,
});

async function renderReport() {
  await act(async () => {
    render(<PayrollDeductionsReport />);
  });
}

describe('PayrollDeductionsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks for the current year by default and draws the summary, the paycheques and one table per category', async () => {
    mockReport.mockResolvedValue(report());
    await renderReport();
    expect(mockReport).toHaveBeenCalledWith(2026);

    const summary = screen.getByRole('region', { name: 'Summary for 2026' });
    const eiRow = within(summary).getByText('EI').closest('tr')!;
    expect(eiRow).toHaveTextContent('CAD 1077.48');
    expect(eiRow).toHaveTextContent('100.0%');
    expect(eiRow).toHaveTextContent('d:2026-09-15');
    expect(eiRow).toHaveTextContent('to date');
    const cppRow = within(summary).getByText('CPP').closest('tr')!;
    expect(cppRow).toHaveTextContent('Paycheque and Mid-month');
    expect(cppRow).toHaveTextContent('Not reached');

    const paycheques = screen.getByRole('region', { name: 'Paycheque by paycheque, 2026' });
    const rows = within(paycheques).getAllByRole('row');
    // Header, two paycheques, the footer.
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('d:2026-01-15');
    expect(rows[1]).toHaveTextContent('CAD 264.50');
    // A paycheque with no line for a category deducted nothing to it.
    expect(rows[2]).toHaveTextContent('No payee');
    expect(rows[2]).toHaveTextContent('CAD 0.00');
    expect(rows[3]).toHaveTextContent('Total');
    expect(rows[3]).toHaveTextContent('CAD 1478.48');

    expect(screen.getByRole('region', { name: 'EI by year' })).toHaveTextContent('2025');
    expect(screen.getByRole('region', { name: 'EI by year' })).toHaveTextContent('2 rows in another currency not counted');
    expect(screen.getByRole('region', { name: 'CPP by year' })).toBeInTheDocument();
  });

  it('says a closed year\'s maximum was not recorded rather than showing today\'s', async () => {
    mockReport.mockResolvedValue(
      report({
        year: 2025,
        categories: [
          category({
            summary: {
              ...category().summary,
              periodStart: '2025-01-01',
              periodEnd: '2025-12-31',
              isCurrent: false,
              yearlyMaximum: null,
              remaining: null,
              percentOfMaximum: null,
              maximumReachedOn: null,
            },
          }),
        ],
        paycheques: [],
      }),
    );
    await renderReport();
    const summary = screen.getByRole('region', { name: 'Summary for 2025' });
    expect(within(summary).getAllByText('Not recorded')).toHaveLength(4);
    expect(screen.getByText('Nothing was deducted to these categories in 2025.')).toBeInTheDocument();
  });

  it('asks again for the year picked', async () => {
    mockReport.mockResolvedValue(report());
    await renderReport();
    // The label sits on the picker's left, and the picker is sized for a year.
    const select = screen.getByLabelText('Year');
    const label = screen.getByText('Year', { selector: 'label' });
    expect(label.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(select.closest('.w-28')).not.toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2025' } });
    });
    expect(mockReport).toHaveBeenLastCalledWith(2025);
  });

  it('names each column by currency and adds no total across currencies', async () => {
    mockReport.mockResolvedValue(
      report({
        categories: [category(), category({ key: 'cat-ei|USD', currencyCode: 'USD' })],
        total: null,
        totalCurrencyCode: null,
      }),
    );
    await renderReport();
    expect(screen.getByRole('columnheader', { name: 'EI (CAD)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'EI (USD)' })).toBeInTheDocument();
    expect(screen.getByText('Not added: the categories are in more than one currency.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'EI (USD) by year' })).toBeInTheDocument();
    // A CAD paycheque was not counted for the USD column: not a zero.
    const paycheques = screen.getByRole('region', { name: 'Paycheque by paycheque, 2026' });
    expect(within(paycheques).getAllByText('Other currency')).toHaveLength(2);
  });

  it('marks a paycheque outside a category\'s own period as not counted, never as a zero', async () => {
    // EI resets on 1 July, so its 2026 period starts after both January paycheques.
    const julyEi = category({
      resetDate: '2025-07-01',
      summary: { ...category().summary, periodStart: '2026-07-01', periodEnd: '2027-06-30', paidToDate: 0 },
    });
    mockReport.mockResolvedValue(
      report({
        categories: [cpp, julyEi],
        paycheques: report().paycheques.map((p) => ({
          ...p,
          amounts: { 'cat-cpp|CAD': 200.5 },
          total: 200.5,
        })),
      }),
    );
    await renderReport();
    const paycheques = screen.getByRole('region', { name: 'Paycheque by paycheque, 2026' });
    const rows = within(paycheques).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Outside its period');
    expect(rows[1]).not.toHaveTextContent('CAD 0.00');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const [, sections] = mockExportCsvSections.mock.calls[0];
    expect(sections[1].rows[0]).toEqual(['2026-01-15', 'Employer', 200.5, '', 200.5]);
  });

  it('points to the Payroll Deductions tool when there are no rules', async () => {
    mockReport.mockResolvedValue(report({ categories: [], paycheques: [], total: 0, totalCurrencyCode: null }));
    await renderReport();
    expect(screen.getByText('No payroll deduction rules yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Payroll Deductions' })).toHaveAttribute(
      'href',
      '/taxes/payroll-deductions',
    );
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });

  it('shows a retryable error when the report fails to load', async () => {
    mockReport.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(report());
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });
    expect(screen.getByRole('region', { name: 'Summary for 2026' })).toBeInTheDocument();
  });

  it('exports the summary, the paycheques and each category\'s years as CSV sections', async () => {
    mockReport.mockResolvedValue(report());
    await renderReport();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const [filename, sections] = mockExportCsvSections.mock.calls[0];
    expect(filename).toBe('payroll-deductions-2026');
    expect(sections.map((s: { title: string }) => s.title)).toEqual([
      'Summary',
      'Paycheques',
      'CPP by year',
      'EI by year',
    ]);
    expect(sections[0].rows[1]).toEqual([
      'EI',
      'Paycheque',
      '2026-01-01 - 2026-12-31',
      1077.48,
      1077.48,
      0,
      100,
      17,
      63.38,
      '2026-09-15',
    ]);
    expect(sections[1].rows).toEqual([
      ['2026-01-15', 'Employer', 200.5, 64, 264.5],
      ['2026-01-31', '', 200.5, 0, 200.5],
    ]);
    expect(sections[3].rows[1]).toEqual(['2025', '2025-01-01 - 2025-12-31', 24, 1049.12, 43.71]);
  });
});
