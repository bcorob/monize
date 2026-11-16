import {
  externalFlowSubtotalsSql,
  loadExternalFlowSubtotals,
} from "./external-flow.util";

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("external-flow.util", () => {
  describe("externalFlowSubtotalsSql", () => {
    /**
     * The statement `PortfolioMovementAlertService.externalFlow` issued before
     * this module existed, copied verbatim from its last commit with the two
     * shared exclusions expanded. This literal IS the proof that the extraction
     * changed no row: if the generated predicate ever stops matching it, the
     * daily movement notification has silently started measuring something else.
     * (The producer's own behaviour is covered by
     * `notification-center/portfolio-movement-alert.service.spec.ts`; what it
     * asks this SQL for is the `perDay` form.)
     */
    const ORIGINAL_UNSCOPED = `
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND a.account_type = 'INVESTMENT'
        AND t.parent_transaction_id IS NULL
        AND t.transaction_date > $2
        AND t.transaction_date <= $3
        AND t.status IS DISTINCT FROM 'VOID'
        AND NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM transaction_splits s
           WHERE s.transaction_id = t.id
             AND NOT (s.kind IS DISTINCT FROM 'investment'
        AND NOT EXISTS (SELECT 1 FROM investment_transactions its WHERE its.transaction_split_id = s.id))
        )
        AND NOT (
          t.is_transfer = true
          AND EXISTS (
            SELECT 1 FROM transactions lt
             JOIN accounts la ON la.id = lt.account_id
             WHERE lt.id = t.linked_transaction_id
               AND la.account_type = 'INVESTMENT'
          )
        )
      GROUP BY t.currency_code`;

    it("reproduces the notification's original statement exactly", () => {
      const sql = externalFlowSubtotalsSql({ scoped: false, perDay: false });
      // The only addition is a NULL date column, so one shape serves both
      // callers; every row-selecting clause is the original.
      expect(squash(sql)).toContain(squash(ORIGINAL_UNSCOPED));
      expect(squash(sql)).toContain(
        "SELECT NULL::TEXT AS date, t.currency_code AS currency, SUM(t.amount) AS total",
      );
    });

    it("draws the boundary around an explicit account set on both sides of a transfer", () => {
      const sql = squash(
        externalFlowSubtotalsSql({ scoped: true, perDay: false }),
      );
      // Both sides, or the predicate is not a boundary: scoping only the row's
      // own account would count a transfer between two scoped accounts.
      expect(sql).toContain("AND a.id = ANY($4::UUID[])");
      expect(sql).toContain("AND la.id = ANY($4::UUID[])");
      expect(sql).not.toContain("a.account_type = 'INVESTMENT'");
    });

    it("leaves out a transfer settling an action of the investment scope, only when asked", () => {
      const withScope = squash(
        externalFlowSubtotalsSql({
          scoped: true,
          perDay: false,
          investmentScoped: true,
        }),
      );
      // The counterpart is an investment action's cash leg on a scoped
      // account: the QIF/CSV import's settlement, inside the portfolio.
      expect(withScope).toContain(
        "AND (la.id = ANY($4::UUID[]) OR EXISTS ( SELECT 1 FROM investment_transactions lit WHERE lit.transaction_id = lt.id AND lit.account_id = ANY($5::UUID[]) ))",
      );

      // A statement that names no $5 is never bound one.
      const without = externalFlowSubtotalsSql({ scoped: true, perDay: false });
      expect(without).not.toContain("$5");
      const unscoped = externalFlowSubtotalsSql({
        scoped: false,
        perDay: false,
        investmentScoped: true,
      });
      expect(unscoped).not.toContain("$5");
    });

    it("subtotals per day only when asked", () => {
      const perDay = squash(
        externalFlowSubtotalsSql({ scoped: true, perDay: true }),
      );
      // The day is rendered, never cast: a `::TEXT` DATE follows the session's
      // DateStyle, and the caller keys a map on this string.
      expect(perDay).toContain(
        "TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date",
      );
      expect(perDay).not.toContain("t.transaction_date::TEXT");
      expect(perDay).toContain("GROUP BY t.transaction_date, t.currency_code");

      const whole = squash(
        externalFlowSubtotalsSql({ scoped: true, perDay: false }),
      );
      expect(whole).toContain("NULL::TEXT AS date");
      expect(whole).toContain("GROUP BY t.currency_code");
    });

    it("excludes a split child, a VOID row and an investment-linked row in every form", () => {
      for (const scoped of [true, false]) {
        for (const perDay of [true, false]) {
          const sql = squash(externalFlowSubtotalsSql({ scoped, perDay }));
          expect(sql).toContain("t.parent_transaction_id IS NULL");
          expect(sql).toContain("t.status IS DISTINCT FROM 'VOID'");
          expect(sql).toContain(
            "NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = t.id)",
          );
          expect(sql).toContain("s.kind IS DISTINCT FROM 'investment'");
          expect(sql).toContain("its.transaction_split_id = s.id");
        }
      }
    });
  });

  describe("loadExternalFlowSubtotals", () => {
    it("coerces the numeric column and carries the day through", async () => {
      const query = jest.fn().mockResolvedValue([
        { date: "2026-09-11", currency: "CAD", total: "1000.0000" },
        { date: "2026-09-11", currency: "USD", total: "-250.5000" },
      ]);

      const rows = await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
        perDay: true,
      });

      expect(rows).toEqual([
        { date: "2026-09-11", currency: "CAD", amount: 1000 },
        { date: "2026-09-11", currency: "USD", amount: -250.5 },
      ]);
    });

    it("reads the [rows, count] shape a driver may hand back", async () => {
      const query = jest
        .fn()
        .mockResolvedValue([[{ date: null, currency: "CAD", total: "5" }], 1]);

      const rows = await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
      });

      expect(rows).toEqual([{ date: null, currency: "CAD", amount: 5 }]);
    });

    it("passes the account ids as the fourth parameter when scoped", async () => {
      const query = jest.fn().mockResolvedValue([]);

      await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
        accountIds: ["acc-1"],
      });

      expect(query.mock.calls[0][1]).toEqual([
        "u1",
        "2026-09-10",
        "2026-09-11",
        ["acc-1"],
      ]);
    });

    it("binds the investment scope as the fifth parameter, and names it in the SQL", async () => {
      const query = jest.fn().mockResolvedValue([]);

      await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
        accountIds: ["cash-1"],
        investmentScope: ["brok-1", "cash-1"],
      });

      expect(query.mock.calls[0][1]).toEqual([
        "u1",
        "2026-09-10",
        "2026-09-11",
        ["cash-1"],
        ["brok-1", "cash-1"],
      ]);
      expect(query.mock.calls[0][0]).toContain("$5::UUID[]");
    });

    it.each([
      { name: "empty", investmentScope: [] as string[], accountIds: ["c"] },
      { name: "unscoped", investmentScope: ["b"], accountIds: undefined },
    ])(
      "binds no fifth parameter when the investment scope is $name",
      async ({ investmentScope, accountIds }) => {
        const query = jest.fn().mockResolvedValue([]);

        await loadExternalFlowSubtotals(query, {
          userId: "u1",
          afterDate: "2026-09-10",
          throughDate: "2026-09-11",
          accountIds,
          investmentScope,
        });

        expect(query.mock.calls[0][1]).toHaveLength(accountIds ? 4 : 3);
        expect(query.mock.calls[0][0]).not.toContain("$5");
      },
    );

    it("omits the fourth parameter when the scope is every investment account", async () => {
      const query = jest.fn().mockResolvedValue([]);

      await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
      });

      expect(query.mock.calls[0][1]).toEqual([
        "u1",
        "2026-09-10",
        "2026-09-11",
      ]);
    });

    it("totals nothing for an explicit but empty scope, and asks the database nothing", async () => {
      const query = jest.fn();

      const rows = await loadExternalFlowSubtotals(query, {
        userId: "u1",
        afterDate: "2026-09-10",
        throughDate: "2026-09-11",
        accountIds: [],
      });

      // An empty scope is a scope nothing is in -- NOT "every investment
      // account", which is what falling through to the unscoped form would mean.
      expect(rows).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
