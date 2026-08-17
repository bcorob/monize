import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { PartialTotal } from './PartialTotal';

describe('PartialTotal', () => {
  it('renders the figure alone when nothing was excluded', () => {
    render(
      <PartialTotal
        total={{ value: 100, missingCurrencies: [], excludedCount: 0 }}
        displayCurrency="USD"
      >
        $100.00
      </PartialTotal>,
    );
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.queryByText('(partial total)')).not.toBeInTheDocument();
  });

  it('marks the figure and names the missing currencies', () => {
    render(
      <PartialTotal
        total={{ value: 100, missingCurrencies: ['GBP'], excludedCount: 1 }}
        displayCurrency="USD"
      >
        $100.00
      </PartialTotal>,
    );
    expect(screen.getByText('(partial total)')).toBeInTheDocument();
    // The tooltip is exposed via the trigger button's aria-label.
    const explanation = screen.getByRole('button').getAttribute('aria-label') ?? '';
    expect(explanation).toContain('GBP');
    expect(explanation).toContain('No rate');
  });

  it('marks a figure short by an unpriced component that carries no currency', () => {
    // An unpriced holding bumps excludedCount without a missing currency. Keying
    // the marker off missingCurrencies alone rendered this as a complete total.
    render(
      <PartialTotal
        total={{ value: 100, missingCurrencies: [], excludedCount: 2 }}
        displayCurrency="USD"
      >
        $100.00
      </PartialTotal>,
    );
    expect(screen.getByText('(partial total)')).toBeInTheDocument();
    const explanation = screen.getByRole('button').getAttribute('aria-label') ?? '';
    expect(explanation).toContain('could not be worked out');
    expect(explanation).not.toContain('No rate');
  });
});
