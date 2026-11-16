import { DataSource } from "typeorm";

import { BudgetPeriodService } from "@/budgets/budget-period.service";
import { BudgetsService } from "@/budgets/budgets.service";
import { Budget } from "@/budgets/entities/budget.entity";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { openPeerDataSource, raceTwo } from "../helpers/race";

/**
 * Two replicas creating the same month's budget period leave one period, and
 * both requests succeed with it (A26-S05-01, A26-S16-09; INV-CRON-001 for the
 * rollover that calls it).
 *
 * `BudgetPeriodService.createPeriodForBudget` decides who creates the month
 * with `INSERT ... ON CONFLICT (budget_id, period_start) DO NOTHING RETURNING`,
 * and the loser reads the winner's row instead of failing its request. The
 * arbiter is `UNIQUE(budget_id, period_start)`, which `schema.sql` declares and
 * the entity does not: before the harness carried production's unique keys
 * (test/helpers/schema-constraints.ts) this statement failed here with 42P10, so
 * no suite could run the production write path at all.
 *
 * The interleaving is forced, not hoped for. A gate holds the budget row
 * `FOR UPDATE`; replica A's insert places its index entry and parks on the
 * foreign-key check (a `FOR KEY SHARE` on that row), and replica B's
 * speculative insert then waits on A's uncommitted entry. Both are lock-blocked
 * before the gate is released, so B meets A's row through the unique index,
 * never after A's commit by luck of scheduling. Without `ON CONFLICT` (the
 * mutation this catches) B fails with 23505 and its request is lost.
 */
describe("budget period creation race (two instances, real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let periodsA: BudgetPeriodService;
  let periodsB: BudgetPeriodService;
  let ownerId: string;
  let budgetId: string;

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    dataSourceB = await openPeerDataSource(dataSourceA);

    // `createPeriodForBudget` reads nothing through BudgetsService; the
    // budget it is handed is the whole input.
    const unused = {} as BudgetsService;
    periodsA = new BudgetPeriodService(unused, dataSourceA);
    periodsB = new BudgetPeriodService(unused, dataSourceB);
  });

  afterAll(async () => {
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
  });

  beforeEach(async () => {
    await cleanTables(dataSourceA, [
      "budget_period_categories",
      "budget_periods",
      "budget_categories",
      "budgets",
      "categories",
      "users",
    ]);
    await dataSourceA.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    ownerId = (await createTestUserDirect(dataSourceA)).id;
    const [category] = await dataSourceA.query(
      `INSERT INTO categories (user_id, name) VALUES ($1, 'Groceries') RETURNING id`,
      [ownerId],
    );
    const [budget] = await dataSourceA.query(
      `INSERT INTO budgets (user_id, name, period_start, currency_code)
       VALUES ($1, 'Household', '2026-01-01', 'USD') RETURNING id`,
      [ownerId],
    );
    budgetId = budget.id;
    await dataSourceA.query(
      `INSERT INTO budget_categories (budget_id, category_id, amount)
       VALUES ($1, $2, 500)`,
      [budgetId, category.id],
    );
  });

  const loadBudget = (): Promise<Budget> =>
    withUserContext(ownerId, () =>
      withScopedDb(dataSourceA, (m) =>
        m.getRepository(Budget).findOneOrFail({
          where: { id: budgetId },
          relations: ["categories"],
        }),
      ),
    );

  it("two concurrent creations of one month's period leave one row and both succeed", async () => {
    const budget = await loadBudget();

    const outcome = await raceTwo(
      dataSourceA,
      () =>
        withUserContext(ownerId, () => periodsA.createPeriodForBudget(budget)),
      () =>
        withUserContext(ownerId, () => periodsB.createPeriodForBudget(budget)),
      {
        gate: {
          sql: `SELECT id FROM budgets WHERE id = $1 FOR UPDATE`,
          params: [budgetId],
        },
      },
    );

    expect(outcome.reasons).toEqual([]);
    if (outcome.a.status !== "fulfilled" || outcome.b.status !== "fulfilled") {
      throw new Error("both creations must succeed");
    }
    expect(outcome.a.value.id).toBe(outcome.b.value.id);

    const periods: { id: string }[] = await dataSourceA.query(
      `SELECT id FROM budget_periods WHERE budget_id = $1`,
      [budgetId],
    );
    expect(periods).toHaveLength(1);
    // The loser wrote no category rows of its own: the winner's one line.
    const lines: unknown[] = await dataSourceA.query(
      `SELECT 1 FROM budget_period_categories WHERE budget_period_id = $1`,
      [periods[0].id],
    );
    expect(lines).toHaveLength(1);
  });
});
