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
