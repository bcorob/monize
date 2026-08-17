import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InvestmentDetailActions } from './InvestmentDetailActions';
import type { Account } from '@/types/account';

const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  // Built on first use, not in the factory body: vi.mock is hoisted above the
  // consts it closes over, and the real useRouter returns one stable router.
  let router: { push: typeof mockPush } | null = null;
  return {
    useRouter: () => (router ??= { push: mockPush }),
    usePathname: () => '/accounts/br-1',
    useParams: () => ({ id: 'br-1' }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/components/reports/RefreshPricesButton', () => ({
  RefreshPricesButton: ({ onRefreshComplete }: { onRefreshComplete: () => void }) => (
    <button type="button" onClick={() => onRefreshComplete()}>
      Refresh Prices
    </button>
  ),
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'br-1',
    name: 'RRSP - Brokerage',
    accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_BROKERAGE',
    currencyCode: 'CAD',
    currentBalance: 0,
    isClosed: false,
    ...overrides,
  } as Account;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InvestmentDetailActions', () => {
  it('links an open account to the full investments view', () => {
    render(<InvestmentDetailActions account={makeAccount()} onRefreshComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open in Investments' }));

    expect(mockPush).toHaveBeenCalledWith('/investments?accountId=br-1');
  });

  // /investments resolves its accountId against getInvestmentAccounts, which
  // takes isClosed: false -- a closed account is not in that list, so the link
  // would drop the filter and show the whole portfolio.
  it('offers no investments link for a closed account', () => {
    render(
      <InvestmentDetailActions
        account={makeAccount({ id: 'br-closed', isClosed: true, closedDate: '2024-01-01T00:00:00Z' })}
        onRefreshComplete={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Open in Investments' })).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps Refresh Prices for a closed account', () => {
    const onRefreshComplete = vi.fn();
    render(
      <InvestmentDetailActions
        account={makeAccount({ isClosed: true, closedDate: '2024-01-01T00:00:00Z' })}
        onRefreshComplete={onRefreshComplete}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Prices' }));

    expect(onRefreshComplete).toHaveBeenCalled();
  });
});
