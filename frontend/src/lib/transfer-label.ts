/**
 * Which way a transfer moved, and how to name it in an export.
 *
 * The direction is a fact about the row you are looking at: money leaving this
 * account is a transfer *to* the counterpart, money arriving is a transfer
 * *from* it. Both legs of one transfer therefore read differently, correctly --
 * the register's arrow chips have always worked this way, and the rule now
 * lives here rather than four times in `TransactionRow` and again in every
 * surface that adds a transfer label.
 *
 * A split line carries its own amount and its own counterpart, so it is asked
 * the same question with its own sign, not the parent's.
 */

export type TransferDirection = 'to' | 'from';

/**
 * An amount of exactly zero has no direction to read. It follows the negative
 * branch's opposite -- the same answer the register gives -- rather than
 * inventing a third label for a placeholder amount; the point is that one rule
 * answers this everywhere, not that zero has a meaningful direction.
 */
export function transferDirection(amount: number | string): TransferDirection {
  return Number(amount) < 0 ? 'to' : 'from';
}

/**
 * The Category cell for a transfer in a CSV export: `Transfer To Savings`.
 *
 * The whole exported file is English -- its headers are literals, as is
 * `Uncategorized` -- so this is too. Translating one cell under an English
 * header would read worse than either choice made consistently.
 */
export function transferCsvLabel(
  accountName: string,
  amount: number | string,
): string {
  return `Transfer ${transferDirection(amount) === 'to' ? 'To' : 'From'} ${accountName}`;
}

/**
 * The inputs for a transfer leg's *resolved* payee label (issue #1214).
 *
 * A transfer created without a payee is PERSISTED without one; the payee cell
 * shows "Transfer to/from <account>" resolved at render time from the linked
 * leg's account -- its CURRENT name, in the reader's language -- so renaming
 * an account or switching languages updates every historical row at once.
 * Consumers pass the result through the `common.transferPayee` catalog string
 * (via `usePayeeDisplay`); this helper only decides WHEN the fallback applies
 * and from which row facts.
 *
 * Returns null when the row is not a transfer, already carries a payee, or
 * its counterpart is not loaded (then the caller shows its usual empty state).
 */
/**
 * The English payee cell for a blank-payee transfer leg in a CSV export --
 * `Transfer to Savings` -- matching the backend account export
 * (`transferPayeeLabel` in `backend/src/transactions/transfer-payee-label.util.ts`)
 * and the text the pre-#1214 write paths stamped, so exports read unchanged.
 * The whole exported file is English (see `transferCsvLabel` above), so this
 * is too. Returns null when no fallback applies (the caller writes '').
 */
export function transferPayeeCsvLabel(
  tx: Parameters<typeof transferPayeeParams>[0],
): string | null {
  const params = transferPayeeParams(tx);
  return params ? `Transfer ${params.direction} ${params.name}` : null;
}

export function transferPayeeParams(tx: {
  payeeName?: string | null;
  payee?: { name: string } | null;
  isTransfer?: boolean;
  amount: number | string;
  linkedTransaction?: { account?: { name: string } | null } | null;
}): { direction: TransferDirection; name: string } | null {
  if (tx.payeeName || tx.payee?.name) return null;
  if (!tx.isTransfer) return null;
  const name = tx.linkedTransaction?.account?.name;
  if (!name) return null;
  return { direction: transferDirection(tx.amount), name };
}
