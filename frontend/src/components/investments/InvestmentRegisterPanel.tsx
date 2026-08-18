'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { transactionsApi } from '@/lib/transactions';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { getErrorMessage } from '@/lib/errors';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useFormModal } from '@/hooks/useFormModal';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { Pagination } from '@/components/ui/Pagination';
import { InvestmentTransactionList } from '@/components/investments/InvestmentTransactionList';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import { TransactionList } from '@/components/transactions/TransactionList';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import {
  InvestmentViewToggle,
  type InvestmentTransactionView,
} from '@/components/investments/InvestmentViewToggle';
import type { Account } from '@/types/account';
import type { InvestmentTransaction } from '@/types/investment';
import type { Transaction } from '@/types/transaction';

const PAGE_SIZE = 25;

interface InvestmentRegisterPanelProps {
  /** The account holding the securities: the brokerage half, or a standalone. */
  holdingsAccount: Account;
  /**
   * The ledger holding the money: the cash half of a pair, or the account
   * itself when it keeps its own cash. Null for a brokerage with no cash
   * ledger, which offers the brokerage register alone.
   */
  cashAccount: Account | null;
  /**
   * Raised after any write on either ledger, so the surrounding view can
   * re-fetch what it derives from these rows. A cash deposit moves the cash
   * balance the Holdings by Account list is showing, and reloading this panel
   * alone left that figure at its pre-write value until the page was reloaded
   * (issue #1190).
   */
  onDataChanged?: () => void;
}

/**
 * Both ledgers of one investment account, behind a single toggle.
 *
 * An investment account is stored as two accounts -- securities on one, money
 * on the other -- and this is where that stops being the user's problem: the
 * trades and the cash register sit under one heading, and the toggle chooses
 * which is on screen. Each side keeps its own pagination and its own form, and
 * every write drops the balance caches, because a trade moves cash and a cash
 * row can carry an investment split.
 */
export function InvestmentRegisterPanel({
  holdingsAccount,
  cashAccount,
  onDataChanged,
}: InvestmentRegisterPanelProps) {
  const t = useTranslations('accountDetail-investment');
  const [view, setView] = useLocalStorage<InvestmentTransactionView>(
    'monize-account-detail-register-view',
    'brokerage',
  );

  const [brokerageTx, setBrokerageTx] = useState<InvestmentTransaction[]>([]);
  const [brokeragePage, setBrokeragePage] = useState(1);
  const [brokerageTotal, setBrokerageTotal] = useState(0);
  const [cashTx, setCashTx] = useState<Transaction[]>([]);
  const [cashPage, setCashPage] = useState(1);
  const [cashTotal, setCashTotal] = useState(0);
  // The balance the page's first row runs from. It is part of the same
  // payload as the rows and is only meaningful beside them, so it is adopted
  // in the same block -- a starting balance from one page against another
  // page's rows is a running balance for transactions nobody is looking at.
  const [cashStartingBalance, setCashStartingBalance] = useState<
    number | undefined
  >(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  // Every account the user can fund a trade from, for the brokerage form's
  // "Funds From" / "Deposit To" pickers. Undefined until it loads and after a
  // failure, because the form reads undefined as "not supplied" and falls back
  // to the pair -- an empty array would be a claim that the user has no other
  // accounts. See the effect below.
  const [allAccounts, setAllAccounts] = useState<Account[] | undefined>(undefined);
  // The key of the request the data on screen answered. Deriving the loading
  // flag from it, rather than setting one at the top of the effect, keeps the
  // payload and the request that produced it together -- and setState in an
  // effect body is banned for the cascading render it causes.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // The cash register is scoped to the cash ledger alone. Widening it to the
  // pair would put the brokerage's own rows -- the ones its trades generated
  // on the other side -- into a register the user reads as their cash account.
  const cashAccountId = cashAccount?.id ?? null;
  const holdingsAccountId = holdingsAccount.id;
  // Everything that changes which rows belong on screen.
  const requestKey = `${holdingsAccountId}|${cashAccountId ?? ''}|${brokeragePage}|${cashPage}|${reloadKey}`;
  const isLoading = loadedKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [brokerage, cash] = await Promise.all([
        investmentsApi
          .getTransactions({
            accountIds: holdingsAccountId,
            page: brokeragePage,
            limit: PAGE_SIZE,
          })
          .catch(() => null),
        cashAccountId
          ? transactionsApi
              .getAll({
                accountIds: [cashAccountId],
                page: cashPage,
                limit: PAGE_SIZE,
              })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      if (cancelled) return;
      // A failed request is not an empty register: keep whatever is on screen
      // rather than reporting no transactions.
      if (brokerage) {
        setBrokerageTx(brokerage.data);
        setBrokerageTotal(brokerage.pagination?.total ?? brokerage.data.length);
      }
      if (cash) {
        setCashTx(cash.data);
        setCashTotal(cash.pagination?.total ?? cash.data.length);
        setCashStartingBalance(cash.startingBalance);
      }
      setLoadedKey(requestKey);
    })();
    return () => {
      cancelled = true;
    };
  }, [requestKey, holdingsAccountId, cashAccountId, brokeragePage, cashPage]);

  // The pair alone is not the set of accounts a trade can be funded from -- a
  // purchase is as often paid for out of a chequing account or another
  // brokerage's cash. The Investments page hands the same form the full list;
  // the detail page passed only the two accounts it had, so the picker offered
  // nothing but the linked cash account (issue #1191).
  useEffect(() => {
    let cancelled = false;
    accountsApi
      .getAll()
      .then((accounts) => {
        if (!cancelled) setAllAccounts(accounts);
      })
      // A failed lookup is not an empty list: leaving this undefined keeps the
      // form on its own fallback rather than showing an empty picker.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const afterWrite = useCallback(() => {
    // A trade settles into the cash ledger and a cash row can carry an
    // investment split, so either side moves balances the cached account list
    // and portfolio summary are showing.
    invalidateBalanceCaches();
    reload();
    // Dropped caches only make the *next* fetch honest. The holdings, the
    // portfolio summary and the allocation beside this panel are already
    // rendered, so they have to be told to fetch again.
    onDataChanged?.();
  }, [reload, onDataChanged]);

  const brokerageForm = useFormModal<InvestmentTransaction>();
  const cashForm = useFormModal<Transaction>();

  const handleDeleteBrokerage = useCallback(
    async (id: string) => {
      try {
        await investmentsApi.deleteTransaction(id);
        afterWrite();
      } catch (error) {
        toast.error(getErrorMessage(error, t('register.deleteFailed')));
      }
    },
    [afterWrite, t],
  );

  // There is deliberately no cash-delete handler here. `InvestmentTransactionList`
  // asks its parent to perform the delete; `TransactionList` performs its own and
  // only reports it afterwards, so the cash register needs `onRefresh` and
  // nothing else. Deleting again from here 404'd on the row the list had just
  // removed, putting a "not found" toast beside the success one (issue #1192).

  const accountsForForm = cashAccount
    ? [holdingsAccount, cashAccount]
    : [holdingsAccount];

  const toggle = cashAccount ? (
    <InvestmentViewToggle value={view} onChange={setView} />
  ) : undefined;
  // With no cash ledger there is nothing to switch to, so the brokerage
  // register is simply the register.
  const activeView: InvestmentTransactionView = cashAccount ? view : 'brokerage';

  return (
    <div className="space-y-4">
      {activeView === 'brokerage' ? (
        <>
          <InvestmentTransactionList
            densityView="accountRegister"
            transactions={brokerageTx}
            accounts={accountsForForm}
            isLoading={isLoading}
            onDelete={handleDeleteBrokerage}
            onEdit={brokerageForm.openEdit}
            onNewTransaction={brokerageForm.openCreate}
            onStatusChanged={reload}
            viewToggle={toggle}
          />
          {brokerageTotal > PAGE_SIZE && (
            <Pagination
              currentPage={brokeragePage}
              totalPages={Math.ceil(brokerageTotal / PAGE_SIZE)}
              totalItems={brokerageTotal}
              pageSize={PAGE_SIZE}
              onPageChange={setBrokeragePage}
              itemName="transactions"
            />
          )}
        </>
      ) : (
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg">
          <div className="px-3 pt-3 sm:px-4 sm:pt-4 flex flex-wrap justify-between items-center gap-2">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('register.cashHeading')}
              </h3>
              {toggle}
            </div>
            <button
              onClick={cashForm.openCreate}
              className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              {t('register.newCashTransaction')}
            </button>
          </div>
          <TransactionList
            densityView="accountRegister"
            transactions={cashTx}
            onEdit={cashForm.openEdit}
            onRefresh={afterWrite}
            isSingleAccountView
            currentPage={cashPage}
            totalPages={Math.ceil(cashTotal / PAGE_SIZE) || 1}
            totalItems={cashTotal}
            pageSize={PAGE_SIZE}
            onPageChange={setCashPage}
            startingBalance={cashStartingBalance}
          />
        </div>
      )}

      <Modal
        isOpen={brokerageForm.showForm}
        onClose={brokerageForm.close}
        {...brokerageForm.modalProps}
        maxWidth="6xl"
        className="p-6"
      >
        <InvestmentTransactionForm
          accounts={accountsForForm}
          allAccounts={allAccounts}
          transaction={brokerageForm.editingItem}
          defaultAccountId={holdingsAccount.id}
          onSuccess={() => {
            brokerageForm.close();
            afterWrite();
          }}
          onCancel={brokerageForm.close}
          onDirtyChange={brokerageForm.setFormDirty}
          submitRef={brokerageForm.formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...brokerageForm.unsavedChangesDialog} />

      {cashAccount && (
        <>
          <Modal
            isOpen={cashForm.showForm}
            onClose={cashForm.close}
            {...cashForm.modalProps}
            maxWidth="6xl"
            className="p-6"
          >
            <TransactionForm
              transaction={cashForm.editingItem}
              defaultAccountId={cashAccount.id}
              onSuccess={() => {
                cashForm.close();
                afterWrite();
              }}
              onCancel={cashForm.close}
              onDirtyChange={cashForm.setFormDirty}
              submitRef={cashForm.formSubmitRef}
            />
          </Modal>
          <UnsavedChangesDialog {...cashForm.unsavedChangesDialog} />
        </>
      )}
    </div>
  );
}
