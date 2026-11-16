import { ConflictException, NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  lockInvestmentTransactionRow,
  LockedInvestmentTransactionRow,
} from "../common/db/locks";
import { tr } from "../i18n/translate";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";

/**
 * The columns a reversal or a reapplication is derived from, as `findOne`
 * read them before the write transaction.
 */
type InvestmentRowSnapshot = Pick<
  InvestmentTransaction,
  | "id"
  | "accountId"
  | "securityId"
  | "fundingAccountId"
  | "transactionId"
  | "transactionSplitId"
  | "linkedTransactionId"
  | "action"
  | "transactionDate"
  | "quantity"
  | "price"
  | "commission"
  | "totalAmount"
  | "exchangeRate"
  | "status"
>;

const sameNumber = (
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): boolean => {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull === bNull;
  return Number(a) === Number(b);
};

const sameId = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => (a ?? null) === (b ?? null);

/**
 * True when the locked row no longer carries what the snapshot read: another
 * request edited it (and replaced its cash leg) between the read and the lock.
 */
export function investmentRowChangedSince(
  snapshot: InvestmentRowSnapshot,
  locked: LockedInvestmentTransactionRow,
): boolean {
  return !(
    sameId(snapshot.accountId, locked.accountId) &&
    sameId(snapshot.securityId, locked.securityId) &&
    sameId(snapshot.fundingAccountId, locked.fundingAccountId) &&
    sameId(snapshot.transactionId, locked.transactionId) &&
    sameId(snapshot.transactionSplitId, locked.transactionSplitId) &&
    sameId(snapshot.linkedTransactionId, locked.linkedTransactionId) &&
    snapshot.action === locked.action &&
    snapshot.transactionDate === locked.transactionDate &&
    snapshot.status === locked.status &&
    sameNumber(snapshot.quantity, locked.quantity) &&
    sameNumber(snapshot.price, locked.price) &&
    // A NULL commission is read back as 0 by the lock.
    sameNumber(snapshot.commission ?? 0, locked.commission) &&
    sameNumber(snapshot.totalAmount, locked.totalAmount) &&
    sameNumber(snapshot.exchangeRate, locked.exchangeRate)
  );
}

/**
 * Row-lock an investment transaction inside the write transaction (after
 * `lockHoldingScope`) and refuse the write unless the row is still the one
 * the caller's snapshot describes (A26-H04).
 *
 * The holdings lock serializes two writers of the same row, but each decides
 * what to reverse -- which cash row to delete, which values to save -- from
 * what it read before the lock. So the second of two edits would delete a
 * cash row the first already replaced and post another (the cash moves
 * twice), and a delete behind an edit would leave the edit's cash row with no
 * owner. Gone is a 404; changed is a 409, before anything is written.
 */
export async function lockUnchangedInvestmentRow(
  manager: EntityManager,
  userId: string,
  snapshot: InvestmentRowSnapshot,
): Promise<LockedInvestmentTransactionRow> {
  const locked = await lockInvestmentTransactionRow(
    manager,
    snapshot.id,
    userId,
  );
  if (!locked) {
    throw new NotFoundException(
      tr(
        "errors.securities.investmentTransactionNotFound",
        `Investment transaction with ID ${snapshot.id} not found`,
        { id: snapshot.id },
      ),
    );
  }
  if (investmentRowChangedSince(snapshot, locked)) {
    throw new ConflictException(
      tr(
        "errors.securities.investmentTransactionChanged",
        "This transaction was changed by another request. Reload it and try again.",
      ),
    );
  }
  return locked;
}
