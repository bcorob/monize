import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ChartCollapseButton, CollapsedChartStrip } from './ChartCollapseControls';

describe('ChartCollapseButton', () => {
  it('names what it does and folds on click', () => {
    const onCollapse = vi.fn();
    render(<ChartCollapseButton onCollapse={onCollapse} />);

    const button = screen.getByRole('button', { name: 'Hide chart' });
    expect(button).toHaveAttribute('title', 'Hide chart');
    fireEvent.click(button);

    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

describe('CollapsedChartStrip', () => {
  it('says the chart is hidden and restores it from one click anywhere on it', () => {
    const onExpand = vi.fn();
    render(<CollapsedChartStrip onExpand={onExpand} />);

    const strip = screen.getByRole('button', { name: 'Show chart' });
    expect(strip).toHaveAttribute('aria-expanded', 'false');
    expect(strip).toHaveTextContent('Chart hidden');
    fireEvent.click(screen.getByText('Chart hidden'));

    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
