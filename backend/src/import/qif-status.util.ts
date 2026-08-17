import { TransactionStatus } from "../transactions/entities/transaction-status.enum";

/**
 * The one place a QIF/CSV row's cleared markers become flags, and the one
 * place those flags become a TransactionStatus. Two byte-identical copies of
 * the `C` switch arm (single-account and multi-account parsers) and three
 * status derivations (regular processor, investment cash transfers, and the
 * trade path -- which hard-coded CLEARED and dropped the parsed state
 * entirely) had already drifted before this file existed.
 */

/**
 * Apply a QIF `C` (cleared status) field value to a row's flags.
 *
 * Quicken writes `*` or `c` for cleared and `X` or `R` for reconciled; the
 * original implementation accepted only `*`/`X`/`x`, so files using Quicken's
 * own `c`/`R` silently imported as unreconciled. Values are matched
 * case-insensitively after trimming; anything unrecognised leaves both flags
 * alone (unreconciled), never throws -- an import must not fail on a marker.
 */
export function applyQifClearedField(
  target: { cleared?: boolean; reconciled?: boolean },
  value: string,
): void {
  const normalized = value.trim();
  if (normalized === "*" || normalized.toLowerCase() === "c") {
    target.cleared = true;
  } else if (
    normalized.toLowerCase() === "x" ||
    normalized.toLowerCase() === "r"
  ) {
    target.reconciled = true;
  }
}

/**
 * Fold a parsed row's status flags into a TransactionStatus. VOID (from a
 * CSV reconciliation-status column or Money's "VOID " payee prefix) takes
 * precedence so a source-flagged cancelled row never materializes as a live
 * balance-affecting transaction; reconciled outranks cleared.
 */
export function statusFromQifFlags(row: {
  cleared?: boolean;
  reconciled?: boolean;
  void?: boolean;
}): TransactionStatus {
  if (row.void) return TransactionStatus.VOID;
  if (row.reconciled) return TransactionStatus.RECONCILED;
  if (row.cleared) return TransactionStatus.CLEARED;
  return TransactionStatus.UNRECONCILED;
}
