'use client';

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { tradeActionOf, type EmailReceiptInvestmentSummary } from '@/types/email-receipts';

/**
 * The sentence naming the investment transaction a trade email accounts for
 * (the one its approval booked, a person linked, or already in the ledger), as
 * the detail dialog and the email list both show it: a buy, a sell, a cash
 * dividend (which names no shares) or a reinvested dividend. An action that is
 * none of the four is named by its shares, ticker and total alone, never as a buy.
 */
export function useBookedTradeSummary(): (booked: EmailReceiptInvestmentSummary) => string {
  const t = useTranslations('emailReceipts.detail');
  const { formatCurrency, formatShareQuantity } = useNumberFormat();
  const { formatDate } = useDateFormat();
  return (booked) =>
    t('tradeTransactionSummary', {
      action: tradeActionOf(booked.action) ?? 'other',
      quantity: formatShareQuantity(booked.quantity),
      symbol: booked.symbol,
      total: formatCurrency(booked.totalAmount, booked.currencyCode),
      date: formatDate(booked.date),
    });
}
