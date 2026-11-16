import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, fireEvent, screen } from '@/test/render';
import { CurrencyInput } from './CurrencyInput';
import { NumericInput } from './NumericInput';

// A Polish user: comma is the decimal separator (numberFormat 'pl').
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ preferences: { numberFormat: 'pl', defaultCurrency: 'PLN' } }),
}));

function CurrencyHarness() {
  const [value, setValue] = useState<number | undefined>(undefined);
  return (
    <>
      <CurrencyInput label="Amount" value={value} onChange={setValue} allowCalculator={false} />
      <output data-testid="value">{value === undefined ? 'undefined' : String(value)}</output>
    </>
  );
}

function RateHarness() {
  const [value, setValue] = useState<number | undefined>(undefined);
  return (
    <>
      <NumericInput label="Rate" value={value} onChange={setValue} decimalPlaces={2} />
      <output data-testid="value">{value === undefined ? 'undefined' : String(value)}</output>
    </>
  );
}

describe('number inputs under a comma-decimal locale', () => {
  it('CurrencyInput accepts a pasted comma amount and shows it with a comma', () => {
    render(<CurrencyHarness />);
    const input = screen.getByLabelText('Amount');
    // The reported case: a value copied from a localized column.
    fireEvent.change(input, { target: { value: '1200,99' } });
    expect(screen.getByTestId('value')).toHaveTextContent('1200.99');
    fireEvent.blur(input);
    // Display round-trips in the locale (comma decimal).
    expect((input as HTMLInputElement).value).toContain(',99');
  });

  it('NumericInput accepts a comma rate like the interest-rate field', () => {
    render(<RateHarness />);
    const input = screen.getByLabelText('Rate');
    fireEvent.change(input, { target: { value: '5,5' } });
    expect(screen.getByTestId('value')).toHaveTextContent('5.5');
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('5,50');
  });

  it('still accepts a dot decimal (robustness) for the same user', () => {
    render(<RateHarness />);
    const input = screen.getByLabelText('Rate');
    fireEvent.change(input, { target: { value: '5.5' } });
    expect(screen.getByTestId('value')).toHaveTextContent('5.5');
  });
});
