import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SpendingByPayeeWidget } from './SpendingByPayeeWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const updateConfig = vi.fn();
const configState = { current: { range: '3m' } };
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n}`,
      formatCurrencyCompact: (n: number) => `$${n}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});
const getSpendingByPayee = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: { getSpendingByPayee: (...a: unknown[]) => getSpendingByPayee(...a) },
}));

async function renderWidget() {
  await act(async () => {
    render(<SpendingByPayeeWidget isLoading={false} />);
  });
}

describe('SpendingByPayeeWidget', () => {
  beforeEach(() => {
    getSpendingByPayee.mockReset();
    updateConfig.mockReset();
    configState.current = { range: '3m' };
  });

  it('fetches the configured range and renders the total', async () => {
    getSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: 'p1', payeeName: 'Grocer', total: 300 }],
      totalSpending: 300,
    });
    await renderWidget();
    expect(screen.getByText('Spending by Payee')).toBeInTheDocument();
    expect(getSpendingByPayee).toHaveBeenCalledWith(
      expect.objectContaining({ endDate: expect.any(String) }),
    );
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByText('$300')).toBeInTheDocument();
  });

  it('shows the empty state when there is no spending', async () => {
    getSpendingByPayee.mockResolvedValue({ data: [], totalSpending: 0 });
    await renderWidget();
    expect(screen.getByText('No spending in this period.')).toBeInTheDocument();
  });

  it('marks the total a subtotal when a payee row was left out', async () => {
    getSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: 'p1', payeeName: 'Grocer', total: 50 }],
      totalSpending: null,
      knownSpending: 50,
      currency: 'CAD',
      missingCurrencies: ['JPY'],
      excludedCount: 1,
    });
    await renderWidget();
    expect(screen.getByTestId('partial-total')).toHaveTextContent('$50');
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });
});
