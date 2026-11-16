import { transactionsApi } from '@/lib/transactions';
import type { FutureTransaction } from '@/lib/forecast';
import type { Transaction } from '@/types/transaction';

/** How many posted, future-dated transactions a forecast loads. */
export const FUTURE_TRANSACTIONS_LIMIT = 200;

/** Tomorrow as a local `YYYY-MM-DD`: the first day a forecast projects. */
export function futureTransactionsStartDate(now: Date = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
}

/**
 * Posted transactions dated after today, in the shape the forecast layers onto
 * the current balance (which excludes them). A VOID row moved no balance, so it
 * is dropped. `fallbackName` names a row with no payee and no description.
 */
export function toFutureTransactions(
  rows: Transaction[],
  fallbackName: string,
): FutureTransaction[] {
  return rows
    .filter(t => t.status !== 'VOID')
    .map(t => ({
      id: t.id,
      accountId: t.accountId,
      name: t.payeeName || t.payee?.name || t.description || fallbackName,
      amount: Number(t.amount),
      date: t.transactionDate.split('T')[0],
    }));
}

/**
 * Load the posted, future-dated transactions a cash flow forecast needs. The
 * Bills & Deposits page and the dashboard widget both read them through here,
 * so the two forecasts start from the same rows.
 */
export async function loadFutureTransactions(fallbackName: string): Promise<FutureTransaction[]> {
  const response = await transactionsApi.getAll({
    startDate: futureTransactionsStartDate(),
    limit: FUTURE_TRANSACTIONS_LIMIT,
  });
  return toFutureTransactions(response.data, fallbackName);
}
