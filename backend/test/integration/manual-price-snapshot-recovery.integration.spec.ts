import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { SecurityPriceService } from "@/securities/security-price.service";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext, withPreserveTimestamps } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";

/**
 * MZ-1242-R5 / R9 -- crash recovery for a manual-price snapshot invalidation,
 * exercised through the real mutation path.
 *
 * The property is not "if a durable marker already exists the sweep sees it"; it
 * is "the manual-price mutation atomically leaves that marker, and the sweep
 * recovers the recompute if the process-local debounce is lost". So this drives
 * the real `SecurityPriceService.createManualPrice` -- not a hand-seeded
 * `accounts.updated_at` -- and separately proves the price write and the marker
 * cannot split across a failure boundary.
 *
 * `createIntegrationModule` stubs `triggerDebouncedRecalc` to a no-op, which is
 * exactly the "debounce lost" condition: recovery must come from the sweep, off
 * the `accounts.updated_at` marker the mutation committed in its own
 * transaction. A mocked `manager.query` cannot prove either half -- the sweep
 * defect lived in timestamp arithmetic PostgreSQL evaluates, and atomicity is a
 * transaction-boundary property -- so this is a real-database test.
 *
 * The service is constructed directly with the real DataSource and NetWorthService;
 * its quote-provider registry is unused by `createManualPrice`, which only writes
 * `security_prices` and touches the holding accounts.
 */
describe("manual-price crash recovery (integration, MZ-1242-R5/R9)", () => {
  let module: TestingModule;
  let netWorth: NetWorthService;
  let priceService: SecurityPriceService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;
  let securityId: string;

  const QUANTITY = 120;
  const TRANSACTION_PRICE = 61; // the pre-#1242 valuation basis
  const MANUAL_PRICE = 120; // the accepted correction
  const STALE_MARKET_VALUE = QUANTITY * TRANSACTION_PRICE; // 7,320
  const EXPECTED_MARKET_VALUE = QUANTITY * MANUAL_PRICE; // 14,400

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    netWorth = module.get(NetWorthService);
    dataSource = module.get(DataSource);
    // createManualPrice uses only the DataSource and NetWorthService; the quote
    // provider registry it also takes is never touched on this path.
    priceService = new SecurityPriceService(
      dataSource,
      netWorth,
      {} as never,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "monthly_account_balances",
      "investment_transactions",
      "security_prices",
      "securities",
      "accounts",
      "user_preferences",
      "currencies",
      "users",
    ]);

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, created_by_user_id)
       VALUES ('USD', 'US Dollar', '$', $1)`,
      [userId],
    );

    // Brokerage account with an old updated_at, so a manual-price mutation
    // advancing it is observable. The updated_at trigger fires BEFORE UPDATE
    // only, so an explicit value on INSERT stands.
    const accountRows = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance,
                             created_at, updated_at)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Sample Retirement Plan',
               'USD', 0, 0, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 hour')
       RETURNING id`,
      [userId],
    );
    accountId = accountRows[0].id;

    const securityRows = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, currency_code,
                              skip_price_updates)
       VALUES ($1, 'BMT-DEMO', 'Broad Market Tracker', 'USD', true)
       RETURNING id`,
      [userId],
    );
    securityId = securityRows[0].id;

    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, action, transaction_date, quantity,
          price, total_amount, status)
       VALUES ($1, $2, $3, 'BUY', DATE '2024-01-15', $4, $5, $6, 'UNRECONCILED')`,
      [
        userId,
        accountId,
        securityId,
        QUANTITY,
        TRANSACTION_PRICE,
        QUANTITY * TRANSACTION_PRICE,
      ],
    );

    // The stale snapshot computed 20 minutes ago under the old $61 basis.
    await dataSource.query(
      `INSERT INTO monthly_account_balances
         (user_id, account_id, month, balance, market_value, created_at, updated_at)
       VALUES ($1, $2, DATE_TRUNC('month', CURRENT_DATE)::date, 0, $3,
               NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes')`,
      [userId, accountId, STALE_MARKET_VALUE],
    );
  });

  async function accountUpdatedAt(): Promise<Date> {
    const rows = await dataSource.query(
      `SELECT updated_at FROM accounts WHERE id = $1`,
      [accountId],
    );
    return new Date(rows[0].updated_at);
  }

  it("recovers a manual-price recompute lost with the debounce, via the real mutation path", async () => {
    const before = await accountUpdatedAt();

    // The real mutation: writes the $120 manual price and, in the same
    // transaction, advances accounts.updated_at for the holding account. The
    // debounce it schedules afterward is the stubbed no-op (the crash case).
    await withUserContext(userId, () =>
      priceService.createManualPrice(
        securityId,
        { priceDate: new Date().toISOString().slice(0, 10), closePrice: MANUAL_PRICE },
        userId,
      ),
    );

    // The mutation produced the durable marker.
    const after = await accountUpdatedAt();
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    // Simulate the ten-minute grace elapsing without sleeping: age the marker
    // the mutation just wrote to 19 minutes ago (still newer than the 20-minute
    // snapshot). Under app.preserve_timestamps the updated_at trigger keeps the
    // supplied value instead of re-stamping now().
    await withUserContext(userId, () =>
      withPreserveTimestamps(() =>
        withScopedDb(dataSource, (m) =>
          m.query(
            `UPDATE accounts SET updated_at = NOW() - INTERVAL '19 minutes'
              WHERE id = $1`,
            [accountId],
          ),
        ),
      ),
    );

    await netWorth.sweepStaleSnapshots();

    const rows = await dataSource.query(
      `SELECT market_value FROM monthly_account_balances
        WHERE account_id = $1 ORDER BY month DESC LIMIT 1`,
      [accountId],
    );
    // 120 shares * $120 accepted close = $14,400, not the stale 120 * $61.
    expect(Number(rows[0].market_value)).toBe(EXPECTED_MARKET_VALUE);
  });

  it("commits the manual price and the stale marker atomically", async () => {
    // Force the holding-account marker UPDATE to fail after the price INSERT has
    // executed inside the same transaction. If the two were not one transaction,
    // the price row would survive; it must not.
    await dataSource.query(
      `CREATE OR REPLACE FUNCTION test_fail_account_update()
         RETURNS trigger AS $$ BEGIN
           RAISE EXCEPTION 'failpoint: account update';
         END; $$ LANGUAGE plpgsql`,
    );
    await dataSource.query(
      `CREATE TRIGGER test_fail_account_update
         BEFORE UPDATE ON accounts
         FOR EACH ROW EXECUTE FUNCTION test_fail_account_update()`,
    );

    try {
      await expect(
        withUserContext(userId, () =>
          priceService.createManualPrice(
            securityId,
            {
              priceDate: new Date().toISOString().slice(0, 10),
              closePrice: MANUAL_PRICE,
            },
            userId,
          ),
        ),
      ).rejects.toThrow();

      const rows = await dataSource.query(
        `SELECT COUNT(*)::int AS n FROM security_prices
          WHERE security_id = $1 AND source = 'manual'`,
        [securityId],
      );
      // The price write rolled back with the failed marker update.
      expect(rows[0].n).toBe(0);
    } finally {
      await dataSource.query(
        `DROP TRIGGER IF EXISTS test_fail_account_update ON accounts`,
      );
      await dataSource.query(
        `DROP FUNCTION IF EXISTS test_fail_account_update()`,
      );
    }
  });
});
