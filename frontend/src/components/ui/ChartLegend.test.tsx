import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ChartLegend, ChartLegendItem } from './ChartLegend';
import { HOVER_ROW_ON_CARD } from './Card';

/**
 * The legend beside a categorical chart. The one behaviour that matters on a
 * phone is that it stacks into a SINGLE vertical column below `sm` and only
 * widens from `sm` up -- a two- or three-column legend on a 320px screen was
 * the cramped layout this component replaces.
 */

const ITEMS: ChartLegendItem[] = [
  { key: 'a', name: 'Groceries', color: '#ef4444', detail: '$120 (40%)' },
  { key: 'b', name: 'Transport', color: '#3b82f6', detail: '$90 (30%)' },
];

describe('ChartLegend', () => {
  it('is one vertical column on a phone and widens only from sm up', () => {
    const { container } = render(<ChartLegend items={ITEMS} />);
    const list = container.querySelector('ul')!;
    // Mobile is a single column; the multi-column classes are all `sm:`/`lg:`
    // prefixed so nothing widens the legend below the breakpoint.
    expect(list.className).toContain('grid-cols-1');
    expect(list.className).toContain('sm:grid-cols-2');
    for (const token of list.className.split(/\s+/)) {
      if (token.includes('grid-cols-') && !token.startsWith('grid-cols-1')) {
        expect(token).toMatch(/^(sm|md|lg|xl):/);
      }
    }
  });

  /**
   * Two columns on a phone is opt-in, per legend. A legend of short names (a
   * category legend of twenty rows) reads better halved than as a long scroll
   * past the chart; the default stays one column, because a name that has to
   * truncate loses its end silently.
   */
  it('gives a phone two columns when the caller asks for them', () => {
    const { container } = render(<ChartLegend items={ITEMS} phoneColumns={2} />);
    const list = container.querySelector('ul')!;
    expect(list.className).toContain('grid-cols-2');
    expect(list.className).not.toContain('grid-cols-1');
    // The larger breakpoints are still the caller's to set.
    expect(list.className).toContain('sm:grid-cols-2');
  });

  it('honours a caller-supplied column layout, still vertical on mobile', () => {
    const { container } = render(
      <ChartLegend items={ITEMS} columnsClassName="sm:grid-cols-2 md:grid-cols-4" />,
    );
    const list = container.querySelector('ul')!;
    expect(list.className).toContain('grid-cols-1');
    expect(list.className).toContain('md:grid-cols-4');
  });

  it('shows each name, its detail line and its swatch colour', () => {
    const { container } = render(<ChartLegend items={ITEMS} />);
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('$120 (40%)')).toBeInTheDocument();
    const swatches = container.querySelectorAll('li span[aria-hidden="true"]');
    expect((swatches[0] as HTMLElement).style.backgroundColor).toBe('rgb(239, 68, 68)');
  });

  it('renders a trailing figure at the row end', () => {
    render(
      <ChartLegend
        items={[{ key: 'a', name: 'US', color: '#000', trailing: '75.0%' }]}
      />,
    );
    expect(screen.getByText('75.0%')).toBeInTheDocument();
  });

  it('is a focusable button with a focus-visible ring when it navigates', () => {
    const onClick = vi.fn();
    render(
      <ChartLegend items={[{ key: 'a', name: 'Groceries', color: '#000', onClick }]} />,
    );
    const button = screen.getByRole('button', { name: /Groceries/ });
    expect(button.className).toContain('focus-visible:outline-2');
    expect(button.className).toContain('motion-reduce:transition-none');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps a disabled row a button so its name still reads', () => {
    render(
      <ChartLegend
        items={[{ key: 'a', name: 'Uncategorized', color: '#000', onClick: () => {}, disabled: true }]}
      />,
    );
    const button = screen.getByRole('button', { name: /Uncategorized/ });
    expect(button).toBeDisabled();
  });

  it('renders an inert row (no button) when there is no click handler', () => {
    render(<ChartLegend items={[{ key: 'a', name: 'Cash', color: '#000' }]} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('gives the interactive row a comfortable tap target (p-2)', () => {
    render(
      <ChartLegend items={[{ key: 'a', name: 'Groceries', color: '#000', onClick: () => {} }]} />,
    );
    const button = screen.getByRole('button', { name: /Groceries/ });
    expect(button.className).toContain('p-2');
    // The old ~24px target is gone.
    expect(button.className).not.toMatch(/(^|\s)p-1(\s|$)/);
  });

  it('takes its row hover from the shared HOVER_ROW_ON_CARD constant, not a hand-picked grey', () => {
    render(
      <ChartLegend items={[{ key: 'a', name: 'Groceries', color: '#000', onClick: () => {} }]} />,
    );
    const button = screen.getByRole('button', { name: /Groceries/ });
    for (const token of HOVER_ROW_ON_CARD.split(/\s+/)) {
      expect(button.className).toContain(token);
    }
    // The evade-the-guard hand-picked pair is gone.
    expect(button.className).not.toContain('enabled:hover:bg-gray-100');
    expect(button.className).not.toContain('dark:enabled:hover:bg-gray-700/50');
    // A disabled row does not light up on hover.
    expect(button.className).toContain('disabled:hover:bg-transparent');
    expect(button.className).toContain('dark:disabled:hover:bg-transparent');
  });

  it('does not truncate the money detail line (money must not clip)', () => {
    const { container } = render(
      <ChartLegend
        items={[{ key: 'a', name: 'Groceries', color: '#000', detail: '$1,234,567 (12.3%)' }]}
      />,
    );
    const detail = screen.getByText('$1,234,567 (12.3%)');
    expect(detail.className).not.toContain('truncate');
    // The name line may still clip a long category name.
    const name = screen.getByText('Groceries');
    expect(name.className).toContain('truncate');
    // Sanity: the detail sits inside the rendered legend.
    expect(container.contains(detail)).toBe(true);
  });
});
