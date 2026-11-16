'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { EmailReceiptDisplayState, EmailReceiptTradeProposal } from '@/types/email-receipts';

/** Where a trade's proposal is approved: its card in the review inbox. */
const REVIEW_INBOX_HREF = '/ai-reviews?kind=email_receipt';

interface TradeProposalViewProps {
  /** The open proposal's trade, or null when none waits for approval. */
  proposal: EmailReceiptTradeProposal | null;
  /** The email already accounts for an investment transaction (the approval booked it). */
  booked: boolean;
  displayState: EmailReceiptDisplayState | null;
}

/**
 * The trade an email's open `email_trade` proposal would book, with the figures
 * of the review card (the account and the security resolved): the AI agent's
 * answer for an email handed to it as a trade, or a trade profile's reading
 * beside that reading. With no proposal (only for an email no profile read), why
 * there is none to show. The total and the price are in the security's
 * currency, as the card states them.
 */
export function TradeProposalView({ proposal, booked, displayState }: TradeProposalViewProps) {
  const t = useTranslations('emailReceipts.trade');
  const { formatCurrency, formatCurrencyPrecise, formatShareQuantity } = useNumberFormat();
  const { formatDate } = useDateFormat();

  if (proposal === null) {
    const key = booked ? 'aiBooked' : displayState === 'pending_ai' ? 'aiWaiting' : 'aiNoProposal';
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t(key)}</p>;
  }

  // A cash dividend may be paid as one amount, with no share count and no price.
  const dividend = proposal.action === 'DIVIDEND';
  const { quantity, price } = proposal;
  return (
    <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
      <p className="font-medium text-gray-900 dark:text-gray-100">
        {t('summary', {
          action: proposal.action,
          // The dividend sentence names no shares; a known count is its own line below.
          ...(quantity !== null ? { quantity: formatShareQuantity(quantity) } : {}),
          symbol: proposal.symbol,
          total: formatCurrency(proposal.totalAmount, proposal.currencyCode),
          date: formatDate(proposal.date),
        })}
      </p>
      {proposal.securityName && <p>{t('proposalSecurity', { name: proposal.securityName })}</p>}
      <p>{t('proposalAccount', { account: proposal.accountName })}</p>
      {dividend && quantity !== null && <p>{t('dividendShares', { quantity: formatShareQuantity(quantity) })}</p>}
      {price !== null && (
        <p>
          {dividend
            ? t('proposalDividendPerShare', { price: formatCurrencyPrecise(price, proposal.currencyCode, 4) })
            : t('proposalPrice', { price: formatCurrencyPrecise(price, proposal.currencyCode, 4) })}
        </p>
      )}
      <p>{t('proposalCommission', { commission: formatCurrency(proposal.commission, proposal.currencyCode) })}</p>
      <p>
        {t('proposalReview')}{' '}
        <Link href={REVIEW_INBOX_HREF} className="text-blue-600 hover:underline dark:text-blue-400">
          {t('proposalReviewLink')}
        </Link>
      </p>
    </div>
  );
}
