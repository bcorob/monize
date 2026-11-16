import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { WeekendVsWeekdayWidget } from './WeekendVsWeekdayWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

const configState = { current: { range: '3m', view: 'overview' as 'overview' | 'byDay' } };
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});
const getWeekendVsWeekday = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: { getWeekendVsWeekday: (...a: unknown[]) => getWeekendVsWeekday(...a) },
}));

const RESPONSE = {
  summary: { weekendTotal: 400, weekdayTotal: 600, weekendCount: 8, weekdayCount: 20 },
  byDay: [
    { dayOfWeek: 0, total: 200, count: 4 },
    { dayOfWeek: 1, total: 150, count: 5 },
    { dayOfWeek: 6, total: 200, count: 4 },
  ],
  byCategory: [],
};

async function renderWidget() {
  await act(async () => {
    render(<WeekendVsWeekdayWidget isLoading={false} />);
  });
}

describe('WeekendVsWeekdayWidget', () => {
  beforeEach(() => {
    getWeekendVsWeekday.mockReset().mockResolvedValue(RESPONSE);
    configState.current = { range: '3m', view: 'overview' };
  });

  it('renders the overview donut with the weekend percentage', async () => {
    await renderWidget();
    expect(screen.getByText('Weekend vs Weekday Spending')).toBeInTheDocument();
    expect(screen.getByText('3M')).toBeInTheDocument();
    // 400 / 1000 = 40%
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('renders the by-day view', async () => {
    configState.current = { range: '3m', view: 'byDay' };
    await renderWidget();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('shows the empty state when there is no spending', async () => {
    getWeekendVsWeekday.mockResolvedValue({
      summary: { weekendTotal: 0, weekdayTotal: 0, weekendCount: 0, weekdayCount: 0 },
      byDay: [],
      byCategory: [],
    });
    await renderWidget();
    expect(screen.getByText('No spending in this period.')).toBeInTheDocument();
  });

  it('shows the known parts as subtotals and withholds the weekend share', async () => {
    getWeekendVsWeekday.mockResolvedValue({
      summary: {
        weekendTotal: null,
        weekdayTotal: null,
        knownWeekendTotal: 50,
        knownWeekdayTotal: 150,
        weekendCount: 1,
        weekdayCount: 3,
      },
      byDay: [{ dayOfWeek: 0, total: 50, count: 1 }],
      byCategory: [],
      currency: 'CAD',
      missingCurrencies: ['JPY'],
      excludedCount: 2,
    });
    await renderWidget();
    const markers = screen.getAllByTestId('partial-total');
    expect(markers).toHaveLength(2);
    expect(markers[0]).toHaveTextContent('$50');
    expect(markers[1]).toHaveTextContent('$150');
    // A share of an unknown total is not 25%, and certainly not 0%.
    expect(screen.queryByText('25%')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getByTestId('unknown-amount')).toBeInTheDocument();
  });
});
