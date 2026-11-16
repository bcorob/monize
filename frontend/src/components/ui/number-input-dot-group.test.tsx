import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, fireEvent, screen } from '@/test/render';
import { CurrencyInput } from './CurrencyInput';
import { NumericInput } from './NumericInput';

// A German user: the DOT is the grouping separator and the COMMA is the decimal
// (numberFormat 'de-DE'). This is the mirror of the Polish case and the locale
// family where a typed/pasted dot-decimal used to be inflated ~100x.
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ preferences: { numberFormat: 'de-DE', defaultCurrency: 'EUR' } }),
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

function CalcHarness() {
  const [value, setValue] = useState<number | undefined>(undefined);
  return (
    <>
      <CurrencyInput label="Amount" value={value} onChange={setValue} />
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

describe('number inputs under a dot-group locale (de)', () => {
  it('CurrencyInput reads a dot-decimal paste as a decimal, not 100x', () => {
    render(<CurrencyHarness />);
    const input = screen.getByLabelText('Amount');
    // The regression: "1200.99" (an en-formatted paste) must NOT become 120099.
    fireEvent.change(input, { target: { value: '1200.99' } });
    expect(screen.getByTestId('value')).toHaveTextContent('1200.99');
    fireEvent.blur(input);
    // Display round-trips in the de convention (comma decimal, dot group).
    expect((input as HTMLInputElement).value).toBe('1.200,99');
  });

  it('CurrencyInput still reads the native comma-decimal form', () => {
    render(<CurrencyHarness />);
    const input = screen.getByLabelText('Amount');
    fireEvent.change(input, { target: { value: '1200,99' } });
    expect(screen.getByTestId('value')).toHaveTextContent('1200.99');
  });

  it('calculator evaluates a dot-decimal expression as a decimal, not 100x', () => {
    render(<CalcHarness />);
    const input = screen.getByLabelText('Amount');
    // "100*1.13" must be 113, not 11300 -- the calculator agrees with the field.
    fireEvent.change(input, { target: { value: '100*1.13' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('value')).toHaveTextContent('113');
  });

  it('NumericInput reads a dot-decimal rate as 5.5, not 55', () => {
    render(<RateHarness />);
    const input = screen.getByLabelText('Rate');
    fireEvent.change(input, { target: { value: '5.5' } });
    expect(screen.getByTestId('value')).toHaveTextContent('5.5');
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('5,50');
  });
});
