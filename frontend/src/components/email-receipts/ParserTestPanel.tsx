'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MatchTraceView } from '@/components/email-receipts/MatchTraceView';
import { ParsedReceiptView } from '@/components/email-receipts/ParsedReceiptView';
import { ParserTraceList } from '@/components/email-receipts/ParserTraceList';
import { TradeReadingView } from '@/components/email-receipts/TradeReadingView';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useDateFormat } from '@/hooks/useDateFormat';
import type { ReceiptParserAccountOption } from '@/hooks/useReceiptParserLookups';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type {
  EmailReceiptListItem,
  EmailReceiptParserTestResult,
  ReceiptParserDefinition,
} from '@/types/email-receipts';

const logger = createLogger('ReceiptParserTest');

/** How many stored emails the picker offers (the list's own default page). */
const RECEIPT_CHOICES = 50;

interface ParserTestPanelProps {
  /** The definition as the form or the JSON editor holds it now, saved or not; null when the JSON does not parse. */
  definition: ReceiptParserDefinition | null;
  payeeId: string;
  /** A stored email to preselect, such as the one the parser is being written for. */
  initialReceiptId?: string;
  categoryLabels: ReadonlyMap<string, string>;
  /** The user's accounts, so a trade profile's test names the account it would book to. */
  accounts?: readonly ReceiptParserAccountOption[];
}

/**
 * Reads a stored email with the definition on the form (`POST
 * /email-receipt-parsers/test`, which writes nothing) and shows what the parser
 * found and which transaction the matcher would pick. The definition is read
 * when Test is pressed, so the answer is always about what is on screen at that
 * moment; an earlier result is cleared as soon as the choice of email changes.
 */
export function ParserTestPanel({ definition, payeeId, initialReceiptId, categoryLabels, accounts }: ParserTestPanelProps) {
  const t = useTranslations('emailReceipts.test');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  // null while loading or failed: "no stored emails" is a claim only a loaded,
  // empty list can make.
  const [receipts, setReceipts] = useState<EmailReceiptListItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [receiptId, setReceiptId] = useState(initialReceiptId ?? '');
  const [isTesting, setIsTesting] = useState(false);
  const [result, setResult] = useState<EmailReceiptParserTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.receipts
      .list(undefined, RECEIPT_CHOICES)
      .then((list) => {
        if (!cancelled) setReceipts(list);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.error(err);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(
    () => [
      { value: '', label: t('choosePlaceholder') },
      ...(receipts ?? []).map((receipt) => ({
        value: receipt.id,
        label: t('receiptOption', {
          subject: receipt.subject,
          sender: receipt.fromAddress,
          date: formatDate(receipt.effectiveDate),
        }),
      })),
    ],
    [receipts, t, formatDate],
  );

  const handleTest = async () => {
    if (receiptId === '' || definition === null) return;
    setIsTesting(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await emailReceiptsApi.parsers.test({
          definition,
          receiptId,
          ...(payeeId !== '' ? { payeeId } : {}),
        }),
      );
    } catch (err) {
      setError(getErrorMessage(err, t('failed')));
    } finally {
      setIsTesting(false);
    }
  };

  const match = result?.match;
  const testedReceipt = receipts?.find((receipt) => receipt.id === receiptId);

  return (
    <section aria-labelledby="parser-test-heading" className="space-y-3">
      <div>
        <h3 id="parser-test-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('heading')}
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('help')}</p>
      </div>

      {loadFailed && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('loadFailed')}
        </p>
      )}
      {receipts !== null && receipts.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('noReceipts')}</p>
      )}

      {receipts !== null && receipts.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Select
              id="parser-test-receipt"
              label={t('receiptLabel')}
              value={receiptId}
              options={options}
              onChange={(e) => {
                setReceiptId(e.target.value);
                setResult(null);
                setError(null);
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            isLoading={isTesting}
            disabled={receiptId === '' || definition === null}
            onClick={() => void handleTest()}
          >
            {t('button')}
          </Button>
        </div>
      )}

      {definition === null && <p className="text-sm text-gray-500 dark:text-gray-400">{t('jsonInvalid')}</p>}

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          {result.outcome !== undefined && result.outcome !== 'read' && (
            <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              {t(`outcome.${result.outcome}`)}
            </p>
          )}
          {result.trade ? (
            // A trade profile creates an investment transaction: there is no bank transaction to match.
            <>
              <TradeReadingView
                trade={result.trade.parsed}
                fallbackDate={testedReceipt?.effectiveDate ?? null}
                accounts={accounts}
                showReason
              />
              {result.trade.trace && <ParserTraceList trace={result.trade.trace} />}
            </>
          ) : (
            <>
              <ParsedReceiptView parsed={result.parsed} categoryLabels={categoryLabels} parts={result.links} />
              {result.trace && <ParserTraceList trace={result.trace} />}
              {result.component ? (
                // A component is stored, never matched to a transaction: it says which settlements wait for it.
                (result.outcome === undefined || result.outcome === 'read') && (
                  <div role="status" className="text-sm text-gray-700 dark:text-gray-300">
                    <p className="font-medium text-gray-900 dark:text-gray-100">
                      {result.component.linkKey === null
                        ? t('component.noLinkKey')
                        : t('component.heading', { linkKey: result.component.linkKey })}
                    </p>
                    {result.component.linkKey !== null &&
                      (result.component.waitingSettlements.length === 0 ? (
                        <p>{t('component.noneWaiting')}</p>
                      ) : (
                        <>
                          <p>{t('component.waiting', { count: result.component.waitingSettlements.length })}</p>
                          <ul className="ml-4 list-disc break-words">
                            {result.component.waitingSettlements.map((settlement) => (
                              <li key={settlement.id}>
                                {t('component.settlement', { subject: settlement.subject, date: formatDate(settlement.effectiveDate) })}
                              </li>
                            ))}
                          </ul>
                        </>
                      ))}
                  </div>
                )
              ) : (
                <>
                  <div role="status" className="text-sm text-gray-700 dark:text-gray-300">
                    <p className="font-medium text-gray-900 dark:text-gray-100">{t('matchHeading')}</p>
                    {match?.kind === 'matched' && result.transaction && (
                      <p>
                        {t('matched', {
                          date: formatDate(result.transaction.date),
                          amount: formatCurrency(result.transaction.amount),
                          payee: result.transaction.payeeName ?? t('noPayee'),
                          how: t(`matchKinds.${match.matchKind}`),
                        })}
                      </p>
                    )}
                    {match?.kind === 'ambiguous' && <p>{t('ambiguous', { count: match.candidateIds.length })}</p>}
                    {match?.kind === 'unmatched' && <p>{t('unmatched', { count: result.candidateCount })}</p>}
                  </div>
                  {result.matchTrace && <MatchTraceView trace={result.matchTrace} />}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
