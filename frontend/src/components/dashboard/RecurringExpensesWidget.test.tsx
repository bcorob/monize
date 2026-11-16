import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { render } from '@/test/render';
import { RecurringExpensesWidget } from './RecurringExpensesWidget';
import type { RecurringConfig } from './widget-config';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const updateConfig = vi.fn();
const configState: { current: RecurringConfig } = {
  current: { minOccurrences: 3, range: '6m', view: 'callouts' },
};
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
    }),
  };
});
const getRecurringExpenses = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: { getRecurringExpenses: (...a: unknown[]) => getRecurringExpenses(...a) },
}));

function item(payeeName: string, payeeId: string | null, totalAmount: number) {
  return {
    payeeName,
    payeeId,
    occurrences: 6,
    totalAmount,
    averageAmount: totalAmount / 6,
    lastTransactionDate: '2026-06-01',
    frequency: 'MONTHLY',
    categoryName: null,
  };
}

const TEN_PAYEES = [
  item('Hydro', 'p1', 900),
  item('Netflix', 'p2', 90),
  item('Gym', 'p3', 300),
  item('Phone', 'p4', 240),
  item('Internet', 'p5', 480),
  item('Insurance', 'p6', 720),
  item('Water', 'p7', 120),
  item('Spotify', 'p8', 60),
  item('Parking', 'p9', 150),
  item('Corner store', null, 75),
];

function respond(data: ReturnType<typeof item>[], monthlyEstimate = 15) {
  getRecurringExpenses.mockResolvedValue({
    data,
    summary: { totalRecurring: monthlyEstimate * 6, monthlyEstimate, monthCount: 6, uniquePayees: data.length },
  });
}

/**
 * A ResizeObserver that reports the given content box as soon as it observes,
 * and returns a function that reports a new one later.
 */
function observeAs(width: number, height: number) {
  const callbacks: Array<(width: number, height: number) => void> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        const report = (w: number, h: number) =>
          this.callback(
            [{ contentRect: { width: w, height: h } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        callbacks.push(report);
        report(width, height);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  return (w: number, h: number) => callbacks.forEach((report) => report(w, h));
}

function expectBoxesInside(boxes: HTMLElement[], width: number, height: number) {
  for (const box of boxes) {
    const left = parseFloat(box.style.left);
    const top = parseFloat(box.style.top);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + parseFloat(box.style.width)).toBeLessThanOrEqual(width);
    expect(top + parseFloat(box.style.height)).toBeLessThanOrEqual(height);
  }
}

async function renderWidget() {
  await act(async () => {
    render(<RecurringExpensesWidget isLoading={false} />);
  });
}

describe('RecurringExpensesWidget', () => {
  beforeEach(() => {
    getRecurringExpenses.mockReset();
    updateConfig.mockReset();
    push.mockReset();
    configState.current = { minOccurrences: 3, range: '6m', view: 'callouts' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches with the configured minimum occurrences and range and renders the estimate', async () => {
    respond([item('Netflix', 'p1', 90)]);
    await renderWidget();
    expect(screen.getByText('Top Recurring Expenses')).toBeInTheDocument();
    expect(getRecurringExpenses).toHaveBeenCalledWith(3, '6m');
    expect(screen.getByText('$15')).toBeInTheDocument();
    // The header names the window.
    expect(screen.getByText('6M')).toBeInTheDocument();
  });

  it('puts the monthly estimate in the donut, in either view', async () => {
    for (const view of ['callouts', 'legend'] as const) {
      configState.current = { minOccurrences: 3, range: '6m', view };
      respond(TEN_PAYEES, 42);
      let unmount = () => {};
      await act(async () => {
        ({ unmount } = render(<RecurringExpensesWidget isLoading={false} />));
      });
      const area = screen.getByTestId('donut-chart-area');
      expect(within(area).getByText('Monthly estimate')).toBeInTheDocument();
      expect(within(area).getByText('$42')).toBeInTheDocument();
      unmount();
    }
  });

  it('bounds the estimate by the hole it sits in', async () => {
    observeAs(520, 280);
    respond(TEN_PAYEES, 42);
    await renderWidget();
    const caption = within(screen.getByTestId('donut-chart-area')).getByText('Monthly estimate');
    const maxWidth = parseFloat((caption.parentElement as HTMLElement).style.maxWidth);
    // Inside the hole of the smallest donut a centre figure asks for, and
    // wide enough for a compact figure and its marker.
    expect(maxWidth).toBeLessThanOrEqual(2 * 96 * 0.55);
    expect(maxWidth).toBeGreaterThanOrEqual(90);
  });

  it('writes the estimate in compact notation in the callout view only', async () => {
    observeAs(520, 280);
    respond(TEN_PAYEES, 123456);
    await renderWidget();
    const area = screen.getByTestId('donut-chart-area');
    expect(within(area).getByText('$123.5K')).toBeInTheDocument();
    expect(within(area).queryByText('$123456')).not.toBeInTheDocument();
  });

  it('writes the estimate in full in the legend view', async () => {
    configState.current = { minOccurrences: 3, range: '6m', view: 'legend' };
    observeAs(520, 280);
    respond(TEN_PAYEES, 123456);
    await renderWidget();
    expect(within(screen.getByTestId('donut-chart-area')).getByText('$123456')).toBeInTheDocument();
  });

  it('links the title to the Recurring Expenses Tracker report', async () => {
    respond([item('Netflix', 'p1', 90)]);
    await renderWidget();
    expect(screen.getByRole('link', { name: 'Top Recurring Expenses' })).toHaveAttribute(
      'href',
      '/reports/recurring-expenses',
    );
  });

  it('asks for the configured range', async () => {
    configState.current = { minOccurrences: 4, range: '5y', view: 'legend' };
    respond([item('Netflix', 'p1', 90)]);
    await renderWidget();
    expect(getRecurringExpenses).toHaveBeenCalledWith(4, '5y');
    expect(screen.getByText('5Y')).toBeInTheDocument();
  });

  it('shows the empty state with no recurring expenses', async () => {
    respond([], 0);
    await renderWidget();
    expect(screen.getByText('No recurring expenses found.')).toBeInTheDocument();
  });

  describe('legend view', () => {
    beforeEach(() => {
      configState.current = { minOccurrences: 3, range: '6m', view: 'legend' };
    });

    it('lists the top ten payees with their totals under the chart', async () => {
      respond([...TEN_PAYEES, item('Eleventh', 'p11', 10)]);
      await renderWidget();
      expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Hydro/ })).toHaveTextContent('$900');
      expect(screen.getByText('Corner store')).toBeInTheDocument();
      expect(screen.queryByText('Eleventh')).not.toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Top Recurring Expenses' })).not.toBeInTheDocument();
    });

    it('opens the payee transactions from a legend row', async () => {
      respond(TEN_PAYEES);
      await renderWidget();
      fireEvent.click(screen.getByRole('button', { name: /Gym/ }));
      expect(push).toHaveBeenCalledWith('/transactions?payeeId=p3');
    });

    it('keeps a payee without an id inert', async () => {
      respond(TEN_PAYEES);
      await renderWidget();
      expect(screen.getByRole('button', { name: /Corner store/ })).toBeDisabled();
    });
  });

  describe('callout view', () => {
    it('draws a box per payee beside the chart when they fit', async () => {
      observeAs(520, 280);
      respond(TEN_PAYEES);
      await renderWidget();

      const callouts = screen.getByRole('list', { name: 'Top Recurring Expenses' });
      const boxes = within(callouts).getAllByRole('listitem');
      expect(boxes).toHaveLength(10);
      expect(within(callouts).getByText('Hydro')).toBeInTheDocument();
      expect(within(callouts).getByText('$900')).toBeInTheDocument();
      // Every box sits inside the measured area.
      expectBoxesInside(boxes, 520, 280);
      // No legend beneath it.
      expect(screen.queryByTestId('responsive-container')).not.toBeInTheDocument();
    });

    it('lays the boxes out again when the area shrinks', async () => {
      const resize = observeAs(640, 360);
      respond(TEN_PAYEES);
      await renderWidget();
      // The sized chart is out of the flow, so it cannot hold the area open.
      expect(screen.getByTestId('donut-chart-plot')).toHaveClass('absolute', 'inset-0');

      act(() => resize(520, 260));

      const callouts = screen.getByRole('list', { name: 'Top Recurring Expenses' });
      expectBoxesInside(within(callouts).getAllByRole('listitem'), 520, 260);
    });

    it('opens the payee transactions from a box', async () => {
      observeAs(520, 280);
      respond(TEN_PAYEES);
      await renderWidget();
      const callouts = screen.getByRole('list', { name: 'Top Recurring Expenses' });
      fireEvent.click(within(callouts).getByRole('button', { name: /Netflix/ }));
      expect(push).toHaveBeenCalledWith('/transactions?payeeId=p2');
      // A payee without an id is a plain box.
      expect(within(callouts).queryByRole('button', { name: /Corner store/ })).not.toBeInTheDocument();
    });

    it('falls back to the legend where the boxes would not fit', async () => {
      observeAs(280, 280);
      respond(TEN_PAYEES);
      await renderWidget();
      expect(screen.queryByRole('list', { name: 'Top Recurring Expenses' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Hydro/ })).toHaveTextContent('$900');
    });

    it('shows neither boxes nor a legend before the area is measured', async () => {
      respond(TEN_PAYEES);
      await renderWidget();
      expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
      expect(screen.queryByText('Hydro')).not.toBeInTheDocument();
    });
  });

  describe('settings', () => {
    async function openSettings() {
      respond([item('Netflix', 'p1', 90)]);
      await renderWidget();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Configure Top Recurring Expenses' }));
      });
    }

    it('offers the 6M to All ranges and stores the one chosen', async () => {
      await openSettings();
      for (const label of ['6M', '1Y', '2Y', '5Y', 'All']) {
        expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0);
      }
      fireEvent.click(screen.getByRole('button', { name: '2Y' }));
      expect(updateConfig).toHaveBeenCalledWith({ range: '2y' });
    });

    it('switches between labels and legend', async () => {
      await openSettings();
      expect(screen.getByText("Labels need a wider screen. Where they don't fit, the legend is shown.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Legend' }));
      expect(updateConfig).toHaveBeenCalledWith({ view: 'legend' });
    });
  });

  it('marks the monthly estimate a subtotal when a row was left out', async () => {
    getRecurringExpenses.mockResolvedValue({
      data: [item('Netflix', 'p1', 90)],
      summary: {
        totalRecurring: null,
        knownTotalRecurring: 50,
        monthlyEstimate: null,
        knownMonthlyEstimate: 50,
        monthCount: 6,
        uniquePayees: 1,
      },
      currency: 'CAD',
      missingCurrencies: ['JPY'],
      excludedCount: 1,
    });
    await renderWidget();
    const markers = screen.getAllByTestId('partial-total');
    expect(markers.length).toBeGreaterThan(0);
    markers.forEach((marker) => expect(marker).toHaveTextContent('$50'));
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });
});
