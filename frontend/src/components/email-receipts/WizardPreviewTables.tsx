'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { WizardKind } from '@/components/email-receipts/profile-wizard-types';
import {
  PARSED_RECEIPT_REASONS,
  tradeActionMovesShares,
  type ParsedReceiptReason,
  type ParserPreviewItem,
  type ParserPreviewOutcome,
  type ParserPreviewResult,
} from '@/types/email-receipts';

/** The reasons a trade profile gives for a reading it could not complete (`ParsedTradeReason`). */
const TRADE_REASONS: readonly string[] = [
  'trade_no_action',
  'trade_no_symbol',
  'trade_no_quantity',
  'trade_no_amount',
  'trade_no_account',
  'trade_no_currency',
] as const;

const MUTED = 'text-gray-500 dark:text-gray-400';

/** An account a trade sample may book to, as the preview names it. */
export interface PreviewAccount {
  name: string;
  currencyCode: string;
}

/** The user's accounts by id; null while unknown (loading, failed, or a receipt preview, which names none). */
type PreviewAccounts = ReadonlyMap<string, PreviewAccount> | null;

/** The account a trade reading books to, by name and currency; said to be unknown, never left blank, when it cannot be named. */
function TradeAccountLine({ accountId, accounts }: { accountId: string | null | undefined; accounts: PreviewAccounts }) {
  const t = useTranslations('emailReceipts.profileWizard.preview');
  // A server that predates the field says nothing about the account.
  if (accountId === undefined) return null;
  if (accountId === null) return <div className="text-xs text-amber-800 dark:text-amber-300">{t('parsedTradeNoAccount')}</div>;
  const account = accounts?.get(accountId);
  return (
    <div>
      {t('parsedTradeAccount', {
        account: account ? t('accountWithCurrency', { name: account.name, currency: account.currencyCode }) : t('accountUnknown'),
      })}
    </div>
  );
}

/** What the draft read from one email: date, total and the number of lines, each "not stated" when the email did not say. */
function ParsedCell({ item, accounts }: { item: ParserPreviewItem; accounts: PreviewAccounts }) {
  const t = useTranslations('emailReceipts.profileWizard.preview');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber } = useNumberFormat();
  const { formatShareQuantity } = useNumberFormat();
  const parsed = item.parsed;
  if (parsed === null) return <span className={MUTED}>{t('nothingRead')}</span>;
  // The server sends the total in money units; a total with no currency is shown as a bare number.
  const total =
    parsed.total === null
      ? t('notStated')
      : parsed.currency
        ? formatCurrency(parsed.total, parsed.currency)
        : formatNumber(parsed.total, 2);
  if (item.trade !== null) {
    // A trade profile: what the confirmation reports, the account it books to and
    // the trade's currency (the total is in it; a bare number when it is unknown).
    const currency = item.trade.currency ?? parsed.currency;
    const { action, symbol, quantity } = item.trade;
    // A cash dividend moves no shares, so its line needs no share count.
    const tradeLine =
      action === null || symbol === null || (quantity === null && tradeActionMovesShares(action))
        ? null
        : t('parsedTrade', {
            action,
            ...(quantity !== null ? { quantity: formatShareQuantity(quantity) } : {}),
            symbol,
          });
    return (
      <div className="space-y-0.5">
        {tradeLine === null ? <div className={MUTED}>{t('nothingRead')}</div> : <div>{tradeLine}</div>}
        <div>{t('parsedDate', { date: parsed.date === null ? t('notStated') : formatDate(parsed.date) })}</div>
        <div>{t('parsedTotal', { total })}</div>
        <TradeAccountLine accountId={item.trade.accountId} accounts={accounts} />
        {item.trade.currency !== undefined && (
          <div>{t('parsedTradeCurrency', { currency: currency ?? t('notStated') })}</div>
        )}
        {item.trade.consistent === false && <div className="text-xs text-amber-800 dark:text-amber-300">{t('tradeInconsistent')}</div>}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <div>{t('parsedDate', { date: parsed.date === null ? t('notStated') : formatDate(parsed.date) })}</div>
      <div>{t('parsedTotal', { total })}</div>
      <div className={`text-xs ${MUTED}`}>{t('parsedLines', { count: parsed.lineCount })}</div>
    </div>
  );
}

function EmailCell({ item }: { item: ParserPreviewItem }) {
  const { formatDateTime } = useDateFormat();
  return (
    <Td className="min-w-0 px-2 align-top break-words sm:px-4">
      <div className="font-medium">{item.subject}</div>
      <div className={`mt-0.5 text-xs ${MUTED}`}>{formatDateTime(item.effectiveDate)}</div>
    </Td>
  );
}

function OutcomeLabel({ outcome }: { outcome: ParserPreviewOutcome }) {
  const t = useTranslations('emailReceipts.profileWizard.preview.outcomes');
  return <>{t(outcome)}</>;
}

/** A parse reason the catalog names is shown in words; any other is shown as sent. */
function ReasonLabel({ reason }: { reason: string }) {
  const t = useTranslations('emailReceipts.parsed.reasons');
  const tTrade = useTranslations('emailReceipts.detail.reasons');
  if (TRADE_REASONS.includes(reason) || reason === 'no_link_key') return <>{tTrade(reason as 'trade_no_action' | 'no_link_key')}</>;
  const known = (PARSED_RECEIPT_REASONS as readonly string[]).includes(reason);
  return <>{known ? t(reason as ParsedReceiptReason) : reason}</>;
}

/** How the draft would end an email, with why when it could not read it completely; `trade` shows it as a pill. */
function OutcomeCell({ item, trade }: { item: ParserPreviewItem; trade: boolean }) {
  const done = item.outcome === 'trade' || item.outcome === 'matched';
  return (
    <>
      <div>
        {trade ? (
          <Badge variant={done ? 'green' : 'amber'}>
            <OutcomeLabel outcome={item.outcome} />
          </Badge>
        ) : (
          <OutcomeLabel outcome={item.outcome} />
        )}
      </div>
      {item.statusReason !== null && (
        <div className={`mt-0.5 text-xs ${MUTED}`}>
          <ReasonLabel reason={item.statusReason} />
        </div>
      )}
    </>
  );
}

/**
 * The two tables of the preview: the chosen samples (what was expected against what
 * the draft read, and whether they agree) and, only when there are any, the domain's
 * other emails (how the draft would read them and which transaction it would match).
 */
export function WizardPreviewTables({
  result,
  kind,
  accounts = null,
}: {
  result: ParserPreviewResult;
  kind: WizardKind;
  /** The user's accounts by id, for a trade preview; null while they are unknown. */
  accounts?: PreviewAccounts;
}) {
  const t = useTranslations('emailReceipts.profileWizard.preview');
  const { formatNumber } = useNumberFormat();
  // A trade profile's samples pay no bank transaction, so nothing is expected and
  // nothing can agree: the table says how each would end instead, so a reading
  // that would never propose (no account, no ticker) is not shown as a success.
  // The wizard's own kind decides, never the samples: a sample a guard stopped
  // before any reading comes back with no trade, and must not flip the columns.
  const tradeSamples = kind === 'trade';

  return (
    <div className="space-y-6">
      {result.selected.length > 0 && (
        <section aria-labelledby="wizard-preview-selected" className="space-y-2">
          <h3 id="wizard-preview-selected" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('selectedHeading')}
          </h3>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <Th className="px-2 sm:px-4">{t('columns.email')}</Th>
                  {!tradeSamples && <Th className="px-2 sm:px-4">{t('columns.expected')}</Th>}
                  <Th className="px-2 sm:px-4">{t('columns.parsed')}</Th>
                  <Th className="px-2 sm:px-4">{tradeSamples ? t('columns.outcome') : t('columns.agrees')}</Th>
                </tr>
              </thead>
              <tbody className={TABLE_BODY_CLASS}>
                {result.selected.map((item) => (
                  <tr key={item.receiptId}>
                    <EmailCell item={item} />
                    {!tradeSamples && (
                      <Td className="min-w-0 px-2 align-top break-words sm:px-4">
                        {item.expected ? item.expected.summary : <span className={MUTED}>{t('noExpectation')}</span>}
                      </Td>
                    )}
                    <Td className="px-2 align-top sm:px-4">
                      <ParsedCell item={item} accounts={accounts} />
                    </Td>
                    <Td className="px-2 align-top sm:px-4">
                      {tradeSamples ? (
                        <OutcomeCell item={item} trade />
                      ) : item.agrees === null ? (
                        <span className={MUTED}>{t('agreesUnknown')}</span>
                      ) : (
                        <Badge variant={item.agrees ? 'green' : 'red'}>{item.agrees ? t('agreesYes') : t('agreesNo')}</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {result.others.length > 0 && (
        <section aria-labelledby="wizard-preview-others" className="space-y-2">
          <h3 id="wizard-preview-others" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('othersHeading')}
          </h3>
          {result.othersTotal > result.others.length && (
            <p className={`text-xs ${MUTED}`}>
              {t('othersCapped', { shown: formatNumber(result.others.length, 0), total: formatNumber(result.othersTotal, 0) })}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <Th className="px-2 sm:px-4">{t('columns.email')}</Th>
                  <Th className="px-2 sm:px-4">{t('columns.outcome')}</Th>
                  <Th className="px-2 sm:px-4">{t('columns.parsed')}</Th>
                  <Th className="px-2 sm:px-4">{t('columns.matched')}</Th>
                </tr>
              </thead>
              <tbody className={TABLE_BODY_CLASS}>
                {result.others.map((item) => (
                  <tr key={item.receiptId}>
                    <EmailCell item={item} />
                    <Td className="px-2 align-top sm:px-4">
                      <OutcomeCell item={item} trade={tradeSamples || item.trade !== null} />
                    </Td>
                    <Td className="px-2 align-top sm:px-4">
                      <ParsedCell item={item} accounts={accounts} />
                    </Td>
                    <Td className="min-w-0 px-2 align-top break-words sm:px-4">
                      {item.match ? item.match.summary : <span className={MUTED}>{t('noMatch')}</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
