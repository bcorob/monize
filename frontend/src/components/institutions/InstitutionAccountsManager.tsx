'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Combobox } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Institution } from '@/types/institution';
import { Account } from '@/types/account';
import { institutionsApi } from '@/lib/institutions';
import { accountsApi } from '@/lib/accounts';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { isInvestmentCashHalf } from '@/lib/account-utils';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { InstitutionLogo } from './InstitutionLogo';

const logger = createLogger('InstitutionAccountsManager');

interface InstitutionAccountsManagerProps {
  institution: Institution | null;
  isOpen: boolean;
  onClose: () => void;
  /** Notified after an account is added or removed so counts can refresh. */
  onChanged?: () => void;
}

export function InstitutionAccountsManager({
  institution,
  isOpen,
  onClose,
  onChanged,
}: InstitutionAccountsManagerProps) {
  const t = useTranslations('institutions');
  const mainAccountName = useMainAccountName();
  const router = useRouter();
  const [assigned, setAssigned] = useState<Account[]>([]);
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [filterStatus, setFilterStatus] = useState<'active' | 'closed' | ''>('');

  // Opening the manager for an institution starts a read: show it as loading
  // from this render on ("info from previous render"), not from the effect.
  const requestFor = isOpen ? institution : null;
  const [loadingFor, setLoadingFor] = useState<Institution | null>(null);
  if (loadingFor !== requestFor) {
    setLoadingFor(requestFor);
    if (requestFor) setIsLoading(true);
  }

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const load = useCallback(() => {
    const run = async () => {
      if (!institution) return;
      try {
        const [assignedData, all] = await Promise.all([
          institutionsApi.getAccounts(institution.id),
          accountsApi.getAll(true),
        ]);
        setAssigned(assignedData);
        setAllAccounts(all);
      } catch (error) {
        toast.error(getErrorMessage(error, t('accountsManager.loadFailed')));
        logger.error(error);
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [institution, t]);

  // Every read after a change shows the spinner, as the first one does.
  const reload = useCallback(() => {
    if (!institution) return Promise.resolve();
    setIsLoading(true);
    return load();
  }, [institution, load]);

  useEffect(() => {
    if (isOpen && institution) {
      load();
    }
  }, [isOpen, institution, load]);

  const assignedIds = useMemo(
    () => new Set(assigned.map((a) => a.id)),
    [assigned],
  );

  // Collapse a linked brokerage/cash investment pair into a single entity by
  // dropping the cash half; assigning or removing the brokerage carries its
  // partner along, so only the main account is shown.
  const assignedMain = useMemo(
    () => assigned.filter((a) => !isInvestmentCashHalf(a)),
    [assigned],
  );

  // Apply the active/closed status filter to the collapsed account list.
  const visibleAccounts = useMemo(() => {
    if (!filterStatus) return assignedMain;
    return assignedMain.filter((a) =>
      filterStatus === 'active' ? !a.isClosed : a.isClosed,
    );
  }, [assignedMain, filterStatus]);

  const availableOptions = useMemo(
    () =>
      allAccounts
        .filter((a) => !assignedIds.has(a.id) && !isInvestmentCashHalf(a))
        .map((a) => ({
          value: a.id,
          label: mainAccountName(a.name),
        })),
    [allAccounts, assignedIds, mainAccountName],
  );

  // Close the modal and jump to the Transactions page filtered to the account.
  // For a closed account, force the Show Accounts filter to All so its
  // transactions aren't hidden by an Active-only filter.
  const handleViewTransactions = (account: Account) => {
    onClose();
    const params = new URLSearchParams({ accountId: account.id });
    if (account.isClosed) params.set('accountStatus', 'all');
    router.push(`/transactions?${params.toString()}`);
  };

  const handleAdd = async (accountId: string) => {
    if (!institution || !accountId) return;
    setBusyId(accountId);
    try {
      await institutionsApi.assignAccount(institution.id, accountId);
      setSelectedAccountId('');
      await reload();
      onChanged?.();
      toast.success(t('accountsManager.added'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('accountsManager.addFailed')));
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (accountId: string) => {
    if (!institution) return;
    setBusyId(accountId);
    try {
      await institutionsApi.unassignAccount(institution.id, accountId);
      await reload();
      onChanged?.();
      toast.success(t('accountsManager.removed'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('accountsManager.removeFailed')));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="lg"
      className="p-6"
      title={
        institution ? (
          <span className="flex items-center gap-3 min-w-0">
            {/* The logo's alt text is the institution's name, which the
                title already says: hidden so the dialog's name reads once. */}
            <span aria-hidden="true" className="shrink-0 inline-flex">
              <InstitutionLogo institution={institution} size={32} fallbackGlyph="$" />
            </span>
            <span className="truncate" title={t('accountsManager.title', { name: institution.name })}>
              {t('accountsManager.title', { name: institution.name })}
            </span>
          </span>
        ) : undefined
      }
    >
      {isLoading ? (
        <LoadingSpinner text={t('accountsManager.loading')} />
      ) : assignedMain.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
          {t('accountsManager.empty')}
        </p>
      ) : (
        <>
          {/* Active/Closed status filter */}
          <div className="mb-3 inline-flex rounded-md shadow-sm">
            <button
              type="button"
              onClick={() => setFilterStatus('')}
              className={`px-3 py-1.5 text-sm font-medium rounded-l-md border ${
                filterStatus === ''
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('accountsManager.filter.all')}
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('active')}
              className={`px-3 py-1.5 text-sm font-medium border-t border-b ${
                filterStatus === 'active'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('accountsManager.filter.active')}
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('closed')}
              className={`px-3 py-1.5 text-sm font-medium rounded-r-md border ${
                filterStatus === 'closed'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('accountsManager.filter.closed')}
            </button>
          </div>

          {visibleAccounts.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
              {t('accountsManager.noneMatch')}
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
              {visibleAccounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center justify-between px-3 py-2 gap-3"
                >
                  <button
                    type="button"
                    onClick={() => handleViewTransactions(account)}
                    title={t('accountsManager.viewTransactions')}
                    className="text-sm text-left text-blue-600 dark:text-blue-400 hover:underline truncate"
                  >
                    {mainAccountName(account.name)}
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === account.id}
                    onClick={() => handleRemove(account.id)}
                  >
                    {t('accountsManager.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mt-6">
        <Combobox
          label={t('accountsManager.addLabel')}
          placeholder={t('accountsManager.addPlaceholder')}
          options={availableOptions}
          value={selectedAccountId}
          usePortal
          openOnFocus={false}
          onChange={(value) => {
            if (value) handleAdd(value);
          }}
        />
        {availableOptions.length === 0 && !isLoading && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('accountsManager.noneToAdd')}
          </p>
        )}
      </div>

      <div className="mt-6 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          {t('accountsManager.done')}
        </Button>
      </div>
    </Modal>
  );
}
