import { ObjectLiteral, SelectQueryBuilder } from "typeorm";

/**
 * The order the register lists transactions in, written once.
 *
 * More than one query has to agree on it, and only one of them is the
 * register: the others sum the rows the register lists NEWER than the page
 * being shown, so that page's running balance can start from the right
 * number. Those are the pages above it when the register runs newest-first
 * and the pages below it when it runs oldest-first, which is why the window
 * is written once too (`restrictToRowsNewerThanPage` below). A tiebreak added
 * to the register alone silently re-splits the pages under those sums, and
 * every balance away from the newest page is wrong by whichever rows crossed
 * the boundary. That is the "a predicate that decides which row counts is
 * written once" rule applied to an ORDER BY.
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
 * The columns the register can be sorted by, written once.
 *
 * This list is the contract between four places: the register query, the
 * HTTP query parameter, the AI and MCP tools, and the browser's column
 * headers. A contract spec holds the browser's copy equal to
 * this one, and the tool schemas derive their enums from it, so a field
 * offered anywhere is a field every caller can ask for.
 *
 * What is NOT here is as deliberate as what is. Tags and attachments are
 * one-to-many joins: ordering by one makes the DISTINCT-id query TypeORM
 * pages these joins with emit an id per joined row, and a page repeats
 * transactions. Balance is derived per page rather than stored. The
 * foreign-currency columns belong to one surface's feature set.
 */
export const TRANSACTION_SORT_FIELDS = [
  "date",
  "account",
  "payee",
  "category",
  "description",
  "refNumber",
  "amount",
  "status",
] as const;

export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];

export const DEFAULT_TRANSACTION_SORT_FIELD: TransactionSortField = "date";
export const DEFAULT_TRANSACTION_SORT_DIRECTION: RegisterSortDirection = "DESC";

export function isTransactionSortField(
  value: unknown,
): value is TransactionSortField {
  return (
    typeof value === "string" &&
    (TRANSACTION_SORT_FIELDS as readonly string[]).includes(value)
  );
}

/**
 * The aliases of the joined tables a sort field may order by.
 *
 * A query that does not join them cannot be asked for those fields, and
 * `registerPrimaryOrder` throws rather than emitting SQL naming an alias that
 * is not in the statement. The three queries that sum the rows newer than a
 * page select from `transactions` alone and pass nothing here, so they can
 * never be ordered by a joined column -- which is what keeps their window
 * comparable with the register's own.
 */
export interface RegisterSortAliases {
  account?: string;
  category?: string;
}

/**
 * A primary ORDER BY term: the expression, and where the nulls go when the
 * column is nullable.
 *
 * Nulls sink in BOTH directions rather than riding the sort, because a blank
 * payee, category, description or reference is the absence of a value, not
 * the smallest one: reversing the sort should not fill the top of the
 * register with rows that have nothing in the column being sorted by. It is
 * also what `compareValues` (the client's sort helper) already does.
 */
export interface RegisterPrimaryOrder {
  expression: string;
  nulls?: "NULLS LAST";
}

function requireJoinAlias(
  alias: string | undefined,
  field: TransactionSortField,
): string {
  if (!alias) {
    throw new Error(
      `Sorting the register by "${field}" needs that table's join alias. ` +
        "Pass it in `aliases`, or do not offer the field on a query that " +
        "does not join the table.",
    );
  }
  return alias;
}

/**
 * The primary ORDER BY term for a sort field.
 *
 * The expression is always `alias.property`, never a computed one: TypeORM
 * pages a query with joins by selecting DISTINCT ids plus the order columns
 * from a subquery, and it rewrites each order key by splitting on the dot and
 * resolving the alias. A `CASE` or `LOWER(...)` there is not an alias, so it
 * throws. That is why status sorts by its stored value rather than by a
 * lifecycle rank: the rank would have to be an added select, which is a
 * bigger change than a status sort is worth.
 *
 * Text sorts in the database collation for the same reason `categories` and
 * `payees` already order by a raw `name`: one collation, one answer, and no
 * expression in the ORDER BY.
 */
export function registerPrimaryOrder(
  field: TransactionSortField,
  transactionAlias: string,
  aliases?: RegisterSortAliases,
): RegisterPrimaryOrder {
  switch (field) {
    case "date":
      return { expression: `${transactionAlias}.transactionDate` };
    case "amount":
      return { expression: `${transactionAlias}.amount` };
    case "status":
      // `status` is defaulted in the schema, not NOT NULL, so it sinks with
      // every other nullable column rather than riding one direction of the
      // sort to the top.
      return {
        expression: `${transactionAlias}.status`,
        nulls: "NULLS LAST",
      };
    case "payee":
      return {
        expression: `${transactionAlias}.payeeName`,
        nulls: "NULLS LAST",
      };
    case "description":
      return {
        expression: `${transactionAlias}.description`,
        nulls: "NULLS LAST",
      };
    case "refNumber":
      return {
        expression: `${transactionAlias}.referenceNumber`,
        nulls: "NULLS LAST",
      };
    case "account":
      return {
        expression: `${requireJoinAlias(aliases?.account, field)}.name`,
        nulls: "NULLS LAST",
      };
    case "category":
      return {
        expression: `${requireJoinAlias(aliases?.category, field)}.name`,
        nulls: "NULLS LAST",
      };
  }
}

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
 * @param field The column the reader chose, defaulting to the transaction
 *   date. Under any other field the transaction date becomes the second key,
 *   so one payee's (or one category's, or one status's) rows still read
 *   chronologically instead of in the order they happened to be imported in.
 *   The tiebreaks below that are the same whatever the field.
 * @param aliases The join aliases for the fields that order by another table.
 */
export function applyRegisterOrder<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  alias: string,
  direction: RegisterSortDirection,
  field: TransactionSortField = DEFAULT_TRANSACTION_SORT_FIELD,
  aliases?: RegisterSortAliases,
): SelectQueryBuilder<T> {
  const primary = registerPrimaryOrder(field, alias, aliases);
  queryBuilder.orderBy(primary.expression, direction, primary.nulls);
  if (field !== "date") {
    queryBuilder.addOrderBy(`${alias}.transactionDate`, direction);
  }
  return queryBuilder
    .addOrderBy(`${alias}.createdAt`, direction)
    .addOrderBy(`${alias}.amount`, creditsBeforeDebitsDirection(direction))
    .addOrderBy(`${alias}.id`, direction);
}

/**
 * Which page of the register is being listed, and which way it runs.
 *
 * `total` is here because the newest page is not always page 1: a
 * newest-first register puts it there, an oldest-first one puts it last. Both
 * `findAll` and the balance helpers have the total in hand before any balance
 * query runs, so asking is free.
 */
export interface RegisterPageWindow {
  skip: number;
  limit: number;
  total: number;
  direction: RegisterSortDirection;
}

/**
 * Whether this page holds the newest row of the whole listing.
 *
 * The page's running balance is seeded with the balance after its newest row,
 * so on the newest page that seed IS the listing's own balance and nothing
 * needs summing. Every other page subtracts the rows above it in time.
 */
export function isNewestPage(window: RegisterPageWindow): boolean {
  return window.direction === "DESC"
    ? window.skip === 0
    : window.skip + window.limit >= window.total;
}

/**
 * Restricts a query to the rows the register lists NEWER than this page, in
 * the register's own order.
 *
 * This is the window whose sum turns the listing's balance into the page's.
 * Under a newest-first register those rows are the pages above, so the first
 * `skip` rows of the DESC order. Under an oldest-first register they are the
 * pages BELOW, so everything from `skip + limit` of the ASC order -- and the
 * ASC order is the exact reverse of the DESC one (every key flips, the amount
 * tiebreak included), so the two windows describe the same set of rows and
 * the same balance lands beside the same row either way.
 *
 * The offset is never zero when it is applied (`skip + limit >= 1`), so a
 * builder that drops a falsy offset cannot silently widen the window to the
 * whole table; the `isNewestPage` caller has already returned by then.
 *
 * Date order only. It takes no sort field and no aliases because a register
 * sorted by anything else shows no balance at all: the rows "newer" than a
 * page sorted by payee are not the rows whose amounts a balance moves by.
 */
export function restrictToRowsNewerThanPage<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  alias: string,
  window: RegisterPageWindow,
): SelectQueryBuilder<T> {
  applyRegisterOrder(queryBuilder, alias, window.direction);
  return window.direction === "DESC"
    ? queryBuilder.limit(window.skip)
    : queryBuilder.offset(window.skip + window.limit);
}
