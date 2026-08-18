'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import { transactionsApi } from '@/lib/transactions';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { editCashRow } from '@/lib/cash-row-edit';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { Account } from '@/types/account';
import {
  PortfolioSummary,
  InvestmentTransaction,
  InvestmentTransactionPaginationInfo,
} from '@/types/investment';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { useFormModal } from '@/hooks/useFormModal';
import { createLogger } from '@/lib/logger';
import { PAGE_SIZE } from '@/lib/constants';
import { type TransactionFilters } from '@/components/investments/InvestmentTransactionList';
import {
  countActiveCashFilters,
  EMPTY_CASH_FILTERS,
  type CashFilterValues,
} from '@/components/investments/CashRegisterFilters';

const logger = createLogger('Investments');

export function useInvestmentData() {
  const t = useTranslations('investments');
  const searchParams = useSearchParams();
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useLocalStorage<string[]>('monize-investments-accounts', []);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [pagination, setPagination] = useState<InvestmentTransactionPaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const {
    showForm: showTransactionForm, editingItem: editingTransaction,
    openCreate, openEdit, close, isEditing: _isEditing,
    modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef,
  } = useFormModal<InvestmentTransaction>();
  const [lastPriceUpdate, setLastPriceUpdate] = useState<string | null>(null);
  const [transactionFilters, setTransactionFilters] = useState<TransactionFilters>({});
  // Bumped by every write on either register. The sections this hook fetches
  // are reloaded directly; the Portfolio Value chart fetches its own series and
  // is only reachable as a prop, so it takes this as its `refreshKey`.
  const [writeRefreshKey, setWriteRefreshKey] = useState(0);

  // Cash transaction state
  const [cashTransactions, setCashTransactions] = useState<Transaction[]>([]);
  const [cashPagination, setCashPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [cashCurrentPage, setCashCurrentPage] = useState(1);
  const [cashTransactionsLoading, setCashTransactionsLoading] = useState(false);
  const [cashStartingBalance, setCashStartingBalance] = useState<number | undefined>();
  const [showCashFilters, setShowCashFilters] = useState(false);
  // One object for the four cash filters: they are set, counted and cleared
  // together, and `CashFilterBar` -- shared with the account detail page's
  // register -- is controlled by exactly this shape.
  const [cashFilters, setCashFiltersState] = useState<CashFilterValues>(EMPTY_CASH_FILTERS);
  const [cashPayees, setCashPayees] = useState<Payee[]>([]);
  const [cashCategories, setCashCategories] = useState<Category[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  // Cash transaction form modal
  const {
    showForm: showCashForm, editingItem: editingCashTransaction,
    openCreate: openCashCreate, openEdit: openCashEdit, close: closeCash,
    modalProps: cashModalProps, setFormDirty: setCashFormDirty,
    unsavedChangesDialog: cashUnsavedChangesDialog, formSubmitRef: cashFormSubmitRef,
  } = useFormModal<Transaction>();

  const loadInvestmentAccounts = useCallback(async () => {
    try {
      const accountsData = await investmentsApi.getInvestmentAccounts();
      setAccounts(accountsData);
    } catch (error) {
      logger.error('Failed to load investment accounts:', error);
    }
  }, []);

  const loadAllAccounts = useCallback(async () => {
    try {
      const accountsData = await accountsApi.getAll();
      setAllAccounts(accountsData);
    } catch (error) {
      logger.error('Failed to load all accounts:', error);
    }
  }, []);

  const loadCashFilterData = useCallback(async () => {
    try {
      const [cats, pays] = await Promise.all([
        categoriesApi.getAll(),
        payeesApi.getAll(),
      ]);
      setCashCategories(cats);
      setCashPayees(pays);
    } catch (error) {
      logger.error('Failed to load cash filter data:', error);
    }
  }, []);

  const loadPriceStatus = useCallback(async () => {
    try {
      const status = await investmentsApi.getPriceStatus();
      setLastPriceUpdate(status.lastUpdated);
    } catch (error) {
      logger.error('Failed to load price status:', error);
    }
  }, []);

  // Track whether the initial load has completed so subsequent reloads
  // (price refresh, account selection change, pagination, filter change)
  // can run "in the background" while sections keep showing their existing
  // data. Without this, every refresh flips isLoading=true and every
  // skeleton-gated section re-mounts from blank -- which is the
  // "everything redraws when prices refresh" bug. The Portfolio Value chart
  // is unaffected because it already has its own keep-data-while-loading
  // pattern; this generalises that behaviour to the rest of the page.
  const hasLoadedRef = useRef(false);

  const loadAllPortfolioData = useCallback(async (
    accountIds: string[],
    page: number = 1,
    filters: TransactionFilters = {},
  ) => {
    if (!hasLoadedRef.current) setIsLoading(true);
    try {
      const ids = accountIds.length > 0 ? accountIds : undefined;
      const [summaryData, txResponse] = await Promise.all([
        investmentsApi.getPortfolioSummary(ids),
        investmentsApi.getTransactions({
          accountIds: ids ? ids.join(',') : undefined,
          page,
          limit: PAGE_SIZE,
          symbol: filters.symbol,
          action: filters.action,
          startDate: filters.startDate,
          endDate: filters.endDate,
        }),
      ]);
      setPortfolioSummary(summaryData);
      setTransactions(txResponse.data || []);
      setPagination(txResponse.pagination);
    } catch (error) {
      logger.error('Failed to load portfolio data:', error);
      setPortfolioSummary(null);
      setTransactions([]);
      setPagination(null);
    } finally {
      if (!hasLoadedRef.current) setIsLoading(false);
      hasLoadedRef.current = true;
    }
  }, []);

  const { isRefreshing: isRefreshingPrices, triggerManualRefresh: handleRefreshPrices, triggerAutoRefresh } = usePriceRefresh({
    onRefreshComplete: (lastUpdated) => {
      loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
      // Prefer the refresh result's timestamp: savePriceData UPDATEs existing
      // rows in place, so the DB-backed lastUpdated (createdAt) wouldn't advance
      // on same-day refreshes. Fall back to the DB value if the result didn't
      // carry one (e.g. when no securities to refresh).
      if (lastUpdated) {
        setLastPriceUpdate(lastUpdated);
      } else {
        loadPriceStatus();
      }
    },
  });

  const loadPortfolioSummary = useCallback(async (accountIds: string[]) => {
    try {
      const ids = accountIds.length > 0 ? accountIds : undefined;
      const summaryData = await investmentsApi.getPortfolioSummary(ids);
      setPortfolioSummary(summaryData);
    } catch (error) {
      logger.error('Failed to load portfolio summary:', error);
      setPortfolioSummary(null);
    }
  }, []);

  const loadTransactions = useCallback(async (
    accountIds: string[],
    page: number = 1,
    filters: TransactionFilters = {},
  ) => {
    try {
      const ids = accountIds.length > 0 ? accountIds : undefined;
      const txResponse = await investmentsApi.getTransactions({
        accountIds: ids ? ids.join(',') : undefined,
        page,
        limit: PAGE_SIZE,
        symbol: filters.symbol,
        action: filters.action,
        startDate: filters.startDate,
        endDate: filters.endDate,
      });
      setTransactions(txResponse.data || []);
      setPagination(txResponse.pagination);
    } catch (error) {
      logger.error('Failed to load transactions:', error);
      setTransactions([]);
      setPagination(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Derive cash account IDs from selected brokerage accounts
  const cashAccountIds = useMemo(() => {
    if (selectedAccountIds.length === 0) {
      return accounts
        .filter(a => a.accountSubType === 'INVESTMENT_BROKERAGE' && a.linkedAccountId)
        .map(a => a.linkedAccountId!);
    }
    return selectedAccountIds
      .map(id => accounts.find(a => a.id === id))
      .filter((a): a is Account => !!a && !!a.linkedAccountId)
      .map(a => a.linkedAccountId!);
  }, [selectedAccountIds, accounts]);

  const loadCashTransactions = useCallback(async (
    accountIds: string[],
    page: number = 1,
    filters: { payeeIds?: string[]; categoryIds?: string[]; startDate?: string; endDate?: string } = {},
  ) => {
    if (accountIds.length === 0) {
      setCashTransactions([]);
      setCashPagination(null);
      return;
    }
    setCashTransactionsLoading(true);
    try {
      const response = await transactionsApi.getAll({
        accountIds,
        page,
        limit: PAGE_SIZE,
        payeeIds: filters.payeeIds?.length ? filters.payeeIds : undefined,
        categoryIds: filters.categoryIds?.length ? filters.categoryIds : undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
      });
      setCashTransactions(response.data || []);
      setCashStartingBalance(response.startingBalance);
      setCashPagination(response.pagination ? {
        page: response.pagination.page,
        totalPages: response.pagination.totalPages,
        total: response.pagination.total,
      } : null);
    } catch (error) {
      logger.error('Failed to load cash transactions:', error);
      setCashTransactions([]);
      setCashPagination(null);
    } finally {
      setCashTransactionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvestmentAccounts();
    loadAllAccounts();
    loadPriceStatus();
  }, [loadInvestmentAccounts, loadAllAccounts, loadPriceStatus]);

  // Apply accountId filter from URL query parameter (e.g. navigating from Accounts page)
  const accountIdAppliedRef = useRef(false);
  useEffect(() => {
    if (accountIdAppliedRef.current || accounts.length === 0) return;
    const accountId = searchParams.get('accountId');
    if (accountId) {
      accountIdAppliedRef.current = true;
      const matchingAccount = accounts.find(
        (a) => a.id === accountId && (a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType),
      );
      if (matchingAccount) {
        setSelectedAccountIds([accountId]);
      }
      router.replace('/investments', { scroll: false });
    }
  }, [accounts, searchParams, router, setSelectedAccountIds]);

  // Prune stale/non-selectable account IDs from localStorage when accounts load
  useEffect(() => {
    if (accounts.length > 0 && selectedAccountIds.length > 0) {
      const selectableIds = new Set(
        accounts
          .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType)
          .map((a) => a.id),
      );
      const pruned = selectedAccountIds.filter((id) => selectableIds.has(id));
      if (pruned.length !== selectedAccountIds.length) {
        setSelectedAccountIds(pruned);
      }
    }
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load summary when account selection changes
  useEffect(() => {
    loadPortfolioSummary(selectedAccountIds);
  }, [loadPortfolioSummary, selectedAccountIds]);

  // Load transactions when page, filters, or account selection changes
  useEffect(() => {
    loadTransactions(selectedAccountIds, currentPage, transactionFilters);
  }, [loadTransactions, selectedAccountIds, currentPage, transactionFilters]);

  // Narrowing the list changes which rows page 1 holds, so a filter change
  // always returns to it.
  const setCashFilters = useCallback((next: CashFilterValues) => {
    setCashFiltersState(next);
    setCashCurrentPage(1);
  }, []);

  // Load cash transactions when view switches to 'cash' or dependencies change
  // (Caller must pass transactionView to control this)
  const loadCashTransactionsIfNeeded = useCallback((transactionView: string) => {
    if (transactionView === 'cash') {
      loadCashTransactions(cashAccountIds, cashCurrentPage, cashFilters);
    }
  }, [loadCashTransactions, cashAccountIds, cashCurrentPage, cashFilters]);

  /**
   * Everything this page shows, re-fetched after a write on either register.
   *
   * The two registers are one account's two ledgers: a trade settles into the
   * cash ledger, a cash row can carry an investment split, and both feed the
   * portfolio summary, the allocation, Holdings by Account (cash row included)
   * and the value chart. So a write on either side is a write to all of it, and
   * every write path -- create, edit, delete, status change, on both lists --
   * goes through here rather than reloading the list it happened on.
   *
   * Deleting a cash row reloaded that list alone, which is issue #1190 facing
   * the other way: the row vanished and every figure above it kept its
   * pre-delete value until the user pressed Refresh.
   *
   * Both registers are reloaded whether or not each is the visible one: which
   * view happens to be on screen is not part of whether its rows changed, and
   * toggling to a stale list is the same defect one step later.
   *
   * `invalidateBalanceCaches` only makes the *next* fetch honest, so the
   * reloads below are what actually redraws the page.
   */
  const refreshAfterWrite = useCallback(() => {
    invalidateBalanceCaches();
    loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
    loadCashTransactions(cashAccountIds, cashCurrentPage, cashFilters);
    setWriteRefreshKey((key) => key + 1);
  }, [
    loadAllPortfolioData, selectedAccountIds, currentPage, transactionFilters,
    loadCashTransactions, cashAccountIds, cashCurrentPage, cashFilters,
  ]);

  useEffect(() => {
    if (!isLoading && !initialLoadComplete) {
      setInitialLoadComplete(true);
      triggerAutoRefresh();
    }
  }, [isLoading, initialLoadComplete, triggerAutoRefresh]);

  // Track which edit ID we have already handled
  const editHandledRef = useRef<string | null>(null);

  // Handle edit URL parameter (when redirected from transactions page)
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (editId) {
      if (editId === editHandledRef.current) {
        router.replace('/investments', { scroll: false });
        return;
      }
      editHandledRef.current = editId;
      investmentsApi.getTransaction(editId)
        .then((transaction) => {
          openEdit(transaction);
          router.replace('/investments', { scroll: false });
        })
        .catch((error) => {
          logger.error('Failed to load investment transaction:', error);
          router.replace('/investments', { scroll: false });
        });
    } else if (!showTransactionForm) {
      editHandledRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router, openEdit]);

  const handleAccountChange = (values: string[]) => {
    setSelectedAccountIds(values);
    setCurrentPage(1);
    setCashCurrentPage(1);
  };

  const handleDeleteTransaction = async (id: string) => {
    // Deleting one leg of a security transfer cascades to its paired leg on
    // the backend, so drop both from the list optimistically.
    const target = transactions.find(tx => tx.id === id);
    const removeIds = new Set<string>([id]);
    if (target?.linkedTransactionId) removeIds.add(target.linkedTransactionId);
    // The backend deletes both legs of a transfer, but only legs within the
    // current filter count toward pagination.total. The deleted leg always
    // does. The paired leg counts when either no account filter is applied (the
    // whole portfolio is in the total, even if the leg sits on another page) or
    // it is loaded in the current filtered list -- otherwise it belongs to an
    // account that's filtered out and must not be subtracted.
    const linkedLoaded =
      !!target?.linkedTransactionId &&
      transactions.some(tx => tx.id === target.linkedTransactionId);
    const linkedCounts =
      !!target?.linkedTransactionId &&
      (selectedAccountIds.length === 0 || linkedLoaded);
    const removedCount = linkedCounts ? 2 : 1;
    setTransactions(prev => prev.filter(tx => !removeIds.has(tx.id)));
    // Keep the pagination summary in sync immediately so the bottom counter
    // updates without waiting for the next full reload.
    setPagination(prev => {
      if (!prev) return prev;
      const total = Math.max(0, prev.total - removedCount);
      const totalPages = Math.max(1, Math.ceil(total / prev.limit));
      return {
        ...prev,
        total,
        totalPages,
        hasMore: prev.page < totalPages,
      };
    });
    try {
      await investmentsApi.deleteTransaction(id);
      // A trade's cash leg goes with it, so the cash register, the chart and
      // the balances are all stale now -- not just the portfolio summary.
      refreshAfterWrite();
    } catch (error) {
      logger.error('Failed to delete transaction:', error);
      // Surface the backend's reason (e.g. "would cause holdings to go
      // negative") via toast instead of a native browser alert.
      toast.error(getErrorMessage(error, t('page.toastDeleteFailed')));
      loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
    }
  };

  const handleNewTransaction = () => openCreate();
  const handleEditTransaction = (transaction: InvestmentTransaction) => openEdit(transaction);

  // "Create & New" keeps the form open, so the page only refreshes what it
  // shows behind it -- everything `handleFormSuccess` does bar the close.
  const handleFormCreateAndNew = () => {
    refreshAfterWrite();
  };

  const handleFormSuccess = () => {
    close();
    handleFormCreateAndNew();
  };

  // Cash transaction handlers
  const handleEditCashTransaction = (transaction: Transaction) =>
    editCashRow(transaction, {
      // The investment form is mounted on this page already, so a trade's cash
      // leg opens it here. Routing to `?edit=<id>` reached the same modal by
      // navigating, which remounted the page and scrolled it to the top first;
      // the URL parameter stays for arrivals from elsewhere.
      openInvestment: openEdit,
      openCash: openCashEdit,
      onLookupFailed: (error) =>
        toast.error(getErrorMessage(error, t('page.toastLoadFailed'))),
    });

  const handleCashTransactionUpdate = useCallback((updatedTx: Transaction) => {
    setCashTransactions(prev => prev.map(tx => tx.id === updatedTx.id ? updatedTx : tx));
  }, []);

  const handleCashFormCreateAndNew = () => {
    refreshAfterWrite();
  };

  const handleCashFormSuccess = () => {
    closeCash();
    handleCashFormCreateAndNew();
  };

  const handleFiltersChange = (newFilters: TransactionFilters) => {
    setTransactionFilters(newFilters);
    setCurrentPage(1);
  };

  const clearCashFilters = () => setCashFilters(EMPTY_CASH_FILTERS);

  const activeCashFilterCount = countActiveCashFilters(cashFilters);
  const hasActiveCashFilters = activeCashFilterCount > 0;

  // Clicking a holding opens that security's detail page (review of discussion
  // #964). It used to filter the transaction list by symbol instead; the filters
  // above that list still do that, and the page is the more useful destination.
  const handleSecurityClick = (securityId: string) => {
    router.push(`/securities/${securityId}`);
  };

  const handleCashClick = (cashAccountId: string) => {
    router.push(`/transactions?accountId=${cashAccountId}`);
  };

  const goToPage = (page: number) => {
    if (page >= 1 && (!pagination || page <= pagination.totalPages)) {
      setCurrentPage(page);
    }
  };

  const goToCashPage = (page: number) => {
    if (page >= 1 && (!cashPagination || page <= cashPagination.totalPages)) {
      setCashCurrentPage(page);
    }
  };

  const getSelectedBrokerageAccountId = () => {
    if (selectedAccountIds.length === 0) return undefined;
    return selectedAccountIds[0];
  };

  // Get selectable investment accounts (brokerage and standalone), sorted
  // alphabetically by name. Without an explicit sort the dropdown order follows
  // whatever order the API returned the accounts in, which can shift between
  // loads and makes the selection dropdown appear to reorder at random.
  // filter() returns a fresh array, so sorting it in place does not mutate state.
  const selectableAccounts = accounts
    .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    // Accounts
    accounts, allAccounts, selectedAccountIds, selectableAccounts,
    handleAccountChange,

    // Portfolio
    portfolioSummary, isLoading,
    loadAllPortfolioData, refreshAfterWrite, writeRefreshKey,

    // Brokerage transactions
    transactions, pagination, currentPage,
    transactionFilters, handleFiltersChange,
    handleDeleteTransaction, handleNewTransaction, handleEditTransaction, handleFormSuccess,
    handleFormCreateAndNew,
    handleSecurityClick, goToPage,

    // Transaction form modal
    showTransactionForm, editingTransaction,
    close, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef,
    getSelectedBrokerageAccountId,

    // Price refresh
    isRefreshingPrices, lastPriceUpdate, handleRefreshPrices,

    // Cash transactions
    cashAccountIds, cashTransactions, cashPagination, cashCurrentPage,
    cashTransactionsLoading, cashStartingBalance, cashPayees, cashCategories,
    cashFilters, setCashFilters,
    showCashFilters, setShowCashFilters,
    hasActiveCashFilters, activeCashFilterCount,
    handleEditCashTransaction, handleCashTransactionUpdate, handleCashFormSuccess,
    handleCashFormCreateAndNew,
    clearCashFilters,
    goToCashPage, handleCashClick,
    loadCashFilterData, loadCashTransactionsIfNeeded,
    setCashCurrentPage,
    openCashCreate,

    // Cash form modal
    showCashForm, editingCashTransaction, closeCash,
    cashModalProps, setCashFormDirty, cashUnsavedChangesDialog, cashFormSubmitRef,
  };
}
