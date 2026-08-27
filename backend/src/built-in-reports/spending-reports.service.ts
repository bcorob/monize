import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import {
  ReportCurrencyService,
  RawCategoryAggregate,
  RawPayeeAggregate,
  RawMonthlyCategoryAggregate,
} from "./report-currency.service";
import { roundMoney, sumMoney, toMoneyNumber } from "../common/round.util";
import {
  SpendingByCategoryResponse,
  CategorySpendingItem,
  SpendingByPayeeResponse,
  PayeeSpendingItem,
  MonthlySpendingTrendResponse,
  MonthlySpendingItem,
  MonthlyCategorySpending,
} from "./dto";
import {
  investmentExclusionSql,
  reportableTransactionAmountSql,
} from "../common/investment-filter.util";

/**
 * Investment scope is LINKAGE, never account type (INV-REPORT-001, issue #1257):
 * the cash sleeve of an INVESTMENT account holds ordinary money, while the cash
 * leg a trade generated is not spending or income. Both halves of the predicate,
 * and why the account type cannot express either, live in
 * `common/investment-filter.util.ts`.
 */
const INVESTMENT_EXCLUSION = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
  splitAlias: "ts",
});
const INVESTMENT_EXCLUSION_NO_SPLITS = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
});

/**
 * The ordinary cash the parent row represents. A payee total reads only the
 * parent, so a split's embedded investment or transfer line has to come out of
 * the amount rather than out of the row (branch audit F-RPT-001).
 */
const REPORTABLE_TX_AMOUNT = reportableTransactionAmountSql("t");

/**
 * Spending in a category is the DEBITS NET OF THE CREDITS filed against it: a
 * refund, a return or a chargeback is money that came back, so it reduces what
 * was spent there rather than being dropped (issue #1125). The aggregate
 * therefore sums the negated signed amount over rows of both signs -- positive
 * result means "spent" -- instead of the absolute value of debit rows only.
 *
 * Restricting to `<> 0` (rather than dropping the amount predicate entirely)
 * keeps a zero-amount row from creating a category bucket, which is what the
 * old `< 0` predicate did.
 */
const NET_SPEND_AMOUNT = "-COALESCE(ts.amount, t.amount)";
const NONZERO_AMOUNT = "COALESCE(ts.amount, t.amount) <> 0";

/**
 * A category whose credits meet or exceed its debits over the period was not
 * spent in, so it is not a row in a spending report. This is also what keeps
 * income categories (and uncategorized income, which the old debit-only
 * predicate excluded row by row) out of the breakdown now that credits are
 * read at all.
 */
export function isNetSpending(total: number): boolean {
  return total > 0;
}

@Injectable()
export class SpendingReportsService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  async getSpendingByCategory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    rollupToParent: boolean = true,
  ): Promise<SpendingByCategoryResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        SUM(${NET_SPEND_AMOUNT}) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND ${NONZERO_AMOUNT}
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = COALESCE(ts.category_id, t.category_id)
        )
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id), t.currency_code`;

    const rawResults: RawCategoryAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const parentTotals = new Map<
      string,
      { total: number; category: Category | null }
    >();

    for (const row of rawResults) {
      const total = this.currencyService.convertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const categoryId = row.category_id;

      if (!categoryId) {
        const existing = parentTotals.get("uncategorized");
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set("uncategorized", { total, category: null });
        }
        continue;
      }

      const category = categoryMap.get(categoryId);
      if (!category) {
        const existing = parentTotals.get("uncategorized");
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set("uncategorized", { total, category: null });
        }
        continue;
      }

      if (rollupToParent) {
        const parentCategory = category.parentId
          ? categoryMap.get(category.parentId)
          : null;
        const displayCategory = parentCategory || category;
        const displayId = displayCategory.id;

        const existing = parentTotals.get(displayId);
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set(displayId, { total, category: displayCategory });
        }
      } else {
        // Keep subcategory detail — format name as "Parent: Child"
        const parentCategory = category.parentId
          ? categoryMap.get(category.parentId)
          : null;
        const displayName = parentCategory
          ? `${parentCategory.name}: ${category.name}`
          : category.name;

        const existing = parentTotals.get(category.id);
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set(category.id, {
            total,
            category: { ...category, name: displayName } as Category,
          });
        }
      }
    }

    const data: CategorySpendingItem[] = Array.from(parentTotals.entries())
      .map(([id, { total, category }]) => ({
        categoryId: id === "uncategorized" ? null : id,
        categoryName: category?.name || "Uncategorized",
        color: category?.color || null,
        total: roundMoney(total),
      }))
      // Netting happens before this filter, so a category is judged on what it
      // cost after its refunds -- not on whether it happened to hold a debit.
      .filter((item) => isNetSpending(item.total))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    const totalSpending = sumMoney(data.map((item) => item.total));

    return {
      data,
      totalSpending: roundMoney(totalSpending),
    };
  }

  async getSpendingByPayee(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<SpendingByPayeeResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        t.payee_id,
        t.payee_name,
        t.currency_code,
        SUM(ABS(${REPORTABLE_TX_AMOUNT})) as total
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND ${REPORTABLE_TX_AMOUNT} < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION_NO_SPLITS}
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = t.category_id
        )
      `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += ` GROUP BY t.payee_id, t.payee_name, t.currency_code`;

    const rawResults: RawPayeeAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const payeeIds = rawResults
      .filter((r) => r.payee_id)
      .map((r) => r.payee_id as string);

    const payees =
      payeeIds.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Payee).findByIds(payeeIds),
          )
        : [];
    const payeeMap = new Map(payees.map((p) => [p.id, p]));

    const payeeTotals = new Map<
      string,
      { payeeId: string | null; payeeName: string; total: number }
    >();
    for (const row of rawResults) {
      const total = this.currencyService.convertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const key = row.payee_id || row.payee_name || "unknown";
      const payee = row.payee_id ? payeeMap.get(row.payee_id) : null;
      const existing = payeeTotals.get(key);
      if (existing) {
        existing.total += total;
      } else {
        payeeTotals.set(key, {
          payeeId: row.payee_id,
          payeeName: payee?.name || row.payee_name || "Unknown",
          total,
        });
      }
    }

    const data: PayeeSpendingItem[] = Array.from(payeeTotals.values())
      .map((row) => ({
        payeeId: row.payeeId,
        payeeName: row.payeeName,
        total: roundMoney(row.total),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);

    const totalSpending = sumMoney(data.map((item) => item.total));

    return {
      data,
      totalSpending: roundMoney(totalSpending),
    };
  }

  async getMonthlySpendingTrend(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<MonthlySpendingTrendResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        SUM(${NET_SPEND_AMOUNT}) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND ${NONZERO_AMOUNT}
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = COALESCE(ts.category_id, t.category_id)
        )
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'), COALESCE(ts.category_id, t.category_id), t.currency_code
      ORDER BY month
    `;

    const rawResults: RawMonthlyCategoryAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const monthlyData = new Map<
      string,
      Map<string, { total: number; category: Category | null }>
    >();

    for (const row of rawResults) {
      const month = row.month;
      const total = this.currencyService.convertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const categoryId = row.category_id;

      if (!monthlyData.has(month)) {
        monthlyData.set(month, new Map());
      }
      const monthMap = monthlyData.get(month)!;

      let displayId = "uncategorized";
      let displayCategory: Category | null = null;

      if (categoryId) {
        const category = categoryMap.get(categoryId);
        if (category) {
          const parentCategory = category.parentId
            ? categoryMap.get(category.parentId)
            : null;
          displayCategory = parentCategory || category;
          displayId = displayCategory.id;
        }
      }

      const existing = monthMap.get(displayId);
      if (existing) {
        existing.total += total;
      } else {
        monthMap.set(displayId, { total, category: displayCategory });
      }
    }

    const allCategoryTotals = new Map<string, number>();
    for (const monthMap of monthlyData.values()) {
      for (const [catId, { total }] of monthMap) {
        allCategoryTotals.set(
          catId,
          (allCategoryTotals.get(catId) || 0) + total,
        );
      }
    }
    // Whether a category belongs in a spending trend is decided over the whole
    // period, not per month: one month's refund is still part of a category
    // that was spent in. A category that is net-credit across the range was
    // not -- and an income category, now that credits are read at all, never
    // is one.
    const spendingCategories = new Set(
      Array.from(allCategoryTotals.entries())
        .filter(([, total]) => isNetSpending(roundMoney(total)))
        .map(([id]) => id),
    );
    const topCategories = Array.from(allCategoryTotals.entries())
      .filter(([id]) => spendingCategories.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);

    const data: MonthlySpendingItem[] = Array.from(monthlyData.entries())
      // Reading credits means a month holding nothing but income now produces a
      // bucket where the debit-only predicate produced no row at all. Such a
      // month has nothing to draw, so it stays out of a spending trend. The
      // test is whether the month touched a spending category at all, not the
      // sign of its own total -- a month that is one category's refund is still
      // that category's month -- and a month whose spending fell outside the
      // top ten is kept exactly as before.
      .filter(([, catMap]) =>
        Array.from(catMap.keys()).some((catId) =>
          spendingCategories.has(catId),
        ),
      )
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, catMap]) => {
        const categories: MonthlyCategorySpending[] = topCategories.map(
          (catId) => {
            const catData = catMap.get(catId);
            const category =
              catId === "uncategorized" ? null : categoryMap.get(catId);
            return {
              categoryId: catId === "uncategorized" ? null : catId,
              categoryName: category?.name || "Uncategorized",
              color: category?.color || null,
              total: roundMoney(catData?.total || 0),
            };
          },
        );

        const totalSpending = sumMoney(categories.map((cat) => cat.total));

        return {
          month,
          categories,
          totalSpending: roundMoney(totalSpending),
        };
      });

    return { data };
  }
}
