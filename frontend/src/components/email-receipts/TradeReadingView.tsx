'use client';

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { accountStanding, type ReceiptParserAccountOption } from '@/hooks/useReceiptParserLookups';
import { fromReceiptUnits } from '@/lib/email-receipts-format';
import { tradeActionMovesShares, type ParsedTrade } from '@/types/email-receipts';

interface TradeReadingViewProps {
  trade: ParsedTrade;
  /** The day to show when the email states none: the day it arrived (or the shop's day for a forward), an ISO timestamp; null when unknown. */
  fallbackDate: string | null;
  /**
   * Say why an incomplete reading is incomplete. The detail dialog does not
   * need it (its status line says so); the profile test panel has no status line.
   */
  showReason?: boolean;
  /**
   * The user's accounts: with them the account the profile chose is named (and
   * flagged when it is not an open brokerage account of theirs). Without them
   * the chosen account is not shown.
   */
  accounts?: readonly ReceiptParserAccountOption[];
}

/**
 * What a profile with a `trade` section read from a brokerage confirmation: one
 * sentence naming the action, the shares, the ticker and the executed total (a
 * cash dividend names no shares: the email may state only the amount paid),
 * the account text the email printed and, when the average price does not fit the
 * shares and the total, why the trade will wait for a person.
 *
 * The total is in the security's currency, which the email does not name, so it
 * is shown as a plain number unless the email named its currency; the review
 * card shows it with the security's. An incomplete reading names its reason only
 * when asked (`showReason`): in the detail dialog the status line above does.
 *
 * The currency is said with where it came from (the amount, a currency marker
 * of the profile, the security), because an account rule with a currency
 * decided the account by it.
 */
export function TradeReadingView({ trade, fallbackDate, showReason = false, accounts }: TradeReadingViewProps) {
  const t = useTranslations('emailReceipts.trade');
  const tReason = useTranslations('emailReceipts.detail.reasons');
  const tEditor = useTranslations('emailReceipts.editor.trade');
  const { formatCurrency, formatNumber, formatShareQuantity } = useNumberFormat();
  const money = (units: number, decimals: number) =>
    trade.currency
      ? formatCurrency(fromReceiptUnits(units), trade.currency)
      : formatNumber(fromReceiptUnits(units), decimals);
  const { formatDate } = useDateFormat();

  const tradeDate = trade.date ?? fallbackDate;

  const currencyLine = trade.currency && trade.currencySource && (
    <p>{t('currencyFrom', { currency: trade.currency, source: trade.currencySource })}</p>
  );
  const accountLine = (() => {
    if (accounts === undefined || trade.accountId === null) return null;
    const standing = accountStanding(accounts, trade.accountId);
    const account = accounts.find((option) => option.value === trade.accountId);
    const name = account?.label ?? '';
    // With its currency: two accounts the broker prints alike often share a name too.
    if (standing === 'tradable' && account) {
      return <p>{t('bookTo', { account: tEditor('accountOption', { name, currency: account.currencyCode }) })}</p>;
    }
    return (
      <p role="note" className="text-amber-800 dark:text-amber-300">
        {standing === 'unknown' ? t('bookToUnknown') : t('bookToNotTradable', { account: name })}
      </p>
    );
  })();

  // A cash dividend moves no shares, so a complete one may state none.
  if (
    !trade.complete ||
    trade.action === null ||
    trade.symbol === null ||
    (trade.quantity === null && tradeActionMovesShares(trade.action))
  ) {
    const reasonKey = trade.reason;
    return (
      <div className="space-y-1 text-sm text-gray-500 dark:text-gray-400">
        <p>{t('incomplete')}</p>
        {showReason && reasonKey && tReason.has(reasonKey) && <p>{tReason(reasonKey)}</p>}
        {/* What the rules were tried against: the account text the email printed. */}
        {showReason && trade.accountText && <p>{t('account', { account: trade.accountText })}</p>}
      </div>
    );
  }

  const dividend = trade.action === 'DIVIDEND';
  return (
    <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
      <p className="font-medium text-gray-900 dark:text-gray-100">
        {t('summary', {
          action: trade.action,
          // The dividend sentence names no shares; a known count is its own line below.
          ...(trade.quantity !== null ? { quantity: formatShareQuantity(trade.quantity) } : {}),
          symbol: trade.symbol,
          // A trade read from its price alone has no stated total: the figure is then the price's.
          total: trade.total === null ? t('totalFromPrice') : money(trade.total, 2),
          date: tradeDate === null ? t('dateUnknown') : formatDate(tradeDate),
        })}
      </p>
      {dividend && trade.quantity !== null && <p>{t('dividendShares', { quantity: formatShareQuantity(trade.quantity) })}</p>}
      {trade.price !== null && (
        <p>{dividend ? t('dividendPerShare', { price: money(trade.price, 4) }) : t('price', { price: money(trade.price, 4) })}</p>
      )}
      {currencyLine}
      {trade.accountText && <p>{t('account', { account: trade.accountText })}</p>}
      {accountLine}
      {trade.consistent === false && (
        <p role="note" className="text-amber-800 dark:text-amber-300">
          {dividend ? t('dividendMismatch') : t('priceMismatch')}
        </p>
      )}
    </div>
  );
}
