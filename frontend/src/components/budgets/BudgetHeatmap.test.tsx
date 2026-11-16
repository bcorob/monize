import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetHeatmap } from './BudgetHeatmap';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

describe('BudgetHeatmap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-15T12:00:00Z'));
    localStorage.clear();
    // Reset before each test, while nothing is mounted: a store write under a
    // mounted tree re-renders it outside act().
    usePreferencesStore.setState({ preferences: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders heading with month label', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    expect(
      screen.getByText('Spending Heatmap - February 2026'),
    ).toBeInTheDocument();
  });

  it('renders weekday headers', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(7);
  });

  it('renders cells for each day in the period', () => {
    render(
      <BudgetHeatmap
        dailySpending={[{ date: '2026-02-01', amount: 50 }]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const cell1 = screen.getByTestId('heatmap-cell-2026-02-01');
    expect(cell1).toBeInTheDocument();
    expect(cell1).toHaveTextContent('1');
  });

  it('highlights today with a ring', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const todayCell = screen.getByTestId('heatmap-cell-2026-02-15');
    expect(todayCell.className).toContain('ring-2');
  });

  it("names a day's spending in a visible readout, not a hover-only title", () => {
    usePreferencesStore.setState({
      preferences: { dateFormat: 'YYYY-MM-DD' } as UserPreferences,
    });
    render(
      <BudgetHeatmap
        dailySpending={[
          { date: '2026-02-10', amount: 125.50 },
          { date: '2026-02-12', amount: 40 },
        ]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    // A phone and a keyboard never reach a title.
    expect(document.querySelector('[title]')).toBeNull();
    // Until a day is chosen, the readout names the busiest one, in the
    // reader's own date format.
    const readout = screen.getByTestId('heatmap-readout');
    expect(readout).toHaveTextContent('2026-02-10: $125.50');

    fireEvent.mouseEnter(screen.getByTestId('heatmap-cell-2026-02-12'));
    expect(readout).toHaveTextContent('2026-02-12: $40.00');

    fireEvent.focus(screen.getByTestId('heatmap-cell-2026-02-03'));
    expect(readout).toHaveTextContent('2026-02-03: $0.00');
    // The same words are the day's accessible name.
    expect(
      screen.getByRole('button', { name: '2026-02-10: $125.50' }),
    ).toBeInTheDocument();
  });

  it('draws no readout while the period has no spending', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.queryByTestId('heatmap-readout')).toBeNull();
  });

  it('names the month in the reader\'s language', () => {
    usePreferencesStore.setState({
      preferences: { language: 'fr' } as UserPreferences,
    });
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const month = new Intl.DateTimeFormat('fr', { month: 'long', year: 'numeric' }).format(
      new Date(2026, 1, 1),
    );
    expect(screen.getByText(`Spending Heatmap - ${month}`)).toBeInTheDocument();
  });

  it('renders legend', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Less')).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
  });

  it('applies heat colors based on spending amount', () => {
    render(
      <BudgetHeatmap
        dailySpending={[
          { date: '2026-02-01', amount: 0 },
          { date: '2026-02-02', amount: 100 },
        ]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const zeroCell = screen.getByTestId('heatmap-cell-2026-02-01');
    const highCell = screen.getByTestId('heatmap-cell-2026-02-02');

    // Zero spending should be gray
    expect(zeroCell.className).toContain('bg-gray-100');
    // Max spending should be red
    expect(highCell.className).toContain('bg-red-400');
  });

  it('navigates to transactions page on date click', () => {
    render(
      <BudgetHeatmap
        dailySpending={[{ date: '2026-02-10', amount: 50 }]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    fireEvent.click(screen.getByTestId('heatmap-cell-2026-02-10'));
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?startDate=2026-02-10&endDate=2026-02-10',
    );
  });

  it('sets active account status in localStorage on date click', () => {
    render(
      <BudgetHeatmap
        dailySpending={[{ date: '2026-02-05', amount: 30 }]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    fireEvent.click(screen.getByTestId('heatmap-cell-2026-02-05'));
    expect(localStorage.getItem('transactions.filter.accountStatus')).toBe(
      JSON.stringify('active'),
    );
  });

  it('renders date cells as buttons the keyboard reaches', () => {
    render(
      <BudgetHeatmap
        dailySpending={[]}
        periodStart="2026-02-01"
        periodEnd="2026-02-28"
        formatCurrency={mockFormat}
      />,
    );

    const cell = screen.getByTestId('heatmap-cell-2026-02-01');
    expect(cell.tagName).toBe('BUTTON');
    expect(cell).toHaveAttribute('type', 'button');
  });
});
