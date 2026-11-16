import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { DonutCenterTotal } from './DonutCenterTotal';

/**
 * The aggregate that belongs in a donut's empty hole. It is an OVERLAY the
 * caller drops beside a `ResponsiveContainer` inside a `relative` box, so it
 * must position itself absolutely over the chart and let a hover pass through
 * to the slices beneath.
 */
describe('DonutCenterTotal', () => {
  it('shows the caption and the pre-formatted figure', () => {
    render(<DonutCenterTotal label="Total" value="$1,234.00" />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$1,234.00')).toBeInTheDocument();
  });

  it('overlays the chart and does not intercept the slice hover', () => {
    const { container } = render(<DonutCenterTotal label="Total" value="$0" />);
    const overlay = container.firstElementChild as HTMLElement;
    // Centred over the whole chart box.
    expect(overlay.className).toContain('absolute');
    expect(overlay.className).toContain('inset-0');
    expect(overlay.className).toContain('justify-center');
    // Pointer events pass through the hole to the slices; only the figure
    // itself re-enables them so a PartialTotal marker inside `value` is still
    // hoverable.
    expect(overlay.className).toContain('pointer-events-none');
    const figure = screen.getByText('$0');
    expect(figure.className).toContain('pointer-events-auto');
  });

  it('renders a node value (e.g. a PartialTotal wrapper), not only a string', () => {
    render(
      <DonutCenterTotal
        label="Total"
        value={<span data-testid="wrapped">$5.00</span>}
      />,
    );
    expect(screen.getByTestId('wrapped')).toBeInTheDocument();
  });

  it('never truncates the figure, so a PartialTotal marker inside it stays visible', () => {
    // A `PartialTotal` renders its subtotal beside a `*` marker and an info
    // trigger. `truncate` would clip that trailing marker -- the very signal
    // ("a subtotal is not a total") the repo insists stays on screen, and money
    // must never truncate either.
    render(
      <DonutCenterTotal
        label="Total"
        value={
          <span data-testid="partial">
            <span>$1,234,567.00</span>
            <button type="button" data-testid="marker">
              *
            </button>
          </span>
        }
      />,
    );
    const marker = screen.getByTestId('marker');
    expect(marker).toBeInTheDocument();

    // The figure's wrapping span (the pointer-events-auto element that holds the
    // value) must not truncate and must not be a full-width block: a full-width
    // figure would swallow slice hover across the whole hole.
    const figure = screen.getByTestId('partial').parentElement as HTMLElement;
    const figureTokens = figure.className.split(/\s+/);
    expect(figureTokens).toContain('pointer-events-auto');
    expect(figureTokens).not.toContain('truncate');
    // Not a full-width block (which would swallow slice hover across the hole);
    // `max-w-full` only bounds it, it does not claim the width.
    expect(figureTokens).not.toContain('w-full');

    // Nothing between the marker and that figure span may be a truncate box.
    let node: HTMLElement | null = marker;
    while (node && node !== figure.parentElement) {
      expect(node.className ?? '').not.toContain('truncate');
      node = node.parentElement;
    }
  });

  it('keeps the container inert (pointer-events-none) so slice hover passes through', () => {
    const { container } = render(<DonutCenterTotal label="Total" value="$0" />);
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.className).toContain('pointer-events-none');
  });
});
