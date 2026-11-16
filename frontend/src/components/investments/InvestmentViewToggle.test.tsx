import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InvestmentViewToggle } from './InvestmentViewToggle';

function renderToggle(
  value: 'brokerage' | 'cash',
  onChange = vi.fn(),
) {
  render(
    <InvestmentViewToggle value={value} onChange={onChange} />,
  );
  return { onChange };
}

describe('InvestmentViewToggle', () => {
  it('offers both of an investment account ledgers', () => {
    renderToggle('brokerage');

    expect(screen.getByText('Brokerage')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  // The two call sites used to hardcode which half was active, so the styling
  // and the state could disagree. Here the state is the only input.
  it('marks the brokerage half as the selected one', () => {
    renderToggle('brokerage');

    expect(screen.getByText('Brokerage')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Cash')).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks the cash half as the selected one', () => {
    renderToggle('cash');

    expect(screen.getByText('Cash')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Brokerage')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('reports the ledger the user picked', () => {
    const { onChange } = renderToggle('brokerage');

    fireEvent.click(screen.getByText('Cash'));

    expect(onChange).toHaveBeenCalledWith('cash');
  });

  it('reports a click on the half already selected, so the caller decides', () => {
    const { onChange } = renderToggle('cash');

    fireEvent.click(screen.getByText('Cash'));

    expect(onChange).toHaveBeenCalledWith('cash');
  });
});
