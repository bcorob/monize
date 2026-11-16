import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { DateRangeSelector } from './DateRangeSelector';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'YYYY-MM-DD', datePattern: 'YYYY-MM-DD' }),
}));

describe('DateRangeSelector', () => {
  const ranges = ['1m', '3m', '6m', '1y'] as const;

  it('renders range buttons', () => {
    render(<DateRangeSelector ranges={ranges} value="3m" onChange={vi.fn()} />);
    expect(screen.getByText('1M')).toBeInTheDocument();
    expect(screen.getByText('3M')).toBeInTheDocument();
    expect(screen.getByText('6M')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
  });

  it('joins a toolbar row as its own items when asked to fill the row height', () => {
    const { container } = render(
      <DateRangeSelector ranges={ranges} value="custom" onChange={vi.fn()} showCustom fillRowHeight className="ignored" />,
    );
    const root = container.firstElementChild!;
    // `display: contents`: the presets are a flex item of the toolbar row, so
    // `items-stretch` gives them the row's height; the custom fields take a
    // line of their own.
    expect(root.className).toBe('contents');
    expect(screen.getByTestId('date-range-presets').className).toContain('flex');
    expect(root.lastElementChild!.className).toContain('w-full');
    expect(root.lastElementChild!.className).not.toContain('mt-4');
  });

  it('keeps its own box by default', () => {
    const { container } = render(
      <DateRangeSelector ranges={ranges} value="custom" onChange={vi.fn()} showCustom className="mine" />,
    );
    expect(container.firstElementChild!.className).toBe('mine');
    expect(container.firstElementChild!.lastElementChild!.className).toContain('mt-4');
  });

  it('calls onChange when button clicked', () => {
    const onChange = vi.fn();
    render(<DateRangeSelector ranges={ranges} value="3m" onChange={onChange} />);
    fireEvent.click(screen.getByText('6M'));
    expect(onChange).toHaveBeenCalledWith('6m');
  });

  it('formats ytd and all labels correctly', () => {
    render(<DateRangeSelector ranges={['ytd', 'all']} value="ytd" onChange={vi.fn()} />);
    expect(screen.getByText('YTD')).toBeInTheDocument();
    expect(screen.getByText('All Time')).toBeInTheDocument();
  });

  it('shows custom button when showCustom is true', () => {
    render(<DateRangeSelector ranges={ranges} value="1m" onChange={vi.fn()} showCustom />);
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('shows date inputs when custom is selected', () => {
    render(
      <DateRangeSelector
        ranges={ranges}
        value="custom"
        onChange={vi.fn()}
        showCustom
        customStartDate=""
        customEndDate=""
      />
    );
    expect(screen.getByText('Start Date')).toBeInTheDocument();
    expect(screen.getByText('End Date')).toBeInTheDocument();
  });

  it('hides date inputs when custom is not selected', () => {
    render(
      <DateRangeSelector ranges={ranges} value="3m" onChange={vi.fn()} showCustom />
    );
    expect(screen.queryByText('Start Date')).not.toBeInTheDocument();
  });

  it('calls onCustomStartDateChange when start date changes', () => {
    const onCustomStartDateChange = vi.fn();
    render(
      <DateRangeSelector
        ranges={ranges}
        value="custom"
        onChange={vi.fn()}
        showCustom
        customStartDate=""
        customEndDate=""
        onCustomStartDateChange={onCustomStartDateChange}
      />
    );
    const startInput = screen.getByLabelText('Start Date');
    fireEvent.change(startInput, { target: { value: '2025-06-01' } });
    expect(onCustomStartDateChange).toHaveBeenCalledWith('2025-06-01');
  });

  it('calls onCustomEndDateChange when end date changes', () => {
    const onCustomEndDateChange = vi.fn();
    render(
      <DateRangeSelector
        ranges={ranges}
        value="custom"
        onChange={vi.fn()}
        showCustom
        customStartDate=""
        customEndDate=""
        onCustomEndDateChange={onCustomEndDateChange}
      />
    );
    const endInput = screen.getByLabelText('End Date');
    fireEvent.change(endInput, { target: { value: '2025-12-31' } });
    expect(onCustomEndDateChange).toHaveBeenCalledWith('2025-12-31');
  });

  // `formatLabel` produces English ("All Time"), which is fine for the
  // abbreviation presets but not for a caller whose labels are words.
  it('prefers supplied labels over the built-in English ones', () => {
    render(
      <DateRangeSelector
        ranges={['year', 'all']}
        labels={{ year: '12 Monate', all: 'Gesamt' }}
        value="year"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: '12 Monate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gesamt' })).toBeInTheDocument();
    expect(screen.queryByText('All Time')).toBeNull();
  });

  it('falls back to the built-in label for a key the map omits', () => {
    render(
      <DateRangeSelector
        ranges={['3m', 'all']}
        labels={{ all: 'Everything' }}
        value="3m"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: '3M' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Everything' })).toBeInTheDocument();
  });
});
