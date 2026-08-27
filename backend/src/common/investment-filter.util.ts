import { SelectQueryBuilder } from "typeorm";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { roundMoney, sumMoney } from "./round.util";

/**
 * Which transaction rows are an investment movement rather than ordinary cash,
 * written once for every reader.
 *
 * An INVESTMENT account in Monize is a PAIR (`accounts.service.ts`
 * `createInvestmentAccountPair`): an `INVESTMENT_CASH` sleeve holding real
 * money and an `INVESTMENT_BROKERAGE` sleeve holding securities, both carrying
 * `account_type = 'INVESTMENT'`. So `account_type != 'INVESTMENT'` is not a
 * filter on synthetic rows -- it deletes the cash sleeve's entire ledger,
 * salary deposits included (issue #1257).
 *
 * Two layers, and neither substitutes for the other:
 *
 *  - `accountSubType != 'INVESTMENT_BROKERAGE'` keeps the securities sleeve's
 *    register out of a cash report. A standalone investment account -- type
 *    INVESTMENT with a NULL sub-type, which the ordinary account-create path
 *    produces and which `net-worth.service.ts` and `monthly-comparison.service.ts`
 *    already branch on -- IS its own cash side, so it stays in. (A .mny import is
 *    NOT such a case: `map-reference.ts` always emits the CASH/BROKERAGE pair.)
 *  - `NOT EXISTS (investment_transactions ...)` catches the cash-side rows that
 *    BUY / SELL / DIVIDEND post into the linked cash account
 *    (`createCashTransactionInTransaction`). Those carry no category and no
 *    transfer flag, and the subtype filter cannot see them at all -- untreated
 *    they leak into "spending" and "income" totals as uncategorised money.
 *
 * The split fragment is the same fact one level down: an investment embedded in
 * a split (`transaction_splits.kind = 'investment'`) has `category_id IS NULL`,
 * so a report grouping on `COALESCE(ts.category_id, t.category_id)` files that
 * line under Uncategorized unless it is excluded here.
 *
 * A raw-SQL caller and a QueryBuilder caller need the same predicate spelled
 * with different column names, so both are derived from one definition below
 * rather than written twice.
 */
const BROKERAGE_SUB_TYPE = "INVESTMENT_BROKERAGE";

/** The sub-type column, in each dialect that has to name it. */
const SUB_TYPE_FIELD = {
  /** TypeORM QueryBuilder: entity property names. */
  entity: "accountSubType",
  /** Raw SQL: physical column names. */
  column: "account_sub_type",
} as const;

function brokerageExclusion(accountAlias: string, field: string): string {
  return `(${accountAlias}.${field} IS NULL OR ${accountAlias}.${field} != '${BROKERAGE_SUB_TYPE}')`;
}

/** Brokerage-sleeve exclusion for a TypeORM QueryBuilder condition. */
export function brokerageExclusionForEntity(accountAlias: string): string {
  return brokerageExclusion(accountAlias, SUB_TYPE_FIELD.entity);
}

/** Brokerage-sleeve exclusion for raw SQL. */
export function brokerageExclusionForSql(accountAlias: string): string {
  return brokerageExclusion(accountAlias, SUB_TYPE_FIELD.column);
}

/**
 * Excludes the cash leg an investment transaction generated. Identical in both
 * dialects: it names a physical table and the transaction row's `id`.
 *
 * Deliberately `includes VOID` rows: this reads what a row IS -- its identity --
 * not what it moved.
 */
export function investmentLinkedTransactionExclusion(
  transactionAlias: string,
): string {
  return `NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = ${transactionAlias}.id)`;
}

/**
 * Excludes an investment line embedded in a split transaction, by BOTH of the
 * representations that describe one: the split's declared `kind`, and an
 * `investment_transactions` row pointing at that split. `createEmbeddedForSplit`
 * writes both (`transaction_id` stays null and the split amount IS the cash
 * side), so either clause alone would be the whole answer today -- and either
 * one alone becomes wrong the moment the two disagree: a split declared
 * investment whose row has been removed, or a row pointing at a split that does
 * not declare itself. `kind` also answers for free on the common path, before
 * the sub-query runs.
 *
 * `IS DISTINCT FROM` rather than `!=` because a LEFT JOIN that matched no split
 * leaves `kind` NULL, and `NULL != 'investment'` is NULL, which a WHERE clause
 * reads as false -- that comparison would drop every non-split transaction from
 * the report.
 *
 * Deliberately `includes VOID` rows: this reads what a row IS -- its identity --
 * not what it moved.
 */
export function investmentLinkedSplitExclusion(splitAlias: string): string {
  return [
    `${splitAlias}.kind IS DISTINCT FROM '${SplitKind.INVESTMENT}'`,
    `NOT EXISTS (SELECT 1 FROM investment_transactions its WHERE its.transaction_split_id = ${splitAlias}.id)`,
  ].join("\n        AND ");
}

/**
 * The ordinary cash a single `transactions` row represents.
 *
 * A report that joins `transaction_splits` classifies each line on its own and
 * needs nothing more. A report that reads only the parent -- Spending by Payee,
 * Recurring Expenses, Bill Payment History, the Uncategorized list -- cannot:
 * `t.amount` on a split parent is the sum of ALL its children, and an embedded
 * investment line's `transaction_id` is null, so the linkage exclusion above
 * cannot see it. Such a query admitted a `-560` parent made of `-60` groceries
 * and a `-500` embedded BUY as `560` of spending (branch audit F-RPT-001).
 *
 * Excluding the whole parent instead is the opposite error -- it loses the `60`
 * the user really did spend -- so the amount is derived at split-row
 * granularity: the sum of the children that are neither a transfer nor an
 * investment.
 *
 * NULL means "this row represents no ordinary cash at all" (a pure investment or
 * transfer passthrough). Every arithmetic comparison against NULL is NULL, which
 * a WHERE clause reads as false, so a caller filtering on `< 0` or `IS NOT NULL`
 * drops those rows without a second predicate. A caller that must keep them --
 * one whose subject is the stored row rather than its cash meaning -- says so.
 */
export function reportableTransactionAmountSql(
  transactionAlias: string,
  splitAlias: string = "reportable_split",
): string {
  return `CASE
          WHEN ${transactionAlias}.is_split = true THEN (
            SELECT SUM(${splitAlias}.amount)
              FROM transaction_splits ${splitAlias}
             WHERE ${splitAlias}.transaction_id = ${transactionAlias}.id
               AND ${splitAlias}.transfer_account_id IS NULL
               AND ${investmentLinkedSplitExclusion(splitAlias)}
          )
          ELSE ${transactionAlias}.amount
        END`;
}

/**
 * The conjunction a raw-SQL report inserts in place of the old
 * `AND a.account_type != 'INVESTMENT'`. Carries no bound parameters, so a
 * call site's `$n` numbering is unaffected.
 *
 * Omit `accountAlias` where the query has already scoped its accounts (or
 * genuinely wants the brokerage sleeve in); omit `splitAlias` where the query
 * does not join `transaction_splits`.
 */
export function investmentExclusionSql(opts: {
  accountAlias?: string;
  transactionAlias: string;
  splitAlias?: string;
}): string {
  const clauses: string[] = [];
  if (opts.accountAlias) {
    clauses.push(brokerageExclusionForSql(opts.accountAlias));
  }
  clauses.push(investmentLinkedTransactionExclusion(opts.transactionAlias));
  if (opts.splitAlias) {
    clauses.push(investmentLinkedSplitExclusion(opts.splitAlias));
  }
  return clauses.join("\n        AND ");
}

/* ------------------------------------------------------------------------- *
 * The same rule for a caller holding hydrated entities rather than SQL.
 *
 * The custom report engine (`src/reports/`) reads the ledger through TypeORM
 * entities and aggregates in TypeScript, so it cannot use the fragments above.
 * These are the same two questions in the other dialect, kept in this file so
 * the pair is read together: a line's provenance, and the ordinary cash a whole
 * transaction represents.
 *
 * Deliberately structural rather than the entity types: this file is imported by
 * `common/` consumers and the rule is about three fields, not about an entity
 * (the same reasoning as `DeletableRow` in `deletion-balance.util.ts`).
 * ------------------------------------------------------------------------- */

/** A hydrated split line, as far as this rule is concerned. */
export interface SplitLineLike {
  amount: number | string;
  kind?: string | null;
  /** Hydrate `splits.investmentTransaction` to make this half readable. */
  investmentTransaction?: { id: string } | null;
}

/** A hydrated transaction and its lines. */
export interface SplitParentLike {
  isSplit?: boolean | null;
  amount: number | string;
  splits?: SplitLineLike[] | null;
}

/**
 * Both representations, as in `investmentLinkedSplitExclusion`: the declared
 * kind and a linked investment row. A caller that did not hydrate the relation
 * still gets the `kind` half.
 */
export function isEmbeddedInvestmentSplit(line: SplitLineLike): boolean {
  return (
    line.kind === SplitKind.INVESTMENT || line.investmentTransaction != null
  );
}

/** The lines of a split that are not an embedded investment action. */
export function ordinarySplitLines<T extends SplitLineLike>(parent: {
  splits?: T[] | null;
}): T[] {
  return (parent.splits ?? []).filter(
    (line) => !isEmbeddedInvestmentSplit(line),
  );
}

/**
 * The TypeScript twin of `reportableTransactionAmountSql`, with the same NULL
 * semantics: `null` means the transaction represents no ordinary cash at all,
 * which is different from representing zero.
 *
 * The SQL form also drops transfer children, because no built-in report that
 * uses it includes transfers. This one deliberately says nothing about them: a
 * custom report carries its own `includeTransfers` configuration, so its engine
 * narrows the lines it does not want (`narrowSplitLines`) BEFORE asking this
 * function, and passes whatever is left. Investment provenance is a property of
 * the data; which transfers to count is a property of the report, and this
 * function must not quietly decide the second one in either direction.
 */
export function reportableTransactionAmount(
  parent: SplitParentLike,
): number | null {
  if (!parent.isSplit) return roundMoney(Number(parent.amount));
  // `undefined` is "the caller did not hydrate the lines", which is not a fact
  // about the transaction -- answering null there would hide real money from a
  // caller that simply did not ask for splits. An EMPTY array is hydrated and
  // says there are no lines, which is what the SQL twin's `SUM` over no rows
  // answers: no ordinary cash.
  if (parent.splits === undefined || parent.splits === null) {
    return roundMoney(Number(parent.amount));
  }
  const ordinary = ordinarySplitLines(parent);
  if (ordinary.length === 0) return null;
  return sumMoney(ordinary.map((line) => Number(line.amount)));
}

/**
 * The QueryBuilder form of the same two layers. Callers must have joined the
 * account alias first. The transaction alias defaults to `transaction`.
 */
export function applyInvestmentTransactionFilters<T extends object>(
  qb: SelectQueryBuilder<T>,
  accountAlias: string,
  transactionAlias: string = "transaction",
): SelectQueryBuilder<T> {
  qb.andWhere(brokerageExclusionForEntity(accountAlias));
  qb.andWhere(investmentLinkedTransactionExclusion(transactionAlias));
  return qb;
}
