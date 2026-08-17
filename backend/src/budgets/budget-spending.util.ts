import { Repository, SelectQueryBuilder } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetCategory } from "./entities/budget-category.entity";

/**
 * A transfer a budget (or a transfer analysis) counts arrives in one of two
 * shapes, and every surface must read both:
 *
 * - a whole-row transfer: the parent carries `is_transfer = true` and the
 *   destination hangs off the linked counterpart leg;
 * - one component of a split: the parent is a split transaction rather than a
 *   transfer row, and the split line carries `transfer_account_id` directly.
 *
 * A query keyed off `t.is_transfer` alone never sees the second shape, so a
 * savings or debt-payment budget under-reported its progress by the whole
 * transfer whenever the user recorded it alongside a category on one line
 * (audit P5-007) -- and the same omission then survived on four more read
 * surfaces (review #1131). These two builders are the one place the pair of
 * predicates is written; callers add their own SELECT and GROUP BY on top,
 * reading the amount and destination through the exported expressions.
 *
 * Filtering on the split's own target cannot double-count, because a
 * counterpart row is not itself a split. Both builders keep outflows only
 * (`amount < 0`): a transfer INTO the budgeted account is progress, one out of
 * it is not.
 */
export interface OutgoingTransferWindow {
  userId: string;
  periodStart: string;
  periodEnd: string;
  /** Restrict to these destination accounts; omit to sweep every destination. */
  transferAccountIds?: string[];
}

/** Destination account of a whole-row transfer (parent builder alias). */
export const PARENT_TRANSFER_DESTINATION = "lt.account_id";
/** Destination account of a split-line transfer (split builder alias). */
export const SPLIT_TRANSFER_DESTINATION = "s.transfer_account_id";
/** Amount moved by a whole-row transfer (parent builder alias). */
export const PARENT_TRANSFER_AMOUNT = "t.amount";
/** Amount moved by a split-line transfer (split builder alias). */
export const SPLIT_TRANSFER_AMOUNT = "s.amount";

export function outgoingParentTransfers(
  repository: Repository<Transaction>,
  window: OutgoingTransferWindow,
): SelectQueryBuilder<Transaction> {
  const qb = repository
    .createQueryBuilder("t")
    .innerJoin("t.linkedTransaction", "lt")
    .where("t.user_id = :userId", { userId: window.userId })
    .andWhere("t.is_transfer = true")
    .andWhere("t.amount < 0")
    .andWhere("t.transaction_date >= :periodStart", {
      periodStart: window.periodStart,
    })
    .andWhere("t.transaction_date <= :periodEnd", {
      periodEnd: window.periodEnd,
    })
    .andWhere("t.status != :void", { void: "VOID" });
  if (window.transferAccountIds) {
    qb.andWhere("lt.account_id IN (:...transferAccountIds)", {
      transferAccountIds: window.transferAccountIds,
    });
  }
  return qb;
}

export function outgoingSplitTransfers(
  repository: Repository<TransactionSplit>,
  window: OutgoingTransferWindow,
): SelectQueryBuilder<TransactionSplit> {
  const qb = repository
    .createQueryBuilder("s")
    .innerJoin("s.transaction", "t")
    .where("t.user_id = :userId", { userId: window.userId })
    .andWhere("s.amount < 0")
    .andWhere("t.transaction_date >= :periodStart", {
      periodStart: window.periodStart,
    })
    .andWhere("t.transaction_date <= :periodEnd", {
      periodEnd: window.periodEnd,
    })
    .andWhere("t.status != :void", { void: "VOID" });
  if (window.transferAccountIds) {
    qb.andWhere("s.transfer_account_id IN (:...transferAccountIds)", {
      transferAccountIds: window.transferAccountIds,
    });
  } else {
    qb.andWhere("s.transfer_account_id IS NOT NULL");
  }
  return qb;
}

/**
 * Queries transaction and split spending for budget categories within a period.
 * Returns maps of categoryId -> totalSpent and transferAccountId -> totalSpent.
 *
 * Shared between BudgetsService and BudgetAlertService to avoid duplication.
 */
export async function queryCategorySpending(
  transactionsRepository: Repository<Transaction>,
  splitsRepository: Repository<TransactionSplit>,
  userId: string,
  budgetCategories: BudgetCategory[],
  periodStart: string,
  periodEnd: string,
): Promise<{
  spendingMap: Map<string, number>;
  transferSpendingMap: Map<string, number>;
}> {
  const categoryIds = budgetCategories
    .filter((bc) => bc.categoryId !== null)
    .map((bc) => bc.categoryId as string);

  const spendingMap = new Map<string, number>();
  const transferSpendingMap = new Map<string, number>();
  const transferBudgetCategories = budgetCategories.filter(
    (bc) => bc.isTransfer && bc.transferAccountId,
  );

  // Run all independent queries in parallel
  const queries: Promise<void>[] = [];

  if (categoryIds.length > 0) {
    queries.push(
      transactionsRepository
        .createQueryBuilder("t")
        .select("t.category_id", "categoryId")
        .addSelect("COALESCE(SUM(t.amount), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :periodStart", { periodStart })
        .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_split = false")
        .groupBy("t.category_id")
        .getRawMany()
        .then((rows) => {
          for (const row of rows) {
            spendingMap.set(row.categoryId, parseFloat(row.total || "0"));
          }
        }),
    );

    queries.push(
      splitsRepository
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .select("s.category_id", "categoryId")
        .addSelect("COALESCE(SUM(s.amount), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :periodStart", { periodStart })
        .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .groupBy("s.category_id")
        .getRawMany()
        .then((rows) => {
          for (const row of rows) {
            const existing = spendingMap.get(row.categoryId) || 0;
            spendingMap.set(
              row.categoryId,
              existing + parseFloat(row.total || "0"),
            );
          }
        }),
    );
  }

  if (transferBudgetCategories.length > 0) {
    const window: OutgoingTransferWindow = {
      userId,
      periodStart,
      periodEnd,
      transferAccountIds: transferBudgetCategories.map(
        (bc) => bc.transferAccountId as string,
      ),
    };
    const collect = (
      rows: Array<{ destinationAccountId: string; total: string }>,
    ) => {
      for (const row of rows) {
        transferSpendingMap.set(
          row.destinationAccountId,
          (transferSpendingMap.get(row.destinationAccountId) ?? 0) +
            parseFloat(row.total || "0"),
        );
      }
    };

    queries.push(
      outgoingParentTransfers(transactionsRepository, window)
        .select(PARENT_TRANSFER_DESTINATION, "destinationAccountId")
        .addSelect(`COALESCE(ABS(SUM(${PARENT_TRANSFER_AMOUNT})), 0)`, "total")
        .groupBy(PARENT_TRANSFER_DESTINATION)
        .getRawMany()
        .then(collect),
    );

    queries.push(
      outgoingSplitTransfers(splitsRepository, window)
        .select(SPLIT_TRANSFER_DESTINATION, "destinationAccountId")
        .addSelect(`COALESCE(ABS(SUM(${SPLIT_TRANSFER_AMOUNT})), 0)`, "total")
        .groupBy(SPLIT_TRANSFER_DESTINATION)
        .getRawMany()
        .then(collect),
    );
  }

  await Promise.all(queries);

  return { spendingMap, transferSpendingMap };
}

/** Resolves the display name for a budget category. */
export function resolveCategoryName(bc: BudgetCategory): string {
  if (bc.isTransfer && bc.transferAccountId) {
    return bc.transferAccount?.name || "Transfer";
  }
  const cat = bc.category;
  return cat
    ? cat.parent
      ? `${cat.parent.name}: ${cat.name}`
      : cat.name
    : "Uncategorized";
}

/**
 * Resolves the actual spent/earned amount for a budget category from the
 * spending maps.  The maps now contain signed net sums (expenses negative,
 * income positive).  We convert to a non-negative "spent" / "earned" value:
 *   - Expense categories: negate the sum so spending is positive, clamp to 0
 *     when refunds exceed spending.
 *   - Income categories: keep the positive sum, clamp to 0 when deductions
 *     exceed income.
 *   - Transfers: already filtered to outgoing (amount < 0), returned as a
 *     positive value by the query.
 */
export function resolveCategorySpent(
  bc: BudgetCategory,
  spendingMap: Map<string, number>,
  transferSpendingMap: Map<string, number>,
): number {
  if (bc.isTransfer && bc.transferAccountId) {
    return transferSpendingMap.get(bc.transferAccountId) || 0;
  }
  const raw = bc.categoryId ? spendingMap.get(bc.categoryId) || 0 : 0;
  return bc.isIncome ? Math.max(raw, 0) : Math.max(-raw, 0);
}
