'use client';

import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import { ReportError } from '@/components/reports/ReportError';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { movementUnknownReason } from '@/components/calendar/CalendarDayCell';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { investmentsApi } from '@/lib/investments';
import { gainLossColor } from '@/lib/format';
import type {
  DailyMovementDetailResponse,
  SecurityDayMove,
} from '@/types/investment';

interface DailyMovementDialogProps {
  /** The day to break down, or null when the dialog is closed. */
  date: string | null;
  accountIds: readonly string[];
  displayCurrency?: string;
  onClose: () => void;
}

/**
 * One day of the Daily change layer, broken down by security.
 *
 * Read-only, and it reconciles: the rows are per-security price moves on the
 * position held at that day's close, and one remainder line carries everything
 * no close explains -- a dividend, a position first priced that day, cash
 * interest -- so the popup adds up to the number the cell shows (design
 * decision 10). Nothing here sums the rows to check; the server sent the
 * remainder, and a `null` one says a component was unknown.
 */
export function DailyMovementDialog({
  date,
  accountIds,
  displayCurrency,
  onClose,
}: DailyMovementDialogProps) {
  const t = useTranslations('calendar');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();

  const requestKey = JSON.stringify([date, [...accountIds].sort(), displayCurrency ?? '']);

  const detail = useReportData<DailyMovementDetailResponse | null>(
    async () => {
      if (date === null) return null;
      return investmentsApi.getDailyMovementDetail({
        date,
        accountIds: accountIds.length > 0 ? [...accountIds].join(',') : undefined,
        displayCurrency,
      });
    },
    [requestKey],
    { requestKey },
  );

  // The payload belongs to the day it was asked for; a dialog reopened on
  // another day shows nothing until that day's answer arrives.
  const data = detail.dataKey === requestKey ? detail.data : null;

  return (
    <Modal
      isOpen={date !== null}
      onClose={onClose}
      maxWidth="lg"
      padding="md"
      title={date === null ? '' : t('change.detailTitle', { date: formatDate(date) })}
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          {tc('close')}
        </Button>
      }
    >
      {detail.error !== null && data === null && (
        <ReportError message={t('errors.movementDetailFailed')} onRetry={detail.reload} />
      )}

      {detail.error === null && data === null && <LoadingSpinner />}

      {data !== null && <DailyMovementDetail detail={data} />}
    </Modal>
  );
}

function DailyMovementDetail({ detail }: { detail: DailyMovementDetailResponse }) {
  const t = useTranslations('calendar');
  const { formatCurrency, formatPercent } = useNumberFormat();

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t('change.headline')}
        </span>
        {detail.complete && detail.movement !== null && detail.movementPercent !== null ? (
          <span
            className={`text-lg font-semibold tabular-nums ${
              detail.movementPercent === 0
                ? 'text-gray-500 dark:text-gray-400'
                : gainLossColor(detail.movementPercent)
            }`}
            data-testid="movement-headline"
          >
            {t('change.headlineValue', {
              amount: formatCurrency(detail.movement, detail.currencyCode),
              percent: formatPercent(detail.movementPercent),
            })}
          </span>
        ) : (
          // The same mapping the cell's marker uses: one writer for "which
          // repair does a withheld movement point at".
          <UnknownAmount reason={movementUnknownReason(detail.reasons)} />
        )}
      </div>

      {!detail.complete && detail.reasons.length > 0 && (
        <ul className="space-y-1 text-xs text-gray-600 dark:text-gray-300">
          {detail.reasons.map((reason) => (
            <li key={reason}>{t(`change.reasons.${reason}`)}</li>
          ))}
        </ul>
      )}

      <MoveSection
        title={t('change.gains')}
        rows={detail.gains}
        currencyCode={detail.currencyCode}
      />
      <MoveSection
        title={t('change.losses')}
        rows={detail.losses}
        currencyCode={detail.currencyCode}
      />

      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t('change.unchanged', { count: detail.unchangedCount })}
      </p>

      <div className="flex items-baseline justify-between gap-2 border-t border-gray-200 pt-2 dark:border-gray-700">
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t('change.remainder')}
        </span>
        {detail.remainder === null ? (
          <UnknownAmount reason={movementUnknownReason(detail.reasons)} />
        ) : (
          <span className="text-sm tabular-nums text-gray-900 dark:text-gray-100">
            {formatCurrency(detail.remainder, detail.currencyCode)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One side of the breakdown, in the order the server sent it.
 *
 * Re-sorting here would be a second opinion about what "largest mover" means,
 * and the server already answered it by the money each row moved.
 */
function MoveSection({
  title,
  rows,
  currencyCode,
}: {
  title: string;
  rows: readonly SecurityDayMove[];
  currencyCode: string;
}) {
  const t = useTranslations('calendar');
  const { formatCurrency, formatNumber, formatPercent, formatShareQuantity } =
    useNumberFormat();

  if (rows.length === 0) return null;

  return (
    <section>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {title}
      </h4>
      <ul className={TABLE_BODY_CLASS}>
        {rows.map((row) => (
          <li key={row.securityId} className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="min-w-0">
              <span className="block truncate text-sm text-gray-900 dark:text-gray-100">
                {row.symbol}
              </span>
              <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                {t('change.row', {
                  quantity: formatShareQuantity(row.quantity),
                  // A price is not money: it is printed at the precision it was
                  // struck at, in the security's own currency.
                  from: formatNumber(row.previousClose, 4),
                  to: formatNumber(row.close, 4),
                  currency: row.currencyCode,
                })}
              </span>
            </span>
            <span className="shrink-0 text-right">
              {row.change === null ? (
                <UnknownAmount reason="displayFx" />
              ) : (
                <span
                  className={`block text-sm tabular-nums ${gainLossColor(row.change)}`}
                >
                  {formatCurrency(row.change, currencyCode)}
                </span>
              )}
              {row.changePercent !== null && (
                <span className="block text-xs tabular-nums text-gray-500 dark:text-gray-400">
                  {formatPercent(row.changePercent)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
