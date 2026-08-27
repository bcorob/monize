import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { UnknownAmount } from './UnknownAmount';

/**
 * The marker for a money figure the server could not work out (issue #1247).
 *
 * The two wrong renderings are a stale number and a measured-looking zero, so the
 * assertions here are about what a reader (and a screen reader) actually gets:
 * a visible glyph, a reason, and no digits.
 */
describe('UnknownAmount', () => {
  it('renders a marker with an accessible label and a reason', () => {
    render(<UnknownAmount />);

    const marker = screen.getByTestId('unknown-amount');
    expect(marker).toBeInTheDocument();
    // Assistive technology gets words, not the glyph.
    expect(screen.getByText('Amount not available')).toBeInTheDocument();
    // And the reason is available, not just "unavailable". `InfoTooltip` exposes
    // its body through the trigger's aria-label (its popover is hover-only), so
    // that is where a reader finds WHY the figure is missing.
    expect(
      screen.getByLabelText(/no exchange rate is available/i),
    ).toBeInTheDocument();
  });

  it('shows no digits, so it cannot read as a measured figure', () => {
    render(<UnknownAmount />);

    const marker = screen.getByTestId('unknown-amount');
    // The explanation names no amount either, so nothing in the cell looks like
    // a number the reader could act on.
    expect(marker.textContent).not.toMatch(/\d/);
  });

  it('keeps its glyph out of the accessibility tree', () => {
    render(<UnknownAmount />);

    const hidden = screen
      .getByTestId('unknown-amount')
      .querySelector('[aria-hidden="true"]');
    expect(hidden).not.toBeNull();
    // The em dash is the visible marker; the sr-only label carries the meaning.
    expect(hidden!.textContent).toBe('—');
  });

  it('accepts a className so a table cell keeps its alignment', () => {
    render(<UnknownAmount className="justify-end" />);

    expect(screen.getByTestId('unknown-amount').className).toContain(
      'justify-end',
    );
  });
});
