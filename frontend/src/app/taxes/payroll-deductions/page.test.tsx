import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import toast from 'react-hot-toast';
import type { PayrollDeductionRule } from '@/types/payroll-deduction';
import PayrollDeductionsPage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/hooks/useOnUndoRedo', () => ({ useOnUndoRedo: vi.fn() }));
vi.mock('@/hooks/useOnAiAction', () => ({ useOnAiAction: vi.fn() }));

const FORM_PAYLOAD = {
  scheduledTransactionId: 'st-pay',
  resetPeriod: 'YEARLY',
  resetDate: '2026-01-01',
  lines: [
    { categoryId: 'cat-ei', yearlyMaximum: 1077.48, expectedPerPaycheque: null },
    { categoryId: 'cat-cpp', yearlyMaximum: 4034.1, expectedPerPaycheque: 150 },
  ],
};
// The form is loaded through dynamic(); a stub shows what the page handed it.
vi.mock('next/dynamic', () => ({
  default: () =>
    function RuleFormStub(props: any) {
      return (
        <div data-testid="rule-form">
          {props.rule && <span data-testid="editing">{props.rule.categoryName}</span>}
          <span data-testid="bills">{props.scheduledTransactions.length}</span>
          <span data-testid="existing">{props.existingRules.length}</span>
          <button type="button" onClick={() => props.onSubmit(FORM_PAYLOAD).catch(() => {})}>
            Submit stub
          </button>
        </div>
      );
    },
}));

const mockList = vi.fn();
const mockHistory = vi.fn();
const mockCreateMany = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock('@/lib/payroll-deductions', () => ({
  payrollDeductionsApi: {
    list: (...args: unknown[]) => mockList(...args),
    history: (...args: unknown[]) => mockHistory(...args),
    createMany: (...args: unknown[]) => mockCreateMany(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    suggest: vi.fn(),
  },
}));
const mockScheduled = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { getAll: (...args: unknown[]) => mockScheduled(...args) },
}));
const mockCategories = vi.fn();
vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: (...args: unknown[]) => mockCategories(...args) },
}));

function rule(overrides: Partial<PayrollDeductionRule> = {}): PayrollDeductionRule {
  return {
    id: 'rule-1',
    userId: 'u1',
    scheduledTransactionId: 'st-pay',
    scheduledTransactionName: 'Paycheque',
    categoryId: 'cat-ei',
    categoryName: 'EI',
    yearlyMaximum: 1077.48,
    resetPeriod: 'YEARLY',
    resetDate: '2026-01-01',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    nextResetOn: '2027-01-01',
    paidToDate: 1024,
    remaining: 53.48,
    foreignCurrencyRows: 0,
    currencyCode: 'CAD',
    expectedPerPaycheque: 64,
    expectedSource: 'line',
    createdAt: '2026-01-05T00:00:00Z',
    updatedAt: '2026-01-05T00:00:00Z',
    ...overrides,
  };
}

async function renderPage() {
  await act(async () => {
    render(<PayrollDeductionsPage />);
  });
}

describe('PayrollDeductionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([rule()]);
    mockHistory.mockResolvedValue([
      {
        categoryId: 'cat-ei',
        categoryName: 'EI',
        currencyCode: 'CAD',
        periods: [
          { periodStart: '2025-01-01', periodEnd: '2025-12-31', paidToDate: 1049.12, foreignCurrencyRows: 0 },
          { periodStart: '2024-01-01', periodEnd: '2024-12-31', paidToDate: 1002.45, foreignCurrencyRows: 0 },
        ],
      },
    ]);
    mockScheduled.mockResolvedValue([{ id: 'st-pay', name: 'Paycheque', isActive: true }]);
    mockCategories.mockResolvedValue([]);
    mockCreateMany.mockResolvedValue([rule(), rule({ id: 'rule-2', categoryId: 'cat-cpp' })]);
    mockUpdate.mockResolvedValue(rule());
    mockDelete.mockResolvedValue(undefined);
  });

  it('lists the rules with the maximum, the reset date and where the expected figure came from', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Payroll Deductions' })).toBeInTheDocument();
    expect(screen.getByText('Paycheque')).toBeInTheDocument();
    expect(screen.getByText('EI')).toBeInTheDocument();
    expect(screen.getByText('$1,077.48')).toBeInTheDocument();
    expect(screen.getByText('$64.00')).toBeInTheDocument();
    expect(screen.getByText("From the bill's line")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Taxes' })).toHaveAttribute('href', '/taxes');
  });

  it('keeps the year-to-date table collapsed until asked, then shows paid, maximum and remaining', async () => {
    await renderPage();
    expect(screen.queryByText('Paid this period')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Show year-to-date/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('Paid this period')).toBeInTheDocument();
    expect(screen.getByText('$1,024.00')).toBeInTheDocument();
    expect(screen.getByText('$53.48')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hide year-to-date/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Hide year-to-date/ }));
    expect(screen.queryByText('Paid this period')).not.toBeInTheDocument();
  });

  it('keeps the previous periods collapsed until asked, then loads and lists each closed period', async () => {
    await renderPage();
    expect(screen.queryByText('Previous Periods')).not.toBeInTheDocument();
    expect(mockHistory).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Show previous periods/ }));
    });
    expect(mockHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Previous Periods')).toBeInTheDocument();
    expect(await screen.findByText('$1,049.12')).toBeInTheDocument();
    expect(screen.getByText('$1,002.45')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Hide previous periods/ }));
    expect(screen.queryByText('Previous Periods')).not.toBeInTheDocument();
  });

  it('stretches each disclosure button across a phone line, alone on its row', async () => {
    await renderPage();
    for (const name of [/Show year-to-date/, /Show previous periods/]) {
      const toggle = screen.getByRole('button', { name });
      expect(toggle.className).toContain('w-full');
      expect(toggle.className).toContain('sm:w-auto');
    }
  });

  it('says when rows in another currency were left out of the paid figure', async () => {
    mockList.mockResolvedValue([rule({ foreignCurrencyRows: 2 })]);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Show year-to-date/ }));
    expect(screen.getByText('2 rows in another currency not counted')).toBeInTheDocument();
  });

  it('shows the empty state with a create button when there is no rule', async () => {
    mockList.mockResolvedValue([]);
    await renderPage();
    expect(screen.getByText('No deduction rules yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /year-to-date/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create Your First Rule' }));
    expect(screen.getByTestId('rule-form')).toBeInTheDocument();
    expect(screen.getByTestId('bills')).toHaveTextContent('1');
  });

  it('creates every line of the form in one request, hands the form the existing rules and reloads', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: '+ New Rule' }));
    expect(screen.getByTestId('existing')).toHaveTextContent('1');
    await act(async () => {
      fireEvent.click(screen.getByText('Submit stub'));
    });
    expect(mockCreateMany).toHaveBeenCalledWith(FORM_PAYLOAD);
    expect(toast.success).toHaveBeenCalledWith('2 deduction rules created');
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('edits the chosen rule', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit EI' }));
    expect(screen.getByTestId('editing')).toHaveTextContent('EI');
    await act(async () => {
      fireEvent.click(screen.getByText('Submit stub'));
    });
    // An edit is the one-line case: the first line, flattened onto the shared fields.
    expect(mockUpdate).toHaveBeenCalledWith('rule-1', {
      scheduledTransactionId: 'st-pay',
      resetPeriod: 'YEARLY',
      resetDate: '2026-01-01',
      categoryId: 'cat-ei',
      yearlyMaximum: 1077.48,
      expectedPerPaycheque: null,
    });
    expect(toast.success).toHaveBeenCalledWith('Deduction rule updated');
  });

  it('deletes after confirming and drops the row', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete EI' }));
    expect(screen.getByText(/Delete the EI rule on Paycheque\?/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    expect(mockDelete).toHaveBeenCalledWith('rule-1');
    await waitFor(() => expect(screen.queryByText('EI')).not.toBeInTheDocument());
  });

  it('reports a failed load and a failed create', async () => {
    mockList.mockRejectedValue({ response: { data: {} } });
    await renderPage();
    expect(toast.error).toHaveBeenCalledWith('Failed to load payroll deductions');

    mockList.mockResolvedValue([]);
    mockCreateMany.mockRejectedValue({ response: { data: {} } });
    await renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: '+ New Rule' })[0]);
    await act(async () => {
      fireEvent.click(screen.getByText('Submit stub'));
    });
    expect(toast.error).toHaveBeenCalledWith('Failed to create the deduction rule');
  });
});
