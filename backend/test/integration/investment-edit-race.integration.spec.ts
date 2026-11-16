import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters: see the note at the top of
// holding-concurrent-trades.integration.spec.ts. InvestmentTransactionsService
// first, HoldingsService last.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { LockScope } from "@/common/db/locks";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";
import { raceTwo } from "../helpers/race";

/**
 * A26-H04 (A26-S12-01), INV-BALANCE-001 / INV-HOLDING-001 -- an investment
 * edit or delete decides from the row as it is under the holdings lock and its
 * own row lock, never from the snapshot `findOne` read before the transaction.
 *
 * The interleaving is forced with a gate: the test holds the holdings advisory
 * lock of the brokerage account on a third connection, so both racers read
 * their snapshot (the BUY and the cash row C1 it owns) and then park on the
 * lock `update()` / `remove()` take first. Releasing the gate lets one commit
 * (C1 replaced by C2) while the other waits; the second then runs.
 *
 * Unfixed, the second edit unlinks C2, finds C1 gone, reverses nothing and
 * posts a third cash row C3: two cash rows, -2,200.00, balance 97,800.00. A
 * delete behind an edit reverses only C1 and leaves C2 with no investment row.
 * Fixed, the second request is refused (409 behind an edit, 404 behind a
 * delete) and the cash account equals its ledger.
 */
describe("investment edit and delete race (integration, A26-H04)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingAccountId: string;
  let securityId: string;
  let buyId: string;

  const OPENING_BALANCE = 100000;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "securities",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    brokerageAccountId = brokerage.id;

    const funding = await createTestAccount(dataSource, userId, {
      name: "Funding",
      openingBalance: OPENING_BALANCE,
      currentBalance: OPENING_BALANCE,
    });
    fundingAccountId = funding.id;

    const security = await withUserContext(userId, () =>
      module.get(SecuritiesService).create(userId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;

    // BUY 10 @ 100.00: cash row C1 of -1,000.00, balance 99,000.00.
    const created = await withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageAccountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityId,
        fundingAccountId,
        quantity: 10,
        price: 100,
        commission: 0,
      } as any),
    );
    buyId = created.id;
  });

  /** Both racers read their snapshot, then park on the holdings lock. */
  const gate = () => ({
    sql: "SELECT pg_advisory_xact_lock($1::int, hashtext($2))",
    params: [LockScope.Holdings, brokerageAccountId],
  });

  const edit = () =>
    withUserContext(userId, () =>
      investments.update(userId, buyId, { price: 110 } as any),
    );
  const remove = () =>
    withUserContext(userId, () => investments.remove(userId, buyId));

  async function fundingState(): Promise<{
    balance: number;
    ledger: number;
    cashRows: { id: string; amount: number; owner: string | null }[];
  }> {
    const [{ balance }]: { balance: string }[] = await dataSource.query(
      `SELECT current_balance AS balance FROM accounts WHERE id = $1`,
      [fundingAccountId],
    );
    const rows: { id: string; amount: string; owner: string | null }[] =
      await dataSource.query(
        `SELECT t.id, t.amount,
                (SELECT it.id FROM investment_transactions it
                  WHERE it.transaction_id = t.id) AS owner
           FROM transactions t WHERE t.account_id = $1`,
        [fundingAccountId],
      );
    const cashRows = rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      owner: r.owner,
    }));
    return {
      balance: Number(balance),
      ledger: cashRows.reduce((sum, r) => sum + r.amount, 0),
      cashRows,
    };
  }

  const statusOf = (reason: unknown) =>
    (reason as { getStatus?: () => number })?.getStatus?.();

  it("a double-submitted edit of one BUY moves the cash once", async () => {
    const outcome = await raceTwo(dataSource, edit, edit, { gate: gate() });

    const state = await fundingState();
    expect({ balance: state.balance, ledger: state.ledger }).toEqual({
      balance: 98900,
      ledger: -1100,
    });
    expect(state.cashRows).toHaveLength(1);
    expect(state.cashRows[0]).toEqual(
      expect.objectContaining({ amount: -1100, owner: buyId }),
    );
    expect(outcome.fulfilled).toBe(1);
    expect(outcome.reasons.map(statusOf)).toEqual([409]);
  });

  it("an edit racing a delete leaves no orphan cash row", async () => {
    const outcome = await raceTwo(dataSource, edit, remove, { gate: gate() });

    const state = await fundingState();
    const [row] = await dataSource.query(
      `SELECT id FROM investment_transactions WHERE id = $1`,
      [buyId],
    );

    // Every cash row has its investment row, and the balance is the ledger.
    expect(state.cashRows.filter((r) => r.owner === null)).toEqual([]);
    expect(state.balance).toBeCloseTo(OPENING_BALANCE + state.ledger, 4);
    expect(outcome.fulfilled).toBe(1);

    if (outcome.a.status === "fulfilled") {
      // The edit committed first: the delete read C1 and is refused.
      expect(outcome.reasons.map(statusOf)).toEqual([409]);
      expect(row).toBeDefined();
      expect(state.cashRows.map((r) => r.amount)).toEqual([-1100]);
      expect(state.balance).toBeCloseTo(98900, 4);
    } else {
      // The delete committed first: the edit finds no row.
      expect(outcome.reasons.map(statusOf)).toEqual([404]);
      expect(row).toBeUndefined();
      expect(state.cashRows).toHaveLength(0);
      expect(state.balance).toBeCloseTo(OPENING_BALANCE, 4);
    }
  });
});
