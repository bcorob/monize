import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { MortgageTypeDetector } from './MortgageTypeDetector';
import { accountsApi } from '@/lib/accounts';
import type { MortgageTypeDetection } from '@/types/account';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    detectMortgageType: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const detect = vi.mocked(accountsApi.detectMortgageType);

function renderDetector(
  props: Partial<React.ComponentProps<typeof MortgageTypeDetector>> = {},
) {
  const onUse = vi.fn();
  render(
    <MortgageTypeDetector
      interestRate={2}
      paymentFrequency="MONTHLY"
      currencyCode="EUR"
      onUse={onUse}
      {...props}
    />,
  );
  return { onUse };
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Not sure? Enter a few installments' }));
}

function enterRow(index: number, principal: string, interest: string, balance?: string) {
  fireEvent.change(screen.getAllByLabelText('Principal')[index], { target: { value: principal } });
  fireEvent.change(screen.getAllByLabelText('Interest')[index], { target: { value: interest } });
  if (balance !== undefined) {
    fireEvent.change(screen.getAllByLabelText('Balance before (optional)')[index], {
      target: { value: balance },
    });
  }
}

async function suggest() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a Type' }));
  });
}

describe('MortgageTypeDetector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts collapsed behind the "Not sure?" control', () => {
    renderDetector();
    expect(screen.queryByLabelText('Principal')).not.toBeInTheDocument();
    open();
    expect(screen.getAllByLabelText('Principal')).toHaveLength(3);
    expect(screen.getAllByLabelText('Interest')).toHaveLength(3);
    expect(screen.getAllByLabelText('Balance before (optional)')).toHaveLength(3);
  });

  it('suggests LINEAR for the worked example and applies it only on "Use this type"', async () => {
    const answer: MortgageTypeDetection = {
      type: 'LINEAR',
      confidence: 'high',
      reason: 'CONSTANT_PRINCIPAL',
    };
    detect.mockResolvedValue(answer);
    const { onUse } = renderDetector();
    open();
    enterRow(0, '833.33', '500.00');
    enterRow(1, '833.33', '498.61');
    await suggest();

    // The figures go to the endpoint as typed, with the form's rate and
    // cadence; the suggestion is the server's, not the client's.
    expect(detect).toHaveBeenCalledWith({
      samples: [
        { principal: 833.33, interest: 500 },
        { principal: 833.33, interest: 498.61 },
      ],
      interestRate: 2,
      paymentFrequency: 'MONTHLY',
    });
    expect(screen.getByText('Suggested type: Linear (Constant Principal)')).toBeInTheDocument();
    expect(
      screen.getByText('The principal part is the same every time and the total falls.'),
    ).toBeInTheDocument();
    expect(onUse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Use This Type' }));
    expect(onUse).toHaveBeenCalledWith('LINEAR');
    // Accepting closes the panel.
    expect(screen.queryByLabelText('Principal')).not.toBeInTheDocument();
  });

  it('suggests ANNUITY for two equal totals and sends a balance when one is typed', async () => {
    detect.mockResolvedValue({
      type: 'ANNUITY',
      confidence: 'high',
      reason: 'CONSTANT_INSTALLMENT_NOMINAL',
    });
    renderDetector();
    open();
    enterRow(0, '608.86', '500.00', '300000');
    enterRow(1, '609.87', '498.99', '299391.14');
    await suggest();

    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: [
          { principal: 608.86, interest: 500, balanceBefore: 300000 },
          { principal: 609.87, interest: 498.99, balanceBefore: 299391.14 },
        ],
      }),
    );
    expect(screen.getByText('Suggested type: Annuity (Level Payment)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use This Type' })).toBeInTheDocument();
  });

  it('shows the refusal reason for a single row and offers nothing to use', async () => {
    detect.mockResolvedValue({ type: null, confidence: 'low', reason: 'TOO_FEW_SAMPLES' });
    const { onUse } = renderDetector();
    open();
    enterRow(0, '833.33', '500.00');
    await suggest();

    // The refusal is the server's: one sample is sent, not blocked here.
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ samples: [{ principal: 833.33, interest: 500 }] }),
    );
    expect(screen.getByText('No type suggested.')).toBeInTheDocument();
    expect(
      screen.getByText('At least two consecutive installments are needed to compare.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use This Type' })).not.toBeInTheDocument();
    expect(onUse).not.toHaveBeenCalled();
  });

  it('cautions on a low-confidence suggestion', async () => {
    detect.mockResolvedValue({
      type: 'ANNUITY',
      confidence: 'low',
      reason: 'CONSTANT_INSTALLMENT_RATE_UNCHECKED',
    });
    renderDetector({ interestRate: undefined });
    open();
    expect(
      screen.getByText('No interest rate is entered above, so the compounding cannot be checked.'),
    ).toBeInTheDocument();
    enterRow(0, '608.86', '500.00');
    enterRow(1, '609.87', '498.99');
    await suggest();

    expect(detect).toHaveBeenCalledWith(expect.objectContaining({ interestRate: null }));
    expect(screen.getByText(/^Low confidence/)).toBeInTheDocument();
  });

  it('closing leaves the form untouched and clears what was typed', async () => {
    detect.mockResolvedValue({ type: 'LINEAR', confidence: 'high', reason: 'CONSTANT_PRINCIPAL' });
    const { onUse } = renderDetector();
    open();
    enterRow(0, '833.33', '500.00');
    enterRow(1, '833.33', '498.61');
    await suggest();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onUse).not.toHaveBeenCalled();
    open();
    expect(screen.getAllByLabelText('Principal')[0]).toHaveValue('');
    expect(screen.queryByText(/Suggested type/)).not.toBeInTheDocument();
  });

  it('drops a suggestion once the installments it was read from change', async () => {
    detect.mockResolvedValue({ type: 'LINEAR', confidence: 'high', reason: 'CONSTANT_PRINCIPAL' });
    renderDetector();
    open();
    enterRow(0, '833.33', '500.00');
    enterRow(1, '833.33', '498.61');
    await suggest();
    expect(screen.getByText(/Suggested type/)).toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText('Interest')[1], { target: { value: '499.00' } });
    expect(screen.queryByText(/Suggested type/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use This Type' })).not.toBeInTheDocument();
  });

  it('asks for both halves of a partly filled row before asking the server', () => {
    renderDetector();
    open();
    fireEvent.change(screen.getAllByLabelText('Principal')[0], { target: { value: '833.33' } });
    expect(
      screen.getByText('Enter both the principal and the interest, or leave the row empty.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest a Type' })).toBeDisabled();
  });

  it('waits for a payment frequency', () => {
    renderDetector({ paymentFrequency: undefined });
    open();
    expect(screen.getByText(/Choose the payment frequency below first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest a Type' })).toBeDisabled();
  });

  it('says the request failed rather than showing no suggestion', async () => {
    detect.mockRejectedValue(new Error('network'));
    renderDetector();
    open();
    enterRow(0, '833.33', '500.00');
    enterRow(1, '833.33', '498.61');
    await suggest();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The installments could not be checked because the request failed. Try again.',
    );
    expect(screen.queryByText('No type suggested.')).not.toBeInTheDocument();
  });
});
