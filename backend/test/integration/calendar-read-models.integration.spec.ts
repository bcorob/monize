import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsController } from "@/accounts/accounts.controller";
import { NetWorthModule } from "@/net-worth/net-worth.module";
import { NetWorthController } from "@/net-worth/net-worth.controller";
import { SecuritiesModule } from "@/securities/securities.module";
import { PortfolioController } from "@/securities/portfolio.controller";
import { withScopedDb } from "@/common/db/scoped-db";
import { withDelegateContext, withUserContext } from "@/common/db/with-context";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The calendar's three read models (design section 6) against a database that
 * is actually enforcing row-level security.
 *
 * What only this suite can answer: each of the three resolves its own scope --
 * `daily-balance-totals` widens to joint accounts, the two investment models
 * resolve linked pairs -- and a scope resolved from a request is exactly where
 * a foreign account id gets in. The unit specs prove the arithmetic against a
 * mocked manager, which by construction returns whatever the fixture says and
 * so cannot tell a correctly scoped query from one that would have returned a
 * stranger's rows.
 *
 * Three callers, because the three see the same endpoint differently: the owner,
 * a delegate acting for the owner (restricted to their READ grants), and a joint
 * grantee reading in their OWN context (no acting switch -- the shared account
 * participates exactly like one of their own).
 *
 * Dates are fixed in the past so every assertion is about history: a projected
 * day is decided by the server's today, and a fixture dated near it would move
 * between actual and projected as the clock passes it.
 */
describe("Calendar read models under RLS enforcement", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  /** The table owner. Seeds and cleans; never the connection under test. */
  let db: DataSource;
  /** The module's own connection, as the unprivileged runtime role. */
  let app: DataSource;

  let accounts: AccountsController;
  let netWorth: NetWorthController;
  let portfolio: PortfolioController;

  /** Alice owns everything the calendars read. */
  let aliceId: string;
  /** Dave acts for Alice, with READ on the granted brokerage only. */
  let daveId: string;
  /** Jo holds a joint grant on Alice's chequing and nothing else. */
  let joId: string;
  /** Sam is a stranger: the source of every foreign id below. */
  let samId: string;

  let chequingId: string;
  let grantedBrokerageId: string;
  let ungrantedBrokerageId: string;
  let samAccountId: string;
  let samBrokerageId: string;
  let delegationId: string;

  const START = "2024-06-10";
  const MIDDLE = "2024-06-11";
  const END = "2024-06-12";

  /** The request shape `JwtStrategy.validate` builds for an owner. */
  function ownContext(userId: string) {
    return {
      user: {
        id: userId,
        realUserId: userId,
        isActing: false,
        delegationId: null,
      },
    } as never;
  }

  /** ...and for a delegate acting as the owner: `id` IS the owner's. */
  function actingContext() {
    return {
      user: {
        id: aliceId,
        realUserId: daveId,
        isActing: true,
        delegationId,
      },
    } as never;
  }

  /** Runs `fn` under the identity the RequestContextInterceptor would seed. */
  function asOwner<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return withUserContext(userId, fn);
  }

  function asDelegate<T>(fn: () => Promise<T>): Promise<T> {
    return withDelegateContext(aliceId, daveId, fn);
  }

  async function seedSecurity(userId: string, symbol: string): Promise<string> {
    const [row] = await db.query(
      `INSERT INTO securities (user_id, symbol, name, currency_code, skip_price_updates)
       VALUES ($1, $2, $2, 'USD', true) RETURNING id`,
      [userId, symbol],
    );
    return row.id;
  }

  async function seedBuy(
    userId: string,
    accountId: string,
    securityId: string,
    quantity: number,
    price: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, action, transaction_date, quantity,
          price, total_amount, status)
       VALUES ($1, $2, $3, 'BUY', DATE '2024-06-09', $4, $5, $6, 'UNRECONCILED')`,
      [userId, accountId, securityId, quantity, price, quantity * price],
    );
  }

  async function seedClose(
    securityId: string,
    date: string,
    close: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO security_prices (security_id, price_date, close_price, source)
       VALUES ($1, $2::DATE, $3, 'manual')`,
      [securityId, date, close],
    );
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      AccountsModule,
      NetWorthModule,
      SecuritiesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    app = harness.app;
    accounts = module.get(AccountsController);
    netWorth = module.get(NetWorthController);
    portfolio = module.get(PortfolioController);

    await cleanTables(db, [
      "transaction_splits",
      "transactions",
      "investment_transactions",
      "security_prices",
      "securities",
      "account_delegate_grants",
      "account_delegates",
      "accounts",
      "user_preferences",
      "users",
    ]);
    await db.query(
      "INSERT INTO currencies (code, name, symbol) VALUES ('USD', 'US Dollar', '$') ON CONFLICT DO NOTHING",
    );

    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    daveId = (await createTestUserDirect(db, { firstName: "Dave" })).id;
    joId = (await createTestUserDirect(db, { firstName: "Jo" })).id;
    samId = (await createTestUserDirect(db, { firstName: "Sam" })).id;

    chequingId = (
      await createTestAccount(db, aliceId, {
        name: "Alice Chequing",
        openingBalance: 0,
        currentBalance: 1000,
      })
    ).id;
    grantedBrokerageId = (
      await createTestAccount(db, aliceId, {
        name: "Alice Granted Brokerage",
        accountType: "INVESTMENT",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    ungrantedBrokerageId = (
      await createTestAccount(db, aliceId, {
        name: "Alice Private Brokerage",
        accountType: "INVESTMENT",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    samAccountId = (
      await createTestAccount(db, samId, {
        name: "Sam Chequing",
        openingBalance: 0,
        currentBalance: 7777,
      })
    ).id;
    samBrokerageId = (
      await createTestAccount(db, samId, {
        name: "Sam Brokerage",
        accountType: "INVESTMENT",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;

    // One posted inflow, dated before the window, so every day of the window
    // closes at the same actual balance and a wrong scope shows up as a
    // different number rather than as a missing day.
    await db.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code, description, status)
       VALUES ($1, $2, DATE '2024-06-01', 1000, 'USD', 'Payroll', 'RECONCILED')`,
      [aliceId, chequingId],
    );
    await db.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code, description, status)
       VALUES ($1, $2, DATE '2024-06-01', 7777, 'USD', 'Sam payroll', 'RECONCILED')`,
      [samId, samAccountId],
    );

    // ACME moves between the two closes; ZETA is flat, so the ungranted
    // brokerage changes the VALUE both callers see without changing the
    // movement -- which keeps the two assertions independent.
    const acme = await seedSecurity(aliceId, "ACME");
    const zeta = await seedSecurity(aliceId, "ZETA");
    const samSecurity = await seedSecurity(samId, "SAMX");
    await seedBuy(aliceId, grantedBrokerageId, acme, 10, 50);
    await seedBuy(aliceId, ungrantedBrokerageId, zeta, 5, 20);
    await seedBuy(samId, samBrokerageId, samSecurity, 3, 100);
    for (const [date, acmeClose] of [
      [START, 50],
      [MIDDLE, 52],
      [END, 52],
    ] as const) {
      await seedClose(acme, date, acmeClose);
      await seedClose(zeta, date, 20);
      await seedClose(samSecurity, date, 100);
    }

    const [delegation] = await db.query(
      `INSERT INTO account_delegates
         (owner_user_id, delegate_user_id, status, investments_can_read)
       VALUES ($1, $2, 'active', true) RETURNING id`,
      [aliceId, daveId],
    );
    delegationId = delegation.id;
    await db.query(
      `INSERT INTO account_delegate_grants (delegation_id, account_id, can_read)
       VALUES ($1, $2, true)`,
      [delegationId, grantedBrokerageId],
    );

    const [jointDelegation] = await db.query(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [aliceId, joId],
    );
    await db.query(
      `INSERT INTO account_delegate_grants
         (delegation_id, account_id, can_read, is_joint)
       VALUES ($1, $2, true, true)`,
      [jointDelegation.id, chequingId],
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  it("is enforcing: the runtime role sees only the identity's own rows", async () => {
    // A floor under every assertion below. Were the module still connected as
    // the table owner, or were RLS_MODE left at off, each endpoint's own
    // `WHERE user_id = $1` would produce the same answers and this suite would
    // report the service's predicate as though it were the policy's.
    const rows = await asOwner(aliceId, () =>
      withScopedDb(app, (m) => m.query("SELECT id FROM accounts")),
    );
    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual(
      [chequingId, grantedBrokerageId, ungrantedBrokerageId].sort(),
    );

    const outside = await app.query("SELECT count(*)::int AS n FROM accounts");
    expect(outside[0].n).toBe(0);
  });

  describe("GET /accounts/daily-balance-totals", () => {
    it("totals the owner's own scope, and echoes the server's today", async () => {
      const response = await asOwner(aliceId, () =>
        accounts.getDailyBalanceTotals(ownContext(aliceId), {
          startDate: START,
          endDate: END,
        }),
      );

      expect(response.currencyCode).toBe("USD");
      expect(response.days.map((d) => d.date)).toEqual([START, MIDDLE, END]);
      // The chequing's ledger, and nothing from the two investment accounts
      // (no cash movement) or from Sam's 7,777.
      expect(response.days.map((d) => d.total)).toEqual([1000, 1000, 1000]);
      expect(response.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(response.days.every((d) => d.isProjected)).toBe(false);
      expect(response.forecast.complete).toBe(true);
    });

    it("returns nothing, and leaks nothing, for a foreign account id", async () => {
      const response = await asOwner(aliceId, () =>
        accounts.getDailyBalanceTotals(ownContext(aliceId), {
          startDate: START,
          endDate: END,
          accountIds: [samAccountId],
        }),
      );

      // An empty scope, not a 404: the same shape `daily-balances` returns, so
      // a client cannot tell a stranger's id from one of the caller's own
      // closed accounts -- which is the point.
      expect(response.scopeEmpty).toBe(true);
      expect(response.days.map((d) => d.total)).toEqual([null, null, null]);
      expect(response.days.map((d) => d.knownSubtotal)).toEqual([0, 0, 0]);
      expect(JSON.stringify(response)).not.toContain("7777");
    });

    it("counts a joint account for the grantee reading in their own context", async () => {
      const response = await asOwner(joId, () =>
        accounts.getDailyBalanceTotals(ownContext(joId), {
          startDate: START,
          endDate: END,
        }),
      );

      // Jo owns no account at all, so this total is the shared one or nothing.
      expect(response.days.map((d) => d.total)).toEqual([1000, 1000, 1000]);
      expect(response.currencyCode).toBe("USD");
    });

    it("restricts an acting delegate to the accounts they were granted", async () => {
      const response = await asDelegate(() =>
        accounts.getDailyBalanceTotals(actingContext(), {
          startDate: START,
          endDate: END,
        }),
      );

      // The grant is the brokerage, whose ledger is empty. Alice's 1,000 is
      // hers: an unfiltered owner-wide query would have reported it.
      expect(response.days.map((d) => d.total)).toEqual([0, 0, 0]);
    });
  });

  describe("GET /net-worth/investments-daily", () => {
    it("values every investment account the owner holds", async () => {
      const points = await asOwner(aliceId, () =>
        netWorth.getDailyInvestments(ownContext(aliceId), START, END),
      );

      const byDate = new Map(points.map((p) => [p.date, p]));
      // 10 ACME at 52 plus 5 ZETA at 20.
      expect(byDate.get(MIDDLE)?.value).toBe(620);
      expect(byDate.get(START)?.value).toBe(600);
      expect(byDate.get(MIDDLE)?.pricesComplete).toBe(true);
      expect(byDate.get(MIDDLE)?.unpricedSecurityIds).toEqual([]);
    });

    it("values the granted brokerage alone for an acting delegate", async () => {
      const points = await asDelegate(() =>
        netWorth.getDailyInvestments(actingContext(), START, END),
      );

      // The ungranted brokerage's 100 is absent, so this is the granted
      // account's ACME alone rather than the owner's whole portfolio.
      expect(new Map(points.map((p) => [p.date, p.value])).get(MIDDLE)).toBe(
        520,
      );
    });

    it("returns nothing for a foreign account id", async () => {
      const points = await asOwner(aliceId, () =>
        netWorth.getDailyInvestments(
          ownContext(aliceId),
          START,
          END,
          samBrokerageId,
        ),
      );
      expect(points).toEqual([]);
    });
  });

  describe("GET /portfolio/daily-movements", () => {
    it("measures the owner's whole portfolio against its own prior close", async () => {
      const response = await asOwner(aliceId, () =>
        portfolio.getDailyMovements(ownContext(aliceId), {
          startDate: MIDDLE,
          endDate: MIDDLE,
        }),
      );

      const [day] = response.days;
      expect(day.date).toBe(MIDDLE);
      expect(day.isTradingDay).toBe(true);
      expect(day.complete).toBe(true);
      // 620 - 600, with no external flow on the day.
      expect(day.movement).toBe(20);
      expect(day.movementPercent).toBeCloseTo(3.33, 2);
      expect(day.reasons).toEqual([]);
    });

    it("measures only the granted brokerage for an acting delegate", async () => {
      const response = await asDelegate(() =>
        portfolio.getDailyMovements(actingContext(), {
          startDate: MIDDLE,
          endDate: MIDDLE,
        }),
      );

      const [day] = response.days;
      // The same 20 of movement, but over a 500 baseline rather than 600 --
      // a scope that had leaked the ungranted account would read 3.33%.
      expect(day.movement).toBe(20);
      expect(day.movementPercent).toBeCloseTo(4, 2);
    });

    it("breaks the day down by security without naming a stranger's", async () => {
      const detail = await asOwner(aliceId, () =>
        portfolio.getDailyMovementDetail(ownContext(aliceId), {
          date: MIDDLE,
        }),
      );

      expect(detail.gains.map((g) => g.symbol)).toEqual(["ACME"]);
      expect(detail.losses).toEqual([]);
      // ZETA closed on the day and did not move.
      expect(detail.unchangedCount).toBe(1);
      expect(detail.remainder).toBe(0);
      expect(JSON.stringify(detail)).not.toContain("SAMX");
    });

    it("returns no movement for a foreign account id", async () => {
      const response = await asOwner(aliceId, () =>
        portfolio.getDailyMovements(ownContext(aliceId), {
          startDate: MIDDLE,
          endDate: MIDDLE,
          accountIds: [samBrokerageId],
        }),
      );

      const [day] = response.days;
      expect(day.complete).toBe(false);
      expect(day.movement).toBeNull();
      expect(day.movementPercent).toBeNull();
    });
  });
});
