import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { ReportToolbarActions } from './ReportToolbarActions';

/**
 * The rule this component exists to hold: on a phone a report's refresh and
 * export are one row of their own, below every selector, spanning the card.
 * jsdom applies no media queries, so the phone layout is read off the classes
 * -- the base (unprefixed) ones are the phone's, the `sm:` ones the desktop's.
 */

vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({ isRefreshing: false, triggerManualRefresh: vi.fn() }),
}));

const row = (container: HTMLElement) => container.firstElementChild!;

describe('ReportToolbarActions', () => {
  it('gives a lone export the whole row on a phone', () => {
    const { container } = render(<ReportToolbarActions onExportPdf={vi.fn()} />);

    expect(row(container).className).toContain('w-full');
    expect(row(container).className).toContain('grid-cols-1');
    // The export's own box is stretched by the cell, and the button fills it:
    // the CSV form renders an inline-block wrapper that would otherwise be as
    // wide as its text.
    const button = screen.getByTitle('Export PDF');
    expect(button.className).toContain('w-full');
    expect(button.className).toContain('whitespace-nowrap');
  });

  it('splits the row in two when the report also refreshes prices', () => {
    const { container } = render(
      <ReportToolbarActions onExportPdf={vi.fn()} onRefreshComplete={vi.fn()} />,
    );

    expect(row(container).className).toContain('grid-cols-2');
    expect(row(container).className).toContain('w-full');
    // Both halves, and both filling their half.
    const refresh = screen.getByTitle('Refresh security prices');
    expect(refresh.className).toContain('w-full');
    expect(screen.getByTitle('Export PDF').className).toContain('w-full');
  });

  it('goes back to the toolbar’s trailing group from sm up', () => {
    const { container } = render(
      <ReportToolbarActions onExportPdf={vi.fn()} onRefreshComplete={vi.fn()} />,
    );

    const className = row(container).className;
    expect(className).toContain('sm:ml-auto');
    expect(className).toContain('sm:flex');
    expect(className).toContain('sm:w-auto');
    // A button on one line with a picker is the height of the picker.
    expect(className).toContain('sm:self-stretch');
    expect(screen.getByTitle('Export PDF').className).toContain('h-full');
  });

  it('offers CSV only when the view has something tabular to write', () => {
    const { rerender } = render(<ReportToolbarActions onExportPdf={vi.fn()} />);
    // PDF-only: one button, no menu.
    expect(screen.getByTitle('Export PDF')).toBeInTheDocument();

    rerender(
      <ReportToolbarActions onExportPdf={vi.fn()} onExportCsv={vi.fn()} />,
    );
    expect(screen.getByTitle('Export report')).toBeInTheDocument();
  });

  it('takes a CSV-only report, whose view has no picture to export', () => {
    const { container } = render(<ReportToolbarActions onExportCsv={vi.fn()} />);

    // Same row, same phone rule: one button spanning it.
    expect(row(container).className).toContain('grid-cols-1');
    expect(row(container).className).toContain('w-full');
    const button = screen.getByTitle('Export CSV');
    expect(button.className).toContain('w-full');
    expect(button.className).toContain('whitespace-nowrap');
    expect(screen.queryByTitle('Export PDF')).not.toBeInTheDocument();
  });

  it('lets a caller opt out of stretching on a taller toolbar line', () => {
    const { container } = render(
      <ReportToolbarActions onExportPdf={vi.fn()} className="sm:self-auto" />,
    );
    // twMerge keeps the caller's value, not both.
    expect(row(container).className).toContain('sm:self-auto');
    expect(row(container).className).not.toContain('sm:self-stretch');
  });
});
