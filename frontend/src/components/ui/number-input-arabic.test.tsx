import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, fireEvent, screen } from '@/test/render';
import { CurrencyInput } from './CurrencyInput';
import { NumericInput } from './NumericInput';

// Egyptian Arabic, as reached through the "Browser" number-format setting on an
// ar-EG browser: Intl renders native Arabic-Indic digits with U+066B / U+066C
// separators. The editable fields must work in the latn form and still accept a
// native paste -- an ASCII-only pipeline collapsed "١٢٠٠٫٩٩" + "5" to 5 and
// turned the calculator's "1200٫995" into 1200995.
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ preferences: { numberFormat: 'ar-EG', defaultCurrency: 'EGP' } }),
}));

const NATIVE_1200_99 = '١٬٢٠٠٫٩٩'; // ١٬٢٠٠٫٩٩

function CurrencyHarness({ initial }: { initial: number | undefined }) {
  const [value, setValue] = useState<number | undefined>(initial);
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

describe('number inputs under a non-Latin browser numbering system (ar-EG)', () => {
  it('CurrencyInput shows the value in latn digits and edits it without collapsing', () => {
    render(<CurrencyHarness initial={1200.99} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    expect(input.value).toBe('1,200.99');
    fireEvent.focus(input);
    expect(input.value).toBe('1200.99');
    // The audit scenario: append one digit to the existing value.
    fireEvent.change(input, { target: { value: '1200.996' } });
    expect(screen.getByTestId('value')).toHaveTextContent('1201'); // cents, not 5 and not 1200996
    fireEvent.blur(input);
    expect(input.value).toBe('1,201.00');
  });

  it('CurrencyInput accepts a native-digit paste from a read-only column', () => {
    render(<CurrencyHarness initial={undefined} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.change(input, { target: { value: NATIVE_1200_99 } });
    expect(screen.getByTestId('value')).toHaveTextContent('1200.99');
  });

  it('calculator evaluates a native-separator expression as a decimal, not x1000', () => {
    render(<CurrencyHarness initial={undefined} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.change(input, { target: { value: '1200٫99+0.01' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('value')).toHaveTextContent('1201');
  });

  it('NumericInput keeps decimal magnitude for latn and native input', () => {
    render(<RateHarness />);
    const input = screen.getByLabelText('Rate') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5.5' } });
    expect(screen.getByTestId('value')).toHaveTextContent('5.5');
    fireEvent.change(input, { target: { value: '٥٫٥' } }); // ٥٫٥
    expect(screen.getByTestId('value')).toHaveTextContent('5.5');
    fireEvent.blur(input);
    expect(input.value).toBe('5.50');
  });
});
