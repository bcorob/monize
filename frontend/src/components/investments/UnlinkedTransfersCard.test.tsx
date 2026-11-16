import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { UnlinkedTransfersCard } from './UnlinkedTransfersCard';
import { investmentsApi } from '@/lib/investments';
import { numberFormatMockDefaults } from '@/test/number-format-mock';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getUnlinkedTransferPairs: vi.fn(),
    linkTransferPair: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatShareQuantity: (q: number) => String(q),
  }),
}));

const pair = (overrides = {}) => ({
  securityId: 'sec-1',
  symbol: 'HUDCE',
  securityName: 'A fund',
  transactionDate: '2020-01-20',
  quantity: 1140,
  out: { transactionId: 'tx-out', accountId: 'acct-ca', accountName: 'CA RRSP' },
  in: { transactionId: 'tx-in', accountId: 'acct-us', accountName: 'US RRSP' },
  ...overrides,
});

describe('UnlinkedTransfersCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(investmentsApi.getUnlinkedTransferPairs).mockResolvedValue([pair()]);
    vi.mocked(investmentsApi.linkTransferPair).mockResolvedValue(undefined);
  });

  it('names both accounts, the security and the day, so the reader can recognise it', async () => {
    await act(async () => {
      render(<UnlinkedTransfersCard />);
    });

    const row = screen.getByTestId('unlinked-transfers').textContent ?? '';
    expect(row).toContain('HUDCE');
    expect(row).toContain('CA RRSP');
    expect(row).toContain('US RRSP');
    expect(row).toContain('2020-01-20');
  });

  it('renders nothing at all when there is nothing to suggest', async () => {
    vi.mocked(investmentsApi.getUnlinkedTransferPairs).mockResolvedValue([]);

    await act(async () => {
      render(<UnlinkedTransfersCard />);
    });

    expect(screen.queryByTestId('unlinked-transfers')).toBeNull();
  });

  it('claims nothing when the look itself failed', async () => {
    // A failed request is not "none found": the card stays silent rather than
    // telling the reader their ledger is tidy.
    vi.mocked(investmentsApi.getUnlinkedTransferPairs).mockRejectedValue(
      new Error('unavailable'),
    );

    await act(async () => {
      render(<UnlinkedTransfersCard />);
    });

    expect(screen.queryByTestId('unlinked-transfers')).toBeNull();
  });

  it('links only the pair the reader confirmed, and re-reads after', async () => {
    const onLinked = vi.fn();
    await act(async () => {
      render(<UnlinkedTransfersCard onLinked={onLinked} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    });

    expect(investmentsApi.linkTransferPair).toHaveBeenCalledWith({
      outTransactionId: 'tx-out',
      inTransactionId: 'tx-in',
    });
    expect(investmentsApi.linkTransferPair).toHaveBeenCalledTimes(1);
    // The pairing rewrote both holdings' basis, so the page re-reads.
    expect(onLinked).toHaveBeenCalled();
    expect(investmentsApi.getUnlinkedTransferPairs).toHaveBeenCalledTimes(2);
  });

  it("shows the server's reason when it refuses the pair", async () => {
    // The server names which condition failed; a generic failure would leave
    // the reader with nothing to act on.
    vi.mocked(investmentsApi.linkTransferPair).mockRejectedValue({
      response: { data: { message: 'Both legs must be dated the same day' } },
    });

    await act(async () => {
      render(<UnlinkedTransfersCard />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    });

    expect(
      screen.getByText('Both legs must be dated the same day'),
    ).toBeInTheDocument();
  });

  it('asks about the accounts the page is filtered to', async () => {
    await act(async () => {
      render(<UnlinkedTransfersCard accountIds={['acct-ca']} />);
    });

    expect(investmentsApi.getUnlinkedTransferPairs).toHaveBeenCalledWith([
      'acct-ca',
    ]);
  });
});
