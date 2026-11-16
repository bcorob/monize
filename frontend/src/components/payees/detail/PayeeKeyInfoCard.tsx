'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { externalUrlLabel, toSafeExternalUrl } from '@/lib/external-url';
import { mailtoHref, mapsUrl, telHref } from '@/lib/contact-links';
import { formatPhoneForDisplay } from '@/lib/phone-number';
import { useMapProvider } from '@/hooks/useMapProvider';
import { useContactLookupAvailable } from '@/hooks/useContactLookupAvailable';
import { usePayeeContactLookup } from '@/hooks/usePayeeContactLookup';
import { ContactLookupDialog } from '../ContactLookupDialog';
import type { PayeeDetail } from '@/types/payee';

interface PayeeKeyInfoCardProps {
  detail: PayeeDetail;
  /**
   * Hierarchical category labels ("Parent: Child"), so the default category
   * reads the same here as it does in the payee list and the filter dropdowns.
   * A bare leaf name is ambiguous -- several parents can own a "Fees".
   */
  categoryLabelMap: Map<string, string>;
  /** Narrow the register to one day (for the largest transaction). */
  onSelectDate: (date: string) => void;
  /** Open an account's detail page (for the overpayment designation). */
  onSelectAccount: (accountId: string) => void;
  /**
   * Called after an on-demand contact lookup wrote to the payee, so the page
   * reloads the detail it is rendering from.
   */
  onContactLookedUp?: () => void | Promise<void>;
}

/**
 * The reference facts about the payee, beside the chart. Rows without a value
 * are dropped by `KeyValueList`, so a fresh payee shows a short list rather
 * than a column of dashes.
 */
export function PayeeKeyInfoCard({
  detail,
  categoryLabelMap,
  onSelectDate,
  onSelectAccount,
  onContactLookedUp,
}: PayeeKeyInfoCardProps) {
  const t = useTranslations('payeeDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber } = useNumberFormat();
  const mapProvider = useMapProvider();
  // The lookup runs on the user's AI provider, so without one there is nothing
  // behind the button: it is not offered rather than offered and refused.
  const { available: lookupAvailable } = useContactLookupAvailable();
  const lookup = usePayeeContactLookup({ onApplied: () => onContactLookedUp?.() });

  const { payee, stats, largestTransaction, overpaymentForAccounts } = detail;

  const websiteUrl = toSafeExternalUrl(payee.website);
  // Each contact value is turned into a link by its own guard, and a value the
  // guard rejects still renders as text rather than disappearing -- a stored
  // "call the shop" is worth showing even though it cannot be dialled.
  const addressLink = payee.address
    ? mapsUrl({ address: payee.address, provider: mapProvider })
    : null;
  const phoneLink = telHref(payee.phone);
  // Stored as E.164; shown the way a person reads a number. A legacy value that
  // predates normalization comes back unchanged rather than blanked.
  const phoneDisplay = formatPhoneForDisplay(payee.phone);
  const emailLink = mailtoHref(payee.email);

  const rows: KeyValueRow[] = [
    {
      key: 'defaultCategory',
      label: t('keyInfo.defaultCategory'),
      // The map wins over the relation's own name: it carries the parent, and
      // the relation only ever holds the leaf.
      value: payee.defaultCategoryId
        ? (categoryLabelMap.get(payee.defaultCategoryId) ??
          payee.defaultCategory?.name ??
          null)
        : null,
    },
    {
      key: 'status',
      label: t('keyInfo.status'),
      value: payee.isActive ? t('keyInfo.active') : t('keyInfo.inactive'),
    },
    {
      key: 'created',
      label: t('keyInfo.created'),
      value: payee.createdAt ? formatDate(payee.createdAt) : null,
    },
    {
      key: 'firstTransaction',
      label: t('keyInfo.firstTransaction'),
      value: stats.firstTransactionDate ? formatDate(stats.firstTransactionDate) : null,
    },
    {
      key: 'lastTransaction',
      label: t('keyInfo.lastTransaction'),
      value: stats.lastTransactionDate ? formatDate(stats.lastTransactionDate) : null,
    },
    {
      key: 'aliases',
      label: t('keyInfo.aliases'),
      value: stats.aliasCount > 0 ? formatNumber(stats.aliasCount, 0) : null,
    },
    {
      key: 'largestTransaction',
      label: t('keyInfo.largestTransaction'),
      value: largestTransaction ? (
        <button
          type="button"
          onClick={() => onSelectDate(largestTransaction.transactionDate)}
          className="text-right text-blue-600 hover:underline dark:text-blue-400"
        >
          {t('keyInfo.largestValue', {
            amount: formatCurrency(
              Math.abs(largestTransaction.amount),
              largestTransaction.currencyCode,
            ),
            date: formatDate(largestTransaction.transactionDate),
          })}
        </button>
      ) : null,
    },
    {
      key: 'overpaymentFor',
      label: t('keyInfo.overpaymentFor'),
      value:
        overpaymentForAccounts.length > 0 ? (
          <span className="inline-flex flex-wrap justify-end gap-x-2">
            {overpaymentForAccounts.map((account) => (
              <button
                key={account.accountId}
                type="button"
                onClick={() => onSelectAccount(account.accountId)}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {account.accountName}
              </button>
            ))}
          </span>
        ) : null,
    },
    {
      key: 'website',
      label: t('keyInfo.website'),
      value: websiteUrl ? (
        <a
          href={websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={websiteUrl}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          {externalUrlLabel(websiteUrl)}
        </a>
      ) : null,
    },
    {
      key: 'address',
      label: t('keyInfo.address'),
      value: payee.address ? (
        addressLink ? (
          <a
            href={addressLink}
            target="_blank"
            rel="noopener noreferrer"
            className="whitespace-pre-line text-blue-600 hover:underline dark:text-blue-400"
          >
            {payee.address}
          </a>
        ) : (
          <span className="whitespace-pre-line">{payee.address}</span>
        )
      ) : null,
    },
    {
      key: 'phone',
      label: t('keyInfo.phone'),
      value: payee.phone ? (
        phoneLink ? (
          <a
            href={phoneLink}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {phoneDisplay}
          </a>
        ) : (
          phoneDisplay
        )
      ) : null,
    },
    {
      key: 'email',
      label: t('keyInfo.email'),
      value: payee.email ? (
        emailLink ? (
          <a
            href={emailLink}
            className="break-all text-blue-600 hover:underline dark:text-blue-400"
          >
            {payee.email}
          </a>
        ) : (
          payee.email
        )
      ) : null,
    },
    {
      key: 'notes',
      label: t('keyInfo.notes'),
      value: payee.notes || null,
    },
  ];

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('keyInfo.title')}
        </h3>
        {lookupAvailable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void lookup.lookUp(payee)}
            disabled={lookup.lookingUp}
          >
            {lookup.lookingUp
              ? t('contactLookup.inProgress')
              : t('contactLookup.button')}
          </Button>
        )}
      </div>
      <KeyValueList rows={rows} />
      {lookup.target && (
        <ContactLookupDialog
          isOpen
          payee={lookup.target}
          suggestions={lookup.candidates}
          saving={lookup.saving}
          onCancel={lookup.dismiss}
          onConfirm={lookup.apply}
        />
      )}
    </div>
  );
}
