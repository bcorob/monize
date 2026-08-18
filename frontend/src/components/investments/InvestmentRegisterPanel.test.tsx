import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { NextIntlClientProvider } from 'next-intl';
import toast from 'react-hot-toast';
import { InvestmentRegisterPanel } from './InvestmentRegisterPanel';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { transactionsApi } from '@/lib/transactions';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import type { Account } from '@/types/account';
import { TransactionStatus, type Transaction } from '@/types/transaction';
import investmentMessages from '@/i18n/messages/en/accountDetail-investment.json';
import investmentsNs from '@/i18n/messages/en/investments.json';
import transactionsNs from '@/i18n/messages/en/transactions.json';
import commonNs from '@/i18n/messages/en/common.json';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTransactions: vi.fn(),
    deleteTransaction: vi.fn(),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn(),
    delete: vi.fn(),
    deleteTransfer: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn() },
}));

vi.mock('@/lib/apiCache', () => ({
  invalidateBalanceCaches: vi.fn(),
}));

// The forms are large trees with their own data loading; the panel's contract
// with them is that it mounts them against the right account, and hands the
// brokerage form every account a trade can be funded from.
vi.mock('./InvestmentTransactionForm', () => ({
  InvestmentTransactionForm: ({
    defaultAccountId,
    allAccounts,
  }: {
    defaultAccountId?: string;
    allAccounts?: { id: string }[];
  }) => (
    <div data-testid="investment-form">
      {defaultAccountId}
      <span data-testid="form-all-accounts">
        {allAccounts === undefined ? 'undefined' : allAccounts.map((a) => a.id).join(',')}
      </span>
    </div>
  ),
}));
vi.mock('@/components/transactions/TransactionForm', () => ({
  TransactionForm: ({ defaultAccountId }: { defaultAccountId?: string }) => (
    <div data-testid="cash-form">{defaultAccountId}</div>
  ),
}));
// `TransactionList` is deliberately NOT stubbed: it owns its own delete, and the
// bug in issue #1192 was the panel deleting a second time on top of it. A stub
// cannot show that.

const brokerage = {
  id: 'brok',
  name: 'TFSA - Brokerage',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  linkedAccountId: 'cash',
  currencyCode: 'CAD',
  currentBalance: 0,
  isClosed: false,
} as Account;

const cash = {
  id: 'cash',
  name: 'TFSA - Cash',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_CASH',
  linkedAccountId: 'brok',
  currencyCode: 'CAD',
  currentBalance: 3500,
  isClosed: false,
} as Account;

/** An account outside the pair -- what "Funds From" is supposed to offer. */
const chequing = {
  id: 'chq',
  name: 'Everyday Chequing',
  accountType: 'CHEQUING',
  accountSubType: null,
  linkedAccountId: null,
  currencyCode: 'CAD',
  currentBalance: 2000,
  isClosed: false,
} as Account;

const cashTransaction: Transaction = {
  id: 'cash-tx-1',
  userId: 'user-1',
  accountId: 'cash',
  account: { id: 'cash', name: 'TFSA - Cash', accountType: 'INVESTMENT' } as never,
  transactionDate: '2026-01-05',
  payeeId: null,
  payeeName: 'Contribution',
  payee: null,
  categoryId: null,
  category: null,
  amount: 500,
  currencyCode: 'CAD',
  exchangeRate: 1,
  originalAmount: null,
  originalCurrencyCode: null,
  description: 'Cash deposit',
  referenceNumber: null,
  status: TransactionStatus.UNRECONCILED,
  isCleared: false,
  isReconciled: false,
  isVoid: false,
  reconciledDate: null,
  isSplit: false,
  parentTransactionId: null,
  isTransfer: false,
  linkedTransactionId: null,
  createdAt: '2026-01-05T00:00:00Z',
  updatedAt: '2026-01-05T00:00:00Z',
};

const standalone = {
  id: 'solo',
  name: 'Self-directed',
  accountType: 'INVESTMENT',
  accountSubType: null,
  linkedAccountId: null,
  currencyCode: 'CAD',
  currentBalance: 100,
  isClosed: false,
} as Account;

async function renderPanel(
  holdingsAccount: Account,
  cashAccount: Account | null,
  onDataChanged?: () => void,
) {
  await act(async () => {
    render(
      <NextIntlClientProvider
        locale="en"
        messages={{
          'accountDetail-investment': investmentMessages,
          investments: investmentsNs,
          transactions: transactionsNs,
          common: commonNs,
        }}
      >
        <InvestmentRegisterPanel
          holdingsAccount={holdingsAccount}
          cashAccount={cashAccount}
          onDataChanged={onDataChanged}
        />
      </NextIntlClientProvider>,
    );
  });
}

/** Put the cash ledger on screen. */
async function switchToCash() {
  await act(async () => {
    fireEvent.click(screen.getByText('Cash'));
  });
}

/** Delete the cash register's only row, confirmation included. */
async function deleteFirstCashRow() {
  const rowDelete = screen
    .getAllByRole('button')
    .filter((b) => b.textContent === 'Delete')[0];
  await act(async () => {
    fireEvent.click(rowDelete);
  });
  const confirm = screen
    .getAllByRole('button')
    .filter((b) => b.textContent === 'Delete')
    .pop()!;
  await act(async () => {
    fireEvent.click(confirm);
  });
}

/** Switch to the cash ledger and delete its only row. */
async function deleteTheCashRow() {
  await switchToCash();
  await deleteFirstCashRow();
}

describe('InvestmentRegisterPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      pagination: { total: 0, page: 1, limit: 25, totalPages: 0 },
    });
    (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [cashTransaction],
      pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
    });
    (transactionsApi.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (accountsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      brokerage,
      cash,
      chequing,
    ]);
  });

  describe('scoping', () => {
    // The brokerage's own ledger carries the cash rows its trades generated.
    // Widening the cash register to the pair would put those in a register the
    // user reads as their cash account.
    it('scopes the cash register to the cash ledger alone', async () => {
      await renderPanel(brokerage, cash);

      expect(transactionsApi.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ['cash'] }),
      );
      const call = (transactionsApi.getAll as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.accountIds).not.toContain('brok');
    });

    it('scopes the brokerage register to the holdings account alone', async () => {
      await renderPanel(brokerage, cash);

      expect(investmentsApi.getTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'brok' }),
      );
    });

    it('scopes both registers to itself for a standalone account', async () => {
      await renderPanel(standalone, standalone);

      expect(investmentsApi.getTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'solo' }),
      );
      expect(transactionsApi.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ['solo'] }),
      );
    });

    it('asks for no cash register when the account has no cash ledger', async () => {
      await renderPanel(brokerage, null);

      expect(transactionsApi.getAll).not.toHaveBeenCalled();
      expect(investmentsApi.getTransactions).toHaveBeenCalled();
    });
  });

  describe('the toggle', () => {
    it('offers both ledgers when there is a cash half', async () => {
      await renderPanel(brokerage, cash);

      expect(screen.getByText('Brokerage')).toBeInTheDocument();
      expect(screen.getByText('Cash')).toBeInTheDocument();
    });

    it('shows the cash register once the cash ledger is chosen', async () => {
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('Cash'));
      });

      expect(screen.getByText('Contribution')).toBeInTheDocument();
    });

    it('offers no toggle when there is no second ledger to switch to', async () => {
      await renderPanel(brokerage, null);

      expect(screen.queryByText('Cash')).not.toBeInTheDocument();
    });
  });

  // Issue #1188. The register draws a Balance column for a single-account view,
  // and the number in it is the backend's starting balance run down the page.
  // The panel read the rows off the response and dropped the starting balance
  // beside them, so every row's balance cell rendered the empty marker.
  describe('the running balance', () => {
    it('shows the balance the rows run from', async () => {
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        startingBalance: 3500,
      });

      await renderPanel(brokerage, cash);
      await switchToCash();

      expect(screen.getByText('Balance')).toBeInTheDocument();
      expect(screen.getByText('$3,500.00')).toBeInTheDocument();
    });

    // The starting balance is computed for one page of one account and means
    // nothing beside another page's rows, so it is adopted from the same
    // response as the rows rather than lagging a request behind them.
    it('moves the balance with the rows it was computed for', async () => {
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        startingBalance: 3500,
      });

      await renderPanel(brokerage, cash);
      await switchToCash();

      // The write's reload answers with the register as it now stands.
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            ...cashTransaction,
            id: 'cash-tx-2',
            payeeName: 'Withdrawal',
            amount: -750,
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        startingBalance: 2750,
      });
      await deleteFirstCashRow();

      await waitFor(() => {
        expect(screen.getByText('Withdrawal')).toBeInTheDocument();
        expect(screen.getByText('$2,750.00')).toBeInTheDocument();
      });
      expect(screen.queryByText('$3,500.00')).not.toBeInTheDocument();
    });

    // A failed reload is not a register with no starting balance: the rows on
    // screen stay, so the balances beside them have to stay too rather than
    // collapsing to the empty marker under unchanged rows.
    it('keeps the balance when a reload fails', async () => {
      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [cashTransaction],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
        startingBalance: 3500,
      });

      await renderPanel(brokerage, cash);
      await switchToCash();

      (transactionsApi.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network'),
      );
      await deleteFirstCashRow();
      await act(async () => {});

      expect(screen.getByText('Contribution')).toBeInTheDocument();
      expect(screen.getByText('$3,500.00')).toBeInTheDocument();
    });
  });

  describe('writes', () => {
    // A trade settles into the cash ledger and a cash row can carry an
    // investment split, so either side moves balances that the cached account
    // list and portfolio summary are showing.
    it('drops the balance caches after deleting a trade', async () => {
      (investmentsApi.getTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            accountId: 'brok',
            action: 'BUY',
            transactionDate: '2026-01-05',
            quantity: 1,
            price: 10,
            totalAmount: 10,
            security: { symbol: 'VTI', name: 'Vanguard', currencyCode: 'CAD' },
          },
        ],
        pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      });
      (investmentsApi.deleteTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      await renderPanel(brokerage, cash);

      // Row action, then the confirmation it opens.
      const deleteActions = screen.getAllByText('Delete');
      await act(async () => {
        fireEvent.click(deleteActions[0]);
      });
      const confirm = screen
        .getAllByRole('button')
        .filter((b) => b.textContent === 'Delete')
        .pop()!;
      await act(async () => {
        fireEvent.click(confirm);
      });

      await waitFor(() => {
        expect(investmentsApi.deleteTransaction).toHaveBeenCalledWith('tx-1');
      });
      expect(invalidateBalanceCaches).toHaveBeenCalled();
    });

    // Issue #1192. The two lists have opposite delete contracts:
    // `InvestmentTransactionList` asks its parent to perform the delete, while
    // `TransactionList` performs its own and only reports it afterwards. The
    // cash register was given a handler shaped like the brokerage one, so every
    // cash row was deleted twice -- the second request 404'd on the row the
    // first had removed, and the user saw "not found" beside "deleted".
    it('deletes a cash row exactly once', async () => {
      await renderPanel(brokerage, cash);

      await deleteTheCashRow();

      await waitFor(() => {
        expect(transactionsApi.delete).toHaveBeenCalledWith('cash-tx-1');
      });
      expect(transactionsApi.delete).toHaveBeenCalledTimes(1);
    });

    it('reports no error after deleting a cash row', async () => {
      await renderPanel(brokerage, cash);

      await deleteTheCashRow();

      await waitFor(() => expect(transactionsApi.delete).toHaveBeenCalled());
      await act(async () => {});
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalled();
    });

    it('drops the balance caches after deleting a cash row', async () => {
      await renderPanel(brokerage, cash);

      await deleteTheCashRow();

      await waitFor(() => expect(invalidateBalanceCaches).toHaveBeenCalled());
    });

    // Issue #1190: the figures above this panel are derived from these rows, so
    // the view around it has to be told a write happened.
    it('tells the surrounding view about a cash write', async () => {
      const onDataChanged = vi.fn();
      await renderPanel(brokerage, cash, onDataChanged);

      await deleteTheCashRow();

      await waitFor(() => expect(onDataChanged).toHaveBeenCalled());
    });
  });

  // Issue #1191. The pair is not the set of accounts a trade can be funded
  // from: a purchase is as often paid for out of a chequing account or another
  // brokerage's cash. Given only the two accounts it had, the form's "Funds
  // From" picker offered nothing but the linked cash account.
  describe('the brokerage form', () => {
    it('is handed every account, not just the pair', async () => {
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });

      await waitFor(() =>
        expect(screen.getByTestId('form-all-accounts')).toHaveTextContent(
          'brok,cash,chq',
        ),
      );
    });

    // A failed lookup is not an empty list. Passing `[]` would tell the form the
    // user has no other accounts; leaving it undefined keeps its own fallback.
    it('supplies no account list at all when the lookup fails', async () => {
      (accountsApi.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('offline'),
      );
      await renderPanel(brokerage, cash);

      await act(async () => {
        fireEvent.click(screen.getByText('+ New Brokerage Transaction'));
      });

      expect(screen.getByTestId('form-all-accounts')).toHaveTextContent('undefined');
    });
  });
});
