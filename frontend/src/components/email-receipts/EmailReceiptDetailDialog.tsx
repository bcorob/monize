'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { EmailBodyView } from '@/components/email-receipts/EmailBodyView';
import { TradeProposalView } from '@/components/email-receipts/TradeProposalView';
import { TradeReadingView } from '@/components/email-receipts/TradeReadingView';
import { ParsedReceiptView } from '@/components/email-receipts/ParsedReceiptView';
import { ReceiptTransactionPicker } from '@/components/email-receipts/ReceiptTransactionPicker';
import { ReceiptStateBadge } from '@/components/email-receipts/ReceiptStateBadge';
import { StructuredOrderView } from '@/components/email-receipts/StructuredOrderView';
import { useBookedTradeSummary } from '@/components/email-receipts/useBookedTradeSummary';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useDateFormat } from '@/hooks/useDateFormat';
import { toReceiptAccountOptions, type ReceiptParserAccountOption } from '@/hooks/useReceiptParserLookups';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { clearAllCache } from '@/lib/apiCache';
import { accountsApi } from '@/lib/accounts';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { canLinkTradeEmail, isReceiptActionable, readParsedReceipt } from '@/lib/email-receipts-format';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  readParsedTrade,
  tradeActionMovesShares,
  type EmailReceiptDetail,
  type EmailReceiptStatus,
} from '@/types/email-receipts';

const logger = createLogger('EmailReceiptDetail');

/** States in which the email has no transaction and no candidates to choose from. */
const PICKABLE_STATUSES: readonly EmailReceiptStatus[] = ['unmatched', 'no_parser', 'parse_failed'];

interface EmailReceiptDetailDialogProps {
  receiptId: string;
  /** Category id to label; `null` while the category list has not loaded. */
  categoryLabels: ReadonlyMap<string, string> | null;
  onClose: () => void;
  /** A change was written (a link): the list behind the dialog reloads. */
  onChanged: () => void;
  /** Open another receipt (a linked component, a settlement, the email that enriched a transaction); without it those rows name the email and offer no button. */
  onOpenReceipt?: (receiptId: string) => void;
}

type DetailState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; detail: EmailReceiptDetail };

/**
 * One stored email: who sent it, what state it is in and why, what the parser
 * read from it, and, when several transactions fit, which one to link it to.
 *
 * The email is hostile input. Its HTML is shown only in a sandboxed, script-less,
 * network-less frame (`EmailBodyView`), and its text as plain text in a `<pre>`;
 * neither is ever markup of this page. Mount it only while open and key it on the
 * receipt, so its state starts fresh for each one.
 */
export function EmailReceiptDetailDialog({ receiptId, categoryLabels, onClose, onChanged, onOpenReceipt }: EmailReceiptDetailDialogProps) {
  const t = useTranslations('emailReceipts.detail');
  const tState = useTranslations('emailReceipts.state');
  const tParsed = useTranslations('emailReceipts.parsed');
  const tc = useTranslations('common');
  const { formatDate, formatDateTime } = useDateFormat();
  const { formatCurrency, formatShareQuantity } = useNumberFormat();
  const bookedTradeSummary = useBookedTradeSummary();
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  // Bumped by the retry button; each value is one request.
  const [attempt, setAttempt] = useState(0);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    emailReceiptsApi.receipts
      .get(receiptId)
      .then((detail) => {
        if (!cancelled) setState({ status: 'ready', detail });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [receiptId, attempt]);

  // A trade reading names the account its rules chose, so two accounts the
  // broker prints alike (an RRSP in CAD and one in USD) can be told apart.
  // Closed accounts too, so a stored id is named. Until they load (or if they
  // fail) the reading shows no account name, never a wrong one.
  const tradeEmail = state.status === 'ready' && (state.detail.isTrade || state.detail.trade !== null);
  const [accounts, setAccounts] = useState<readonly ReceiptParserAccountOption[] | undefined>(undefined);
  useEffect(() => {
    if (!tradeEmail) return;
    let cancelled = false;
    accountsApi
      .getAll(true)
      .then((list) => {
        if (!cancelled) setAccounts(toReceiptAccountOptions(list));
      })
      .catch((error) => {
        if (!cancelled) logger.error(error);
      });
    return () => {
      cancelled = true;
    };
  }, [tradeEmail]);

  const handleLink = async (transactionId: string) => {
    setLinkingId(transactionId);
    setLinkError(null);
    try {
      const detail = await emailReceiptsApi.receipts.link(receiptId, transactionId);
      // Linking a trade email can mark the scheduled bill or deposit it pays as
      // paid: every cached read of the schedules (and what they feed) is stale.
      if (detail.isTrade) clearAllCache();
      setState({ status: 'ready', detail });
      toast.success(t('linked'));
      onChanged();
    } catch (error) {
      setLinkError(getErrorMessage(error, t('linkFailed')));
    } finally {
      setLinkingId(null);
    }
  };

  let body;
  if (state.status === 'error') {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={
            <Button
              onClick={() => {
                setState({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              {t('error.retry')}
            </Button>
          }
        />
      </div>
    );
  } else if (state.status === 'loading') {
    body = <LoadingSpinner text={t('loading')} />;
  } else {
    const { detail } = state;
    const parsed = readParsedReceipt(detail.parsed);
    const trade = readParsedTrade(detail.trade);
    // A trade email: a trade profile read it (`trade`), or it was handed to the AI
    // as a trade. Either way it books an investment transaction, never a bank one.
    const isTradeEmail = detail.isTrade || trade !== null;
    const readByAi = isTradeEmail && trade === null;
    // What the email's open `email_trade` request proposes, whoever wrote it: the
    // profile's own reading resolved to an account and a security, or the AI's
    // answer to "Recognize as a trade" (also for an email a profile read).
    const proposal = detail.tradeProposal ?? null;
    // A trade email is linked to the investment transaction it reports, even once it was
    // closed as already booked (that is when linking marks its scheduled bill paid), but
    // only once: an email linked or booked already accounts for its row. The
    // candidates of one that cannot be linked are not listed at all: its own row
    // would be among them.
    const tradeLinkable = isTradeEmail && canLinkTradeEmail(detail);
    const canLink = detail.candidates.length > 0 && (isTradeEmail ? tradeLinkable : isReceiptActionable(detail) && detail.status !== 'component');
    const booked = detail.investmentTransaction ?? null;
    // A cash dividend's candidates are dividends, whose share count says nothing (zero when none was given).
    const tradeAction = trade?.action ?? proposal?.action ?? null;
    const candidateSharesShown = tradeAction === null || tradeActionMovesShares(tradeAction);
    // An email the matcher could not tie to a transaction can be tied by hand.
    const canPick = !isTradeEmail && PICKABLE_STATUSES.includes(detail.status) && isReceiptActionable(detail);
    const enrichedBy = detail.status === 'review_conflict' && detail.statusReason === 'enriched_by_other' ? detail.enrichedBy : null;
    const openButton = (id: string, subject: string) =>
      onOpenReceipt && (
        <Button variant="outline" size="sm" aria-label={t('linkedReceipts.open', { subject })} onClick={() => onOpenReceipt(id)}>
          {t('linkedReceipts.openButton')}
        </Button>
      );
    const reasonKey = detail.statusReason ? `reasons.${detail.statusReason}` : null;

    body = (
      <div className="space-y-6">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">{t('from')}</dt>
            <dd className="break-words text-gray-900 dark:text-gray-100">{detail.fromAddress}</dd>
          </div>
          {detail.forwardedBy && (
            <div className="min-w-0">
              <dt className="text-gray-500 dark:text-gray-400">{t('forwardedBy')}</dt>
              <dd className="break-words text-gray-900 dark:text-gray-100">{detail.forwardedBy}</dd>
            </div>
          )}
          <div className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">{t('received')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">{formatDateTime(detail.receivedAt)}</dd>
          </div>
          {detail.originalSentAt && (
            <div className="min-w-0">
              <dt className="text-gray-500 dark:text-gray-400">{t('originalSent')}</dt>
              <dd className="text-gray-900 dark:text-gray-100">{formatDateTime(detail.originalSentAt)}</dd>
            </div>
          )}
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-gray-500 dark:text-gray-400">{t('subject')}</dt>
            <dd className="break-words text-gray-900 dark:text-gray-100">{detail.subject}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{t('state')}</dt>
            <dd>
              <ReceiptStateBadge receipt={detail} />
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{t('parser')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">
              {detail.parserName ??
                (readByAi ? t('aiTradeReader') : parsed?.source === 'schema_org' ? t('structuredSource') : t('noParser'))}
            </dd>
          </div>
          {detail.matchKind && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t('matchedBy')}</dt>
              <dd className="text-gray-900 dark:text-gray-100">{t(`matchKinds.${detail.matchKind}`)}</dd>
            </div>
          )}
          <div className="min-w-0">
            <dt className="text-gray-500 dark:text-gray-400">{t('transaction')}</dt>
            <dd className="text-gray-900 dark:text-gray-100">
              {isTradeEmail ? (
                booked ? (
                  <>
                    {bookedTradeSummary(booked)}{' '}
                    <Link
                      href={`/investments?edit=${booked.id}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {t('viewTransaction')}
                    </Link>
                  </>
                ) : (
                  <span className="text-gray-500 dark:text-gray-400">
                    {readByAi ? t('noAiTradeTransaction') : t('noTradeTransaction')}
                  </span>
                )
              ) : detail.transaction ? (
                <>
                  {t('transactionSummary', {
                    date: formatDate(detail.transaction.date),
                    amount: formatCurrency(detail.transaction.amount, detail.transaction.currencyCode),
                    payee: detail.transaction.payeeName ?? t('noPayee'),
                  })}{' '}
                  <Link
                    href={`/transactions?targetTransactionId=${detail.transaction.id}`}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {t('viewTransaction')}
                  </Link>
                </>
              ) : (
                <span className="text-gray-500 dark:text-gray-400">{t('noTransaction')}</span>
              )}
            </dd>
          </div>
        </dl>

        {(detail.statusReason || detail.requestNote) && (
          <div className="space-y-1 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
            {detail.statusReason && (
              <p className="text-gray-700 dark:text-gray-300">
                {reasonKey && t.has(reasonKey) ? t(reasonKey) : t('reasonUnknown', { reason: detail.statusReason })}
              </p>
            )}
            {detail.requestNote && (
              <p className="text-gray-700 dark:text-gray-300">
                {t('requestNote', { state: tState(detail.displayState ?? 'request_missing'), note: detail.requestNote })}
              </p>
            )}
          </div>
        )}

        {isTradeEmail ? (
          <section aria-labelledby="receipt-trade-heading" className="space-y-2">
            <h3 id="receipt-trade-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {trade ? t('tradeHeading') : t('aiTradeHeading')}
            </h3>
            {trade ? (
              <TradeReadingView trade={trade} fallbackDate={detail.effectiveDate} accounts={accounts} />
            ) : (
              <TradeProposalView proposal={proposal} booked={booked !== null} displayState={detail.displayState} />
            )}
            {trade && proposal && (
              <div className="space-y-2 border-t border-gray-200 pt-3 dark:border-gray-700">
                <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {detail.tradeRequestSource === 'ai' ? t('aiTradeHeading') : t('tradeProposalHeading')}
                </h4>
                <TradeProposalView proposal={proposal} booked={booked !== null} displayState={detail.displayState} />
              </div>
            )}
          </section>
        ) : (
          <>
            <section aria-labelledby="receipt-parsed-heading" className="space-y-2">
              <h3 id="receipt-parsed-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('parsedHeading')}
              </h3>
              {parsed ? (
                <ParsedReceiptView parsed={parsed} categoryLabels={categoryLabels} />
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('notParsed')}</p>
              )}
            </section>

            <section aria-labelledby="receipt-structured-heading" className="space-y-2">
              <h3 id="receipt-structured-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('structured.heading')}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('structured.help')}</p>
              <StructuredOrderView order={detail.structuredOrder ?? null} />
            </section>
          </>
        )}

        {detail.linkedComponents.length > 0 && (
          <section aria-labelledby="receipt-components-heading" className="space-y-2">
            <h3 id="receipt-components-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('linkedReceipts.componentsHeading')}
            </h3>
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {detail.linkedComponents.map((component) => (
                <li key={`${component.partIndex}-${component.receiptId}`} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 break-words text-gray-900 dark:text-gray-100">
                    {t('linkedReceipts.component', {
                      part: component.partIndex + 1,
                      subject: component.subject,
                      date: formatDate(component.effectiveDate),
                    })}
                  </div>
                  {openButton(component.receiptId, component.subject)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {detail.linkedSettlements.length > 0 && (
          <section aria-labelledby="receipt-settlements-heading" className="space-y-2">
            <h3 id="receipt-settlements-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('linkedReceipts.settlementsHeading')}
            </h3>
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {detail.linkedSettlements.map((settlement, index) => {
                const outcomeKey = `linkOutcomes.${settlement.outcome}`;
                return (
                  <li key={`${settlement.receiptId}-${index}`} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 break-words">
                      <div className="text-gray-900 dark:text-gray-100">
                        {t('linkedReceipts.settlement', {
                          subject: settlement.subject,
                          date: formatDate(settlement.effectiveDate),
                          amount: formatCurrency(settlement.partAmount),
                        })}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400">
                        {tParsed.has(outcomeKey) ? tParsed(outcomeKey) : settlement.outcome}
                      </div>
                    </div>
                    {openButton(settlement.receiptId, settlement.subject)}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {detail.candidates.length > 0 && (!isTradeEmail || tradeLinkable) && (
          <section aria-labelledby="receipt-candidates-heading" className="space-y-2">
            <h3 id="receipt-candidates-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {isTradeEmail ? t('tradeCandidatesHeading') : t('candidatesHeading')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {isTradeEmail ? t('tradeCandidatesHelp') : t('candidatesHelp')}
            </p>
            {enrichedBy && (
              <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                <p className="min-w-0 break-words text-gray-700 dark:text-gray-300">
                  {t('linkedReceipts.enrichedBy', { subject: enrichedBy.subject })}
                </p>
                {openButton(enrichedBy.receiptId, enrichedBy.subject)}
              </div>
            )}
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {detail.candidates.map((candidate) => (
                <li key={candidate.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-sm">
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {t('transactionSummary', {
                        date: formatDate(candidate.date),
                        amount: formatCurrency(candidate.amount, candidate.currencyCode),
                        payee: candidate.payeeName ?? t('noPayee'),
                      })}
                    </div>
                    {candidate.quantity !== undefined && candidateSharesShown && (
                      <div className="text-gray-500 dark:text-gray-400">
                        {t('candidateShares', { quantity: formatShareQuantity(candidate.quantity) })}
                      </div>
                    )}
                    {candidate.description && (
                      <div className="break-words text-gray-500 dark:text-gray-400">
                        <LinkifiedText text={candidate.description} />
                      </div>
                    )}
                  </div>
                  {canLink && (
                    <Button
                      variant="outline"
                      size="sm"
                      isLoading={linkingId === candidate.id}
                      disabled={linkingId !== null}
                      onClick={() => void handleLink(candidate.id)}
                    >
                      {t('linkButton')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {tradeLinkable && detail.candidates.length === 0 && (
          <p className="rounded-lg border border-gray-200 p-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
            {t('tradeNoCandidates')}
          </p>
        )}

        {canPick && (
          <ReceiptTransactionPicker effectiveDate={detail.effectiveDate} linkingId={linkingId} onLink={(id) => void handleLink(id)} />
        )}

        {linkError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {linkError}
          </p>
        )}

        <section aria-labelledby="receipt-text-heading" className="space-y-2">
          <h3 id="receipt-text-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('bodyHeading')}
          </h3>
          <EmailBodyView bodyText={detail.bodyText} bodyHtml={detail.bodyHtml ?? null} lines={detail.lines} />
        </section>

      </div>
    );
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidth="3xl"
      padding="md"
      pushHistory
      title={t('title')}
      footer={
        <Button variant="outline" onClick={onClose}>
          {tc('close')}
        </Button>
      }
    >
      {body}
    </Modal>
  );
}
