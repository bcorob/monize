'use client';

import { useEffect, useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/MultiSelect';
import { DateInput } from '@/components/ui/DateInput';
import { Pagination } from '@/components/ui/Pagination';
import { PortfolioSummaryCard } from '@/components/investments/PortfolioSummaryCard';
import { GroupedHoldingsList } from '@/components/investments/GroupedHoldingsList';
import { AssetAllocationChart } from '@/components/investments/AssetAllocationChart';
import { InvestmentTransactionList } from '@/components/investments/InvestmentTransactionList';
import { NewTransactionButton } from '@/components/investments/NewTransactionButton';
import { RefreshPricesButton } from '@/components/investments/RefreshPricesButton';
import { DensityLevel, nextDensity } from '@/hooks/useTableDensity';
import { InvestmentTransactionForm } from '@/components/investments/InvestmentTransactionForm';
import {
  InvestmentValueChart,
  INVESTMENT_CHART_REFRESH_EVENT,
} from '@/components/investments/InvestmentValueChart';
import { TransactionList } from '@/components/transactions/TransactionList';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useInvestmentData } from '@/hooks/useInvestmentData';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { Account } from '@/types/account';
import { buildAccountFilterLabel } from '@/lib/account-utils';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import {
  InvestmentViewToggle,
  type InvestmentTransactionView,
} from '@/components/investments/InvestmentViewToggle';
import { PAGE_SIZE } from '@/lib/constants';

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm').then(m => m.TransactionForm), { ssr: false });


export default function InvestmentsPage() {
  return (
    <ProtectedRoute>
      <InvestmentsContent />
    </ProtectedRoute>
  );
}

function InvestmentsContent() {
  const t = useTranslations('investments');
  const tc = useTranslations('common');
  const mainAccountName = useMainAccountName();
  const data = useInvestmentData();
  const { loadAllPortfolioData, selectedAccountIds, currentPage, transactionFilters } = data;
  const handleUndoRedo = useCallback(() => {
    loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
  }, [loadAllPortfolioData, selectedAccountIds, currentPage, transactionFilters]);
  useOnUndoRedo(handleUndoRedo);
  // An AI write (e.g. an investment transaction from the chat bubble) mutates
  // the same data as an undo/redo, so refresh the same way.
  useOnAiAction(handleUndoRedo);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-investments-density', 'normal');
  const [transactionView, setTransactionView] = useLocalStorage<InvestmentTransactionView>('monize-investments-transaction-view', 'brokerage');
  // Tracks whether the investment transaction form currently shows a currency
  // conversion section so the modal can be widened to fit it without scrolling.
  const [investmentFormNeedsConversion, setInvestmentFormNeedsConversion] = useState(false);

  // Load cash transactions when view changes
  useEffect(() => {
    data.loadCashTransactionsIfNeeded(transactionView);
  }, [transactionView, data.loadCashTransactionsIfNeeded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the modal-width tracking whenever the investment transaction modal
  // closes (via cancel, success, escape, backdrop, or back button) so reopening
  // it starts at the default width without a flicker.
  const { close: closeTransactionForm, handleFormSuccess } = data;

  const closeInvestmentTransactionModal = useCallback(() => {
    setInvestmentFormNeedsConversion(false);
    closeTransactionForm();
  }, [closeTransactionForm]);

  const handleInvestmentTransactionSuccess = useCallback(() => {
    setInvestmentFormNeedsConversion(false);
    handleFormSuccess();
  }, [handleFormSuccess]);

  // The Refresh button has two effects: (a) refresh security prices in the DB
  // (existing flow that drives daily snapshots and Portfolio Summary) and
  // (b) tell the InvestmentValueChart to drop its sessionStorage entry and
  // re-fetch when it's currently rendering an intraday range. The chart
  // itself decides whether the event applies based on its active range.
  //
  // Scope the price refresh to the holdings currently visible on screen:
  // when an account filter is active we only refresh the IDs that show up
  // in portfolioSummary.holdings instead of every active security in the
  // user's catalog. With no filter we leave scope undefined so the hook
  // refreshes all eligible securities.
  const handleRefreshClick = useCallback(async () => {
    window.dispatchEvent(new Event(INVESTMENT_CHART_REFRESH_EVENT));
    const scope =
      data.selectedAccountIds.length > 0
        ? [
            ...new Set(
              (data.portfolioSummary?.holdings ?? []).map((h) => h.securityId),
            ),
          ]
        : undefined;
    await data.handleRefreshPrices(scope);
  }, [data]);

  const handleTransactionViewChange = (view: InvestmentTransactionView) => {
    setTransactionView(view);
    if (view === 'cash') {
      data.setCashCurrentPage(1);
      if (data.cashPayees.length === 0 && data.cashCategories.length === 0) {
        data.loadCashFilterData();
      }
    }
  };

  // Build filter dropdown options
  const cashCategoryFilterOptions = useMemo((): MultiSelectOption[] => {
    const buildOptions = (parentId: string | null = null): MultiSelectOption[] => {
      return data.cashCategories
        .filter(c => c.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap(cat => {
          const children = buildOptions(cat.id);
          return [{
            value: cat.id,
            label: cat.name,
            parentId: cat.parentId,
            children: children.length > 0 ? children : undefined,
          }];
        });
    };
    return buildOptions();
  }, [data.cashCategories]);

  const cashPayeeFilterOptions = useMemo((): MultiSelectOption[] => {
    return data.cashPayees
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(payee => ({ value: payee.id, label: payee.name }));
  }, [data.cashPayees]);

  const cycleDensity = useCallback(() => {
    setListDensity(d => nextDensity(d));
  }, [setListDensity]);

  const { handleDeleteTransaction: deleteTransaction } = data;
  const handleDeleteTransaction = useCallback((id: string) => {
    void deleteTransaction(id);
  }, [deleteTransaction]);

  // Display name for account selector (strip the localized " - Brokerage" suffix)
  const getAccountDisplayName = useCallback(
    (account: Account) =>
      account.accountSubType === 'INVESTMENT_BROKERAGE'
        ? mainAccountName(account.name)
        : account.name,
    [mainAccountName],
  );

  // Summary/allocation/chart titles show which accounts the filter covers.
  const accountFilterLabel = useMemo(() => {
    return buildAccountFilterLabel(
      data.selectedAccountIds,
      data.selectableAccounts,
      (a) => getAccountDisplayName(a as Account),
      tc,
    );
  }, [data.selectedAccountIds, data.selectableAccounts, tc, getAccountDisplayName]);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="sm:px-0">
          <PageHeader
            title={t('page.title')}
            subtitle={t('page.subtitle')}
            helpUrl="https://github.com/kenlasko/monize/wiki/Investments"
            actions={
              <>
                <div className="flex items-stretch gap-3 w-full sm:w-auto">
                  <div className="flex-1 sm:flex-none sm:w-64 min-w-0">
                    <MultiSelect
                      value={data.selectedAccountIds}
                      onChange={data.handleAccountChange}
                      placeholder={t('page.allInvestmentAccounts')}
                      showSearch={false}
                      options={data.selectableAccounts.map((account: Account) => ({
                        value: account.id,
                        label: getAccountDisplayName(account),
                      }))}
                    />
                  </div>
                  <RefreshPricesButton
                    onClick={handleRefreshClick}
                    isRefreshing={data.isRefreshingPrices}
                    lastPriceUpdate={data.lastPriceUpdate}
                  />
                </div>
                <NewTransactionButton
                  onNewInvestment={data.handleNewTransaction}
                  onNewCash={data.openCashCreate}
                />
              </>
            }
          />

          {/* Summary and Allocation Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <PortfolioSummaryCard
              summary={data.portfolioSummary}
              isLoading={data.isLoading}
              singleAccountCurrency={
                data.selectedAccountIds.length === 1
                  ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                  : null
              }
              titleSuffix={accountFilterLabel}
            />
            <AssetAllocationChart
              allocation={data.portfolioSummary ? { allocation: data.portfolioSummary.allocation, totalValue: data.portfolioSummary.totalPortfolioValue } : null}
              isLoading={data.isLoading}
              singleAccountCurrency={
                data.selectedAccountIds.length === 1
                  ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                  : null
              }
              holdingsByAccount={data.portfolioSummary?.holdingsByAccount}
              titleSuffix={accountFilterLabel}
              accountIds={data.selectedAccountIds}
              valuationComplete={data.portfolioSummary?.valuationComplete}
            />
          </div>

          {/* Portfolio Value Over Time */}
          <div className="mb-6">
            <InvestmentValueChart
              accountIds={data.selectedAccountIds}
              displayCurrency={
                data.selectedAccountIds.length === 1
                  ? data.accounts.find(a => a.id === data.selectedAccountIds[0])?.currencyCode ?? null
                  : null
              }
              titleSuffix={accountFilterLabel}
            />
          </div>

          {/* Holdings List */}
          <div className="mb-6">
            <GroupedHoldingsList
              holdingsByAccount={data.portfolioSummary?.holdingsByAccount || []}
              isLoading={data.isLoading}
              totalPortfolioValue={data.portfolioSummary?.totalPortfolioValue || 0}
              valuationComplete={data.portfolioSummary?.valuationComplete}
              onSecurityClick={data.handleSecurityClick}
              onCashClick={data.handleCashClick}
            />
          </div>

          {/* Brokerage Transactions */}
          {transactionView === 'brokerage' && (
            <>
              <div>
                <InvestmentTransactionList
                  transactions={data.transactions}
                  accounts={data.accounts}
                  isLoading={data.isLoading}
                  onDelete={handleDeleteTransaction}
                  onEdit={data.handleEditTransaction}
                  onNewTransaction={data.handleNewTransaction}
                  onStatusChanged={data.handleFormCreateAndNew}
                  density={listDensity}
                  onDensityChange={setListDensity}
                  filters={data.transactionFilters}
                  onFiltersChange={data.handleFiltersChange}
                  availableSymbols={[...new Set(data.portfolioSummary?.holdings.map(h => h.symbol) || [])].sort()}
                  viewToggle={
                    <InvestmentViewToggle
                      value={transactionView}
                      onChange={handleTransactionViewChange}
                    />
                  }
                />
              </div>

              {data.pagination && data.pagination.totalPages > 1 && (
                <div className="mt-4">
                  <Pagination
                    currentPage={data.currentPage}
                    totalPages={data.pagination.totalPages}
                    totalItems={data.pagination.total}
                    pageSize={PAGE_SIZE}
                    onPageChange={data.goToPage}
                    itemName="transactions"
                  />
                </div>
              )}
              {data.pagination && data.pagination.totalPages <= 1 && data.pagination.total > 0 && (
                <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
                  {t('page.transactionCount', { count: data.pagination.total, plural: data.pagination.total !== 1 ? 's' : '' })}
                </div>
              )}
            </>
          )}

          {/* Cash Transactions */}
          {transactionView === 'cash' && (
            <>
            <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg">
              <div className="px-3 pt-3 sm:px-4 sm:pt-4 flex flex-wrap justify-between items-center gap-2">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t('page.recentTransactions')}
                    {data.hasActiveCashFilters && (
                      <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">{t('page.filtered')}</span>
                    )}
                  </h3>
                  <InvestmentViewToggle
                    value={transactionView}
                    onChange={handleTransactionViewChange}
                  />
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <button onClick={data.openCashCreate} className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 sm:min-w-[14rem]">
                    <span className="sm:hidden">{t('page.newCashTransactionShort')}</span>
                    <span className="hidden sm:inline">{t('page.newCashTransaction')}</span>
                  </button>
                  <button
                    onClick={() => data.setShowCashFilters(!data.showCashFilters)}
                    className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md ${
                      data.hasActiveCashFilters
                        ? 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30'
                        : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                    </svg>
                    {t('page.filter')}
                    {data.hasActiveCashFilters && (
                      <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-blue-600 rounded-full">{data.activeCashFilterCount}</span>
                    )}
                  </button>
                  <button onClick={cycleDensity} className="ml-auto inline-flex items-center px-2 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md" title={t('page.densityToggleTitle')}>
                    <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                    {listDensity === 'normal' ? t('page.densityNormal') : listDensity === 'compact' ? t('page.densityCompact') : t('page.densityDense')}
                  </button>
                </div>
              </div>

              {/* Cash Filter Bar */}
              {data.showCashFilters && (
                <div className="px-3 sm:px-4 py-3 bg-gray-50 dark:bg-gray-700/30 border-b border-gray-200 dark:border-gray-700">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <MultiSelect label={t('page.cashFilterPayees')} options={cashPayeeFilterOptions} value={data.cashFilterPayeeIds} onChange={(values) => { data.setCashFilterPayeeIds(values); data.setCashCurrentPage(1); }} placeholder={t('page.allPayees')} />
                    <MultiSelect label={t('page.cashFilterCategories')} options={cashCategoryFilterOptions} value={data.cashFilterCategoryIds} onChange={(values) => { data.setCashFilterCategoryIds(values); data.setCashCurrentPage(1); }} placeholder={t('page.allCategories')} />
                    <DateInput
                      label={t('page.cashFilterFrom')}
                      value={data.cashFilterStartDate}
                      onDateChange={(date) => { data.setCashFilterStartDate(date); data.setCashCurrentPage(1); }}
                      onChange={(e) => { data.setCashFilterStartDate(e.target.value); data.setCashCurrentPage(1); }}
                    />
                    <DateInput
                      label={t('page.cashFilterTo')}
                      value={data.cashFilterEndDate}
                      onDateChange={(date) => { data.setCashFilterEndDate(date); data.setCashCurrentPage(1); }}
                      onChange={(e) => { data.setCashFilterEndDate(e.target.value); data.setCashCurrentPage(1); }}
                    />
                  </div>
                  {data.hasActiveCashFilters && (
                    <div className="mt-3 flex justify-end">
                      <button onClick={data.clearCashFilters} className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium">{t('page.clearFilters')}</button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-3 sm:mt-4" />
              {data.cashTransactionsLoading && data.cashTransactions.length === 0 ? (
                <LoadingSpinner text={t('page.loadingCashTransactions')} />
              ) : (
                <TransactionList
                  transactions={data.cashTransactions}
                  onEdit={data.handleEditCashTransaction}
                  onRefresh={data.refreshCashTransactions}
                  onTransactionUpdate={data.handleCashTransactionUpdate}
                  density={listDensity}
                  onDensityChange={setListDensity}
                  currentPage={data.cashCurrentPage}
                  totalPages={data.cashPagination?.totalPages ?? 1}
                  totalItems={data.cashPagination?.total ?? 0}
                  pageSize={PAGE_SIZE}
                  onPageChange={data.goToCashPage}
                  startingBalance={data.cashAccountIds.length === 1 ? (data.cashStartingBalance ?? 0) : undefined}
                  isSingleAccountView={data.cashAccountIds.length === 1}
                  showToolbar={false}
                />
              )}
            </div>

              {data.cashPagination && data.cashPagination.totalPages > 1 && (
                <div className="mt-4">
                  <Pagination currentPage={data.cashCurrentPage} totalPages={data.cashPagination.totalPages} totalItems={data.cashPagination.total} pageSize={PAGE_SIZE} onPageChange={data.goToCashPage} itemName="transactions" />
                </div>
              )}
              {data.cashPagination && data.cashPagination.totalPages <= 1 && data.cashPagination.total > 0 && (
                <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
                  {t('page.transactionCount', { count: data.cashPagination.total, plural: data.cashPagination.total !== 1 ? 's' : '' })}
                </div>
              )}
            </>
          )}

          {/* Footer note for auto-generated symbols */}
          <div className="mt-8 pt-4 border-t border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {t('page.autoGeneratedSymbolNote')}
            </p>
          </div>
        </div>
      </main>

      {/* Transaction Form Modal */}
      <Modal
        isOpen={data.showTransactionForm}
        onClose={closeInvestmentTransactionModal}
        maxWidth={investmentFormNeedsConversion ? '3xl' : 'xl'}
        className="p-6"
        {...data.modalProps}
      >
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {data.editingTransaction ? t('page.editTransaction') : t('page.newInvestmentTransaction')}
        </h2>
        <InvestmentTransactionForm
          accounts={data.accounts}
          allAccounts={data.allAccounts}
          transaction={data.editingTransaction}
          defaultAccountId={data.getSelectedBrokerageAccountId()}
          onSuccess={handleInvestmentTransactionSuccess}
          onCreateAndNew={data.handleFormCreateAndNew}
          onCancel={closeInvestmentTransactionModal}
          onDirtyChange={data.setFormDirty}
          onConversionStateChange={setInvestmentFormNeedsConversion}
          submitRef={data.formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...data.unsavedChangesDialog} />

      {/* Cash Transaction Form Modal */}
      <Modal isOpen={data.showCashForm} onClose={data.closeCash} maxWidth="6xl" className="p-6" {...data.cashModalProps}>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {data.editingCashTransaction ? t('page.editTransaction') : t('page.newTransaction')}
        </h2>
        <TransactionForm
          key={data.editingCashTransaction?.id || 'new-cash'}
          transaction={data.editingCashTransaction}
          defaultAccountId={data.cashAccountIds.length > 0 ? data.cashAccountIds[0] : undefined}
          onSuccess={data.handleCashFormSuccess}
          onCreateAndNew={data.handleCashFormCreateAndNew}
          onCancel={data.closeCash}
          onDirtyChange={data.setCashFormDirty}
          submitRef={data.cashFormSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...data.cashUnsavedChangesDialog} />
    </PageLayout>
  );
}
