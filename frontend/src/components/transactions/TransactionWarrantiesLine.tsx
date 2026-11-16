'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { WarrantyStatusBadge } from '@/components/warranties/WarrantyStatusBadge';
import { useDateFormat } from '@/hooks/useDateFormat';
import { createLogger } from '@/lib/logger';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { warrantiesApi } from '@/lib/warranties';
import type { Transaction } from '@/types/transaction';
import type { Warranty } from '@/types/warranty';
import { rowHasWarranties } from './WarrantyBadge';

const logger = createLogger('TransactionWarrantiesLine');

const ROW_CLASS =
  'flex min-w-0 items-center gap-3 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/** The answer for one transaction id, so a reply for another is never shown. */
type LoadState =
  | { transactionId: string; warranties: Warranty[] }
  | { transactionId: string; failed: true };

interface TransactionWarrantiesLineProps {
  /** The saved transaction, or none on a new one, which has no warranties yet. */
  transaction?: Pick<Transaction, 'id' | 'warrantyCount'>;
  /**
   * Opens the Warranties page's form prefilled from this transaction. The form
   * owns what happens first: an edit leaves through the host's close, which
   * asks about unsaved edits; a new transaction is saved before anything
   * leaves. Without it the line offers no Add.
   */
  onAddWarranty?: () => void;
  /** Add is under way (a new transaction is being saved first). */
  isAdding?: boolean;
  /**
   * Opens one warranty's detail page, through the host's close-then-navigate
   * like `onAddWarranty`. A bare link cannot: this line sits in a
   * `pushHistory` Modal, whose unmount pops its history entry and so undoes
   * the link's navigation, landing back on the host page. Without it each
   * warranty is listed as text, never as a link that would be undone.
   */
  onOpenWarranty?: (warrantyId: string) => void;
}

/** A click the browser should handle itself: a new tab or window, a download. */
function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * The Warranties line in the transaction edit form: the warranties linked to
 * this purchase, each a link to its detail page, and an "Add warranty" button,
 * both of which the host turns into its close-then-navigate. A link keeps its
 * `href`, so a middle-click or "open in new tab" still opens the warranty; a
 * plain click goes through `onOpenWarranty`. The line lists warranties only
 * (name, status, expiry); their documents are in the Attachments section. The list is fetched only when
 * the register row says the transaction has any (`warrantyCount`); with none
 * nothing is fetched and the line says there are none yet, as it does when the
 * fetch comes back empty.
 */
export function TransactionWarrantiesLine({ transaction, onAddWarranty, isAdding, onOpenWarranty }: TransactionWarrantiesLineProps) {
  const t = useTranslations('transactions');
  const { formatDate } = useDateFormat();
  const fetchId = transaction !== undefined && rowHasWarranties(transaction) ? transaction.id : null;
  const shouldFetch = fetchId !== null;
  const [loaded, setLoaded] = useState<LoadState | null>(null);

  useEffect(() => {
    if (fetchId === null) return;
    let cancelled = false;
    warrantiesApi
      .list({ transactionId: fetchId })
      .then((result) => {
        if (!cancelled) setLoaded({ transactionId: fetchId, warranties: result.data });
      })
      .catch((error) => {
        logger.error('Failed to load the transaction warranties:', error);
        if (!cancelled) setLoaded({ transactionId: fetchId, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchId]);

  const current = shouldFetch && loaded?.transactionId === fetchId ? loaded : null;

  return (
    <div className="space-y-2" data-testid="transaction-warranties" {...tourAnchor(TOUR_ANCHORS.transactionWarrantiesLine)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('form.warranties.title')}
        </span>
        {onAddWarranty && (
          <Button type="button" variant="outline" size="sm" isLoading={isAdding} onClick={onAddWarranty}>
            {t('form.warranties.add')}
          </Button>
        )}
      </div>
      {shouldFetch && current === null && (
        <p className="text-sm text-gray-500 dark:text-gray-400" role="status">
          {t('form.warranties.loading')}
        </p>
      )}
      {current !== null && 'failed' in current && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {t('form.warranties.loadError')}
        </p>
      )}
      {(!shouldFetch || (current !== null && 'warranties' in current && current.warranties.length === 0)) && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('form.warranties.empty')}</p>
      )}
      {current !== null && 'warranties' in current && current.warranties.length > 0 && (
        <ul className="space-y-2">
          {current.warranties.map((warranty) => {
            // Laid out as the Attachments rows above it are: an icon tile,
            // the name over its expiry, and the status at the end.
            const content = (
              <>
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gray-100 dark:bg-gray-700"
                >
                  <ShieldCheckIcon className="h-5 w-5 text-gray-500 dark:text-gray-400" />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block break-words text-sm ${
                      onOpenWarranty
                        ? 'text-blue-600 hover:underline dark:text-blue-400'
                        : 'text-gray-900 dark:text-gray-100'
                    }`}
                  >
                    {warranty.name}
                  </span>
                  {!warranty.isLifetime && warranty.expiresOn !== null && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t('form.warranties.expires', { date: formatDate(warranty.expiresOn) })}
                    </span>
                  )}
                </span>
                <span className="shrink-0">
                  <WarrantyStatusBadge warranty={warranty} />
                </span>
              </>
            );
            return (
              <li
                key={warranty.id}
                className="rounded-md border border-gray-200 p-2 dark:border-gray-700"
              >
                {onOpenWarranty ? (
                  <Link
                    href={`/warranties/${warranty.id}`}
                    onClick={(event) => {
                      if (event.defaultPrevented || isModifiedClick(event)) return;
                      event.preventDefault();
                      onOpenWarranty(warranty.id);
                    }}
                    className={ROW_CLASS}
                  >
                    {content}
                  </Link>
                ) : (
                  <span className={ROW_CLASS}>{content}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
