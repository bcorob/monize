import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import {
  ReportCurrencyService,
  RawCategoryAggregate,
  RawMonthlyAggregate,
} from "./report-currency.service";
import { roundMoney, sumMoney, toMoneyNumber } from "../common/round.util";
import {
  IncomeBySourceResponse,
  IncomeSourceItem,
  IncomeVsExpensesResponse,
  MonthlyIncomeExpenseItem,
} from "./dto";
import { investmentExclusionSql } from "../common/investment-filter.util";

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

@Injectable()
export class IncomeReportsService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  async getIncomeBySource(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<IncomeBySourceResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        SUM(COALESCE(ts.amount, t.amount)) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      INNER JOIN categories c ON c.id = COALESCE(ts.category_id, t.category_id)
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND c.is_income = true
        AND COALESCE(ts.amount, t.amount) > 0
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

    const categoryTotals = new Map<
      string,
      { total: number; category: Category }
    >();

    for (const row of rawResults) {
      const total = this.currencyService.convertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const categoryId = row.category_id;
      if (!categoryId) continue;

      const category = categoryMap.get(categoryId);
      if (!category) continue;

      const parentCategory = category.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const displayName = parentCategory
        ? `${parentCategory.name}: ${category.name}`
        : category.name;

      const existing = categoryTotals.get(category.id);
      if (existing) {
        existing.total += total;
      } else {
        categoryTotals.set(category.id, {
          total,
          category: { ...category, name: displayName } as Category,
        });
      }
    }

    const data: IncomeSourceItem[] = Array.from(categoryTotals.entries())
      .map(([id, { total, category }]) => ({
        categoryId: id,
        categoryName: category.name,
        color: category.color || null,
        total: roundMoney(total),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    const totalIncome = sumMoney(data.map((item) => item.total));

    return {
      data,
      totalIncome: roundMoney(totalIncome),
    };
  }

  async getIncomeVsExpenses(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<IncomeVsExpensesResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        t.currency_code,
        SUM(CASE
          WHEN c.is_income = true THEN COALESCE(ts.amount, t.amount)
          WHEN c.is_income = false THEN 0
          WHEN COALESCE(ts.amount, t.amount) > 0 THEN COALESCE(ts.amount, t.amount)
          ELSE 0
        END) as income,
        SUM(CASE
          WHEN c.is_income = false THEN -1 * COALESCE(ts.amount, t.amount)
          WHEN c.is_income = true THEN 0
          WHEN COALESCE(ts.amount, t.amount) < 0 THEN ABS(COALESCE(ts.amount, t.amount))
          ELSE 0
        END) as expenses
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN categories c ON c.id = COALESCE(ts.category_id, t.category_id)
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
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
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'), t.currency_code
      ORDER BY month
    `;

    const rawResults: RawMonthlyAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const monthlyMap = new Map<string, { income: number; expenses: number }>();
    for (const row of rawResults) {
      const income = this.currencyService.convertAmount(
        toMoneyNumber(row.income),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const expenses = this.currencyService.convertAmount(
        toMoneyNumber(row.expenses),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const existing = monthlyMap.get(row.month);
      if (existing) {
        existing.income += income;
        existing.expenses += expenses;
      } else {
        monthlyMap.set(row.month, { income, expenses });
      }
    }

    const data: MonthlyIncomeExpenseItem[] = Array.from(monthlyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, { income, expenses }]) => ({
        month,
        income: roundMoney(income),
        expenses: roundMoney(expenses),
        net: roundMoney(income - expenses),
      }));

    const totals = {
      income: sumMoney(data.map((item) => item.income)),
      expenses: sumMoney(data.map((item) => item.expenses)),
      net: sumMoney(data.map((item) => item.net)),
    };

    return {
      data,
      totals: {
        income: roundMoney(totals.income),
        expenses: roundMoney(totals.expenses),
        net: roundMoney(totals.net),
      },
    };
  }
}
