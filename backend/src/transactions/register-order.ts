import { ObjectLiteral, SelectQueryBuilder } from "typeorm";

/**
 * The order the register lists transactions in, written once.
 *
 * Four queries have to agree on it, and only one of them is the register: the
 * other three sum the rows on *previous pages* so page N's running balance can
 * start from the right number. A tiebreak added to the register alone silently
 * re-splits the pages under those sums, and every balance from page 2 down is
 * wrong by whichever rows crossed the boundary. That is the "a predicate that
 * decides which row counts is written once" rule applied to an ORDER BY.
 *
 * ## Why `amount` is in here
 *
 * `created_at` defaults to `CURRENT_TIMESTAMP`, which in PostgreSQL is
 * **transaction start time** -- one value for the whole transaction, not per
 * statement. TypeORM leans on that default rather than sending a value
 * (`InsertQueryBuilder` says so in a comment where the code used to be), so
 * every row an import writes carries the *same* `created_at`. Within one date
 * the order then fell through to `id`, which is a random UUID: the register
 * listed same-day imported rows in an arbitrary order that changed nothing
 * about the stored balance and everything about the running balance beside it.
 *
 * The visible symptom is an account that appears to go overdrawn. A purchase
 * funded by a transfer that same day is two rows in the cash account, and if
 * the debit is ordered as the older of the two, the running balance dips
 * negative on a day the account was never short. It recovers on the next row,
 * which is what makes it read as a bug in the balance rather than in the sort.
 *
 * So when the clock cannot separate two rows, their signs do: **credits are
 * ordered before debits**, chronologically. Money has to arrive before it can
 * be spent, and no data we hold says otherwise -- `.mny`, QIF and OFX all carry
 * a date and no time.
 *
 * The tiebreak runs **opposite** to the list direction, which is the one part
 * that looks wrong and is not. The rule is about chronological order, and a
 * descending register lists newest first: putting credits earlier in time means
 * putting them *later* in a newest-first list. Deriving it from `direction`
 * rather than hardcoding `ASC` is what keeps an ascending register right too.
 *
 * It only ever changes anything when `created_at` ties, so ordinary
 * hand-entered rows -- which are seconds apart -- are untouched.
 */

export type RegisterSortDirection = "ASC" | "DESC";

/**
 * Chronological order within a `created_at` tie is credits first, so a
 * newest-first list needs debits first. Exported so the guard test can state
 * the relationship rather than restate the table.
 */
export function creditsBeforeDebitsDirection(
  direction: RegisterSortDirection,
): RegisterSortDirection {
  return direction === "DESC" ? "ASC" : "DESC";
}

/**
 * Applies the register's full ordering to a query builder.
 *
 * @param sortColumn The primary column, defaulting to the transaction date.
 *   The register also sorts by amount and payee; passing one of those leaves
 *   the tiebreaks below it unchanged.
 */
export function applyRegisterOrder<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  alias: string,
  direction: RegisterSortDirection,
  sortColumn = "transactionDate",
): SelectQueryBuilder<T> {
  return queryBuilder
    .orderBy(`${alias}.${sortColumn}`, direction)
    .addOrderBy(`${alias}.createdAt`, direction)
    .addOrderBy(`${alias}.amount`, creditsBeforeDebitsDirection(direction))
    .addOrderBy(`${alias}.id`, direction);
}
