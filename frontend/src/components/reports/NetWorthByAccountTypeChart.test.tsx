import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { NetWorthByAccountTypeChart, type NetWorthByAccountTypePoint } from './NetWorthByAccountTypeChart';

const tooltipPoint = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  ComposedChart: ({ children }: any) => <div data-testid="composed-chart">{children}</div>,
  Bar: ({ name, fill, dataKey }: any) => (
    <div
      data-testid="bar"
      data-name={name}
      data-fill={fill}
      data-key={typeof dataKey === 'string' ? dataKey : 'fn'}
    />
  ),
  Line: ({ children, name, legendType }: any) => (
    <div data-testid="line" data-name={name ?? ''} data-legend={legendType ?? ''}>{children}</div>
  ),
  LabelList: ({ formatter, angle }: any) => (
    <div data-testid="label-list" data-angle={angle}>{String(formatter(1234))}</div>
  ),
  Legend: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  XAxis: () => null,
  YAxis: ({ hide }: any) => <div data-testid="y-axis" data-hide={String(!!hide)} />,
  // Render the custom tooltip for one hovered month.
  Tooltip: ({ content }: any) =>
    tooltipPoint.current
      ? (content.type as any)({ ...content.props, active: true, payload: [{ payload: tooltipPoint.current }] })
      : null,
}));

const formatCurrency = (n: number) => `$${n}`;

const months: NetWorthByAccountTypePoint[] = [
  {
    key: '2024-01-01',
    name: 'Jan 2024',
    netWorth: 60000,
    byAccountType: { CHEQUING: 5000, INVESTMENT: 205000, MORTGAGE: -150000 },
  },
  {
    key: '2024-02-01',
    name: 'Feb 2024',
    netWorth: 70000,
    byAccountType: { CHEQUING: 4000, CREDIT_CARD: -1000, INVESTMENT: 217000, MORTGAGE: -150000 },
  },
];

function renderChart(props: Partial<Parameters<typeof NetWorthByAccountTypeChart>[0]> = {}) {
  return render(
    <NetWorthByAccountTypeChart
      data={months}
      formatCurrency={formatCurrency}
      formatXTick={(key) => key}
      {...props}
    />,
  );
}

describe('NetWorthByAccountTypeChart', () => {
  it('draws one stacked series per account type held, each in its own colour', () => {
    tooltipPoint.current = null;
    renderChart();
    const bars = screen.getAllByTestId('bar');
    expect(bars.map((bar) => bar.getAttribute('data-name'))).toEqual([
      'Chequing',
      'Investment',
      'Credit Card',
      'Mortgage',
    ]);
    expect(new Set(bars.map((bar) => bar.getAttribute('data-fill'))).size).toBe(4);
    // Net worth is the line across them, named in the legend.
    expect(screen.getByTestId('line')).toHaveAttribute('data-name', 'Net Worth');
  });

  it('lists what each account type contributes to the hovered month, and its net worth', () => {
    tooltipPoint.current = months[1];
    renderChart();
    expect(screen.getByText('Feb 2024')).toBeInTheDocument();
    expect(screen.getByText('Chequing').nextSibling).toHaveTextContent('$4000');
    expect(screen.getByText('Credit Card').nextSibling).toHaveTextContent('$-1000');
    expect(screen.getByText('Investment').nextSibling).toHaveTextContent('$217000');
    expect(screen.getByText('Mortgage').nextSibling).toHaveTextContent('$-150000');
    expect(screen.getByText('Net Worth').nextSibling).toHaveTextContent('$70000');
  });

  it('leaves a type the hovered month does not hold out of its tooltip', () => {
    tooltipPoint.current = months[0];
    renderChart();
    expect(screen.queryByText('Credit Card')).not.toBeInTheDocument();
  });

  it('draws no series for an account type that is zero in every month', () => {
    tooltipPoint.current = null;
    renderChart({
      data: months.map((month) => ({
        ...month,
        byAccountType: { ...month.byAccountType, SAVINGS: 0 },
      })),
    });
    expect(screen.getAllByTestId('bar').map((bar) => bar.getAttribute('data-name'))).not.toContain('Savings');
  });

  it('leaves a type at zero in the hovered month out of its tooltip', () => {
    tooltipPoint.current = { ...months[1], byAccountType: { ...months[1].byAccountType, CREDIT_CARD: 0 } };
    renderChart();
    expect(screen.queryByText('Credit Card')).not.toBeInTheDocument();
    expect(screen.getByText('Mortgage')).toBeInTheDocument();
  });

  it('draws one solid net worth bar a month in the net worth style, breakdown or not', () => {
    tooltipPoint.current = months[1];
    renderChart({ barStyle: 'netWorth' });
    const bars = screen.getAllByTestId('bar');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute('data-key', 'netWorth');
    expect(screen.queryByTestId('line')).not.toBeInTheDocument();
    // Its tooltip is the month's net worth alone.
    expect(screen.queryByText('Chequing')).not.toBeInTheDocument();
    expect(screen.getByText('Net Worth').nextSibling).toHaveTextContent('$70000');
  });

  it('draws net worth alone when the response carries no breakdown', () => {
    tooltipPoint.current = null;
    renderChart({ data: months.map(({ byAccountType: _omit, ...rest }) => rest) });
    const bars = screen.getAllByTestId('bar');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute('data-key', 'netWorth');
    expect(screen.queryByTestId('line')).not.toBeInTheDocument();
  });

  it('prints net worth above each bar only when asked, upright or rotated', () => {
    tooltipPoint.current = null;
    const { unmount } = renderChart();
    expect(screen.queryByTestId('label-list')).not.toBeInTheDocument();
    unmount();

    renderChart({ valueLabels: 'vertical', formatValueLabel: (n) => `~${n}` });
    expect(screen.getByTestId('label-list')).toHaveAttribute('data-angle', '-90');
    expect(screen.getByTestId('label-list')).toHaveTextContent('~1234');
    // The label carrier stays out of the legend.
    expect(screen.getAllByTestId('line').at(-1)).toHaveAttribute('data-legend', 'none');
  });

  it('shows a y-axis only when given its labels', () => {
    tooltipPoint.current = null;
    const { unmount } = renderChart();
    expect(screen.getByTestId('y-axis')).toHaveAttribute('data-hide', 'true');
    unmount();
    renderChart({ formatYTick: (n) => String(n) });
    expect(screen.getByTestId('y-axis')).toHaveAttribute('data-hide', 'false');
  });

  it('says why a withheld month has no figure instead of printing a zero', () => {
    tooltipPoint.current = { key: '2024-03-01', name: 'Mar 2024', netWorth: null };
    renderChart({ data: [...months, tooltipPoint.current as NetWorthByAccountTypePoint] });
    expect(screen.getByText('Mar 2024')).toBeInTheDocument();
    expect(screen.getByText(/Not shown/)).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('Net Worth')).not.toBeInTheDocument();
  });
});
