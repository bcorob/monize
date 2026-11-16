import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { SimulatorUnavailableNotice } from './SimulatorUnavailableNotice';

describe('SimulatorUnavailableNotice', () => {
  it.each([
    ['no-amortization', /no amortization period/],
    ['no-payment-start', /no first payment date/],
    ['no-principal', /no original amount/],
    ['no-payment', /installment amount cannot be determined/],
  ] as const)('names the missing term for %s', (reason, text) => {
    render(<SimulatorUnavailableNotice reason={reason} />);
    expect(
      screen.getByText('The overpayment simulation cannot be calculated for this loan yet.'),
    ).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
