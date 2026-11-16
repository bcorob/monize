import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { PartialDataNotice } from './PartialDataNotice';

describe('PartialDataNotice', () => {
  it('renders nothing when nothing was excluded', () => {
    render(<PartialDataNotice missingCurrencies={[]} excludedCount={0} displayCurrency="USD" />);
    expect(screen.queryByTestId('partial-data-notice')).not.toBeInTheDocument();
  });

  it('names the missing currencies and the display currency', () => {
    render(<PartialDataNotice missingCurrencies={['JPY']} excludedCount={2} displayCurrency="USD" />);
    const note = screen.getByTestId('partial-data-notice');
    expect(note).toHaveTextContent('JPY');
    expect(note).toHaveTextContent('USD');
  });

  it('does not invent a currency when the cause carries none', () => {
    render(<PartialDataNotice missingCurrencies={[]} excludedCount={1} displayCurrency="USD" />);
    expect(screen.getByTestId('partial-data-notice')).not.toHaveTextContent('No rate');
  });
});
