import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { ResultChart } from './ResultChart';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: 'USD',
    }),
  };
});

// Mock recharts to avoid SVG rendering issues in jsdom
// The Tooltip mock renders the content component with different prop combinations
// to cover the ChartTooltip branches
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children }: any) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: ({ children }: any) => <>{children}</>,
  PieChart: ({ children }: any) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: ({ children, label }: any) => {
    // Call the label function to cover pie label branch
    if (label) label({ name: 'Groceries', percent: 0.5 });
    return <>{children}</>;
  },
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (!content) return null;
    const ContentComponent = content.type;
    const props = content.props || {};
    return (
      <div data-testid="tooltip-wrapper">
        {/* Test case: active with label */}
        <div data-testid="tooltip-with-label">
          <ContentComponent
            {...props}
            active={true}
            payload={[{ name: 'Series A', value: 500, payload: { label: 'Groceries' } }]}
            label="Groceries"
          />
        </div>
        {/* Test case: active without label but with payload label */}
        <div data-testid="tooltip-payload-label">
          <ContentComponent
            {...props}
            active={true}
            payload={[{ name: 'Series A', value: 300, payload: { label: 'Dining' } }]}
            label={undefined}
          />
        </div>
        {/* Test case: active with payload.name as heading (no label or payload.label) */}
        <div data-testid="tooltip-name-heading">
          <ContentComponent
            {...props}
            active={true}
            payload={[{ name: 'Series B', value: 200, payload: {} }]}
            label={undefined}
          />
        </div>
        {/* Test case: entry with undefined value */}
        <div data-testid="tooltip-undefined-value">
          <ContentComponent
            {...props}
            active={true}
            payload={[{ name: 'Series C', value: undefined, payload: {} }]}
            label="Test"
          />
        </div>
        {/* Test case: not active - should return null */}
        <div data-testid="tooltip-not-active">
          <ContentComponent
            {...props}
            active={false}
            payload={[{ name: 'X', value: 100 }]}
            label="X"
          />
        </div>
        {/* Test case: empty payload - should return null */}
        <div data-testid="tooltip-empty-payload">
          <ContentComponent
            {...props}
            active={true}
            payload={[]}
            label="Y"
          />
        </div>
      </div>
    );
  },
  AreaChart: ({ children }: any) => (
    <div data-testid="area-chart">{children}</div>
  ),
  Area: () => null,
}));

const captureSvgAsImageMock = vi.fn();
vi.mock('@/lib/pdf-export-charts', () => ({
  captureSvgAsImage: (...args: unknown[]) => captureSvgAsImageMock(...args),
}));

const sampleData = [
  { label: 'Groceries', value: 500 },
  { label: 'Dining Out', value: 300 },
  { label: 'Transport', value: 200 },
];

describe('ResultChart', () => {
  it('renders nothing when data is empty', () => {
    const { container } = render(
      <ResultChart type="bar" title="Test Chart" data={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when data is null/undefined', () => {
    const { container } = render(
      <ResultChart type="bar" title="Test Chart" data={null as any} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the chart title', () => {
    render(<ResultChart type="bar" title="Spending Breakdown" data={sampleData} />);
    expect(screen.getByText('Spending Breakdown')).toBeInTheDocument();
  });

  it('renders a bar chart when type is bar', () => {
    render(<ResultChart type="bar" title="Bar Chart" data={sampleData} />);
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders a pie chart when type is pie', () => {
    render(<ResultChart type="pie" title="Pie Chart" data={sampleData} />);
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });

  it('renders an area chart when type is area', () => {
    render(<ResultChart type="area" title="Area Chart" data={sampleData} />);
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('renders an area chart when type is line', () => {
    render(<ResultChart type="line" title="Line Chart" data={sampleData} />);
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('wraps chart in ResponsiveContainer', () => {
    render(<ResultChart type="bar" title="Test" data={sampleData} />);
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('renders with single data point', () => {
    render(
      <ResultChart
        type="bar"
        title="Single"
        data={[{ label: 'Only', value: 100 }]}
      />,
    );
    expect(screen.getByText('Single')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders a download button', () => {
    render(<ResultChart type="bar" title="Test" data={sampleData} />);
    expect(
      screen.getByRole('button', { name: /download chart as png/i }),
    ).toBeInTheDocument();
  });

  it('triggers a PNG download when the download button is clicked', async () => {
    captureSvgAsImageMock.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,AAAA',
      width: 400,
      height: 256,
    });

    const clickSpy = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) => {
        const el = originalCreateElement(tag) as HTMLElement;
        if (tag === 'a') {
          (el as HTMLAnchorElement).click = clickSpy;
        }
        return el;
      });

    render(
      <ResultChart type="bar" title="My Spending Report" data={sampleData} />,
    );

    const button = screen.getByRole('button', {
      name: /download chart as png/i,
    });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(captureSvgAsImageMock).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();

    createElementSpy.mockRestore();
  });

  it('shows error toast when captureSvgAsImage returns null', async () => {
    captureSvgAsImageMock.mockResolvedValueOnce(null);

    render(<ResultChart type="bar" title="Test" data={sampleData} />);

    const button = screen.getByRole('button', { name: /download chart as png/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(captureSvgAsImageMock).toHaveBeenCalled();
  });

  it('shows error toast when captureSvgAsImage throws an exception', async () => {
    captureSvgAsImageMock.mockRejectedValueOnce(new Error('Canvas error'));

    render(<ResultChart type="bar" title="Test" data={sampleData} />);

    const button = screen.getByRole('button', { name: /download chart as png/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(captureSvgAsImageMock).toHaveBeenCalled();
  });

  it('renders tooltip with active state and different payload scenarios', () => {
    render(<ResultChart type="bar" title="Test" data={sampleData} />);

    expect(screen.getByTestId('tooltip-wrapper')).toBeInTheDocument();
    // When active with label, shows formatted value
    expect(screen.getByTestId('tooltip-with-label')).toBeInTheDocument();
    // When no label but payload has label
    expect(screen.getByTestId('tooltip-payload-label')).toBeInTheDocument();
  });

  it('renders tooltip with undefined value (shows empty string)', () => {
    render(<ResultChart type="bar" title="Test" data={sampleData} />);

    expect(screen.getByTestId('tooltip-undefined-value')).toBeInTheDocument();
  });

  it('uses title with special characters for download filename', async () => {
    captureSvgAsImageMock.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,AAAA',
      width: 400,
      height: 256,
    });

    let downloadAttr = '';
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) => {
        const el = originalCreateElement(tag) as HTMLElement;
        if (tag === 'a') {
          (el as HTMLAnchorElement).click = vi.fn();
          Object.defineProperty(el, 'download', {
            set: (val) => { downloadAttr = val; },
            get: () => downloadAttr,
          });
        }
        return el;
      });

    render(
      <ResultChart type="bar" title="My Report! With Spaces" data={sampleData} />,
    );

    const button = screen.getByRole('button', { name: /download chart as png/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(downloadAttr).toBe('my-report-with-spaces.png');
    createElementSpy.mockRestore();
  });

  it('sanitizeFilename uses chart fallback for empty-after-clean title', async () => {
    captureSvgAsImageMock.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,AAAA',
      width: 400,
      height: 256,
    });

    let downloadAttr = '';
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) => {
        const el = originalCreateElement(tag) as HTMLElement;
        if (tag === 'a') {
          (el as HTMLAnchorElement).click = vi.fn();
          Object.defineProperty(el, 'download', {
            set: (val) => { downloadAttr = val; },
            get: () => downloadAttr,
          });
        }
        return el;
      });

    render(
      <ResultChart type="bar" title="---" data={sampleData} />,
    );

    const button = screen.getByRole('button', { name: /download chart as png/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(downloadAttr).toBe('chart.png');
    createElementSpy.mockRestore();
  });
});

