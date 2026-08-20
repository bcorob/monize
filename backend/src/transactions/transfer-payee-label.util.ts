/**
 * The display payee for a transfer leg whose payee was left blank.
 *
 * A blank payee on a transfer is persisted as NULL (issue #1214) and the label
 * is resolved at read time from the counterpart account's CURRENT name, so an
 * account rename is reflected everywhere immediately. This file is the only
 * place the English form of that label is written: machine-facing surfaces
 * (CSV export, AI/MCP transaction rows) synthesize it here, while the
 * frontend renders its own localized equivalent from the same inputs.
 *
 * Direction is a fact about the row being looked at, mirroring the frontend's
 * `transferDirection` (`frontend/src/lib/transfer-label.ts`): money leaving
 * this account (negative amount) went TO the counterpart; money arriving came
 * FROM it.
 */

export type TransferPayeeDirection = "to" | "from";

export function transferPayeeDirection(
  amount: number | string,
): TransferPayeeDirection {
  return Number(amount) < 0 ? "to" : "from";
}

/** `Transfer to Savings` / `Transfer from Chequing`, from this row's amount. */
export function transferPayeeLabel(
  amount: number | string,
  counterpartAccountName: string,
): string {
  return autoTransferPayeeName(
    transferPayeeDirection(amount),
    counterpartAccountName,
  );
}

/**
 * The exact string the pre-#1214 write paths stamped into `payee_name`.
 *
 * Kept only to recognise legacy rows: an edit that moves a transfer leg to a
 * different account clears a payee matching the OLD counterpart's stamp
 * (healing the row into the resolve-at-display model) instead of restamping
 * it. Migration 161 blanks the rows this expression matches. Never call this
 * to WRITE a payee.
 */
export function autoTransferPayeeName(
  direction: TransferPayeeDirection,
  counterpartAccountName: string,
): string {
  return `Transfer ${direction} ${counterpartAccountName}`;
}
