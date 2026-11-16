import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { NetWorthModule } from "@/net-worth/net-worth.module";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import { enumerateDaysYMD } from "@/net-worth/series-dates.util";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The daily cash series' KEYS, produced by the real SQL and read by the real
 * date walk, in a process whose local time changes inside the window.
 *
 * `net-worth.service.spec.ts` cannot answer this: its fixture builds the cash
 * rows with `enumerateDaysYMD` itself, so the two sides of the join agree by
 * construction and a key-format mismatch is invisible there. Only a real
 * PostgreSQL emits the `date::TEXT` the loader actually returns.
 *
 * The window straddles the Warsaw spring-forward (2026-03-29 has 23 hours), and
 * the process runs in `Europe/Warsaw` for the duration, because the shape this
 * replaced -- a local-midnight `Date` read back with `toISOString()` -- named
 * every day one early east of Greenwich and skipped the last one (#1389). A
 * day whose key does not match the row's key reads as a cash account with no
 * balance, which is `cashComplete: false`, so the assertion is both the date
 * list and the completeness of every point.
 */
describe("daily cash series dates (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let netWorth: NetWorthService;
  let userId: string;
  let account: Account;
  let originalTz: string | undefined;

  // Warsaw moves to CEST on 2026-03-29, inside this window.
  const START = "2026-03-27";
  const END = "2026-03-31";
  const DEPOSIT_DAY = "2026-03-29";

  beforeAll(async () => {
    originalTz = process.env.TZ;
    process.env.TZ = "Europe/Warsaw";
    module = await createIntegrationModule([NetWorthModule]);
    dataSource = module.get(DataSource);
    netWorth = module.get(NetWorthService);
  });

  afterAll(async () => {
    await module.close();
    process.env.TZ = originalTz;
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["transactions", "accounts", "users"]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    account = await createTestAccount(dataSource, userId, {
      name: "Brokerage cash",
      accountType: AccountType.INVESTMENT,
      currencyCode: "USD",
      openingBalance: 1000,
      currentBalance: 1500,
    });
    await dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId: account.id,
        transactionDate: DEPOSIT_DAY,
        amount: 500,
        currencyCode: "USD",
        exchangeRate: 1,
        description: "deposit",
        status: TransactionStatus.UNRECONCILED,
      } as never),
    );
  });

  it("keys every day the walk asks for, across a DST boundary", async () => {
    const series = await withUserContext(userId, () =>
      netWorth.getDailyInvestments(userId, START, END, [account.id], "USD"),
    );

    const expected = enumerateDaysYMD(START, END);
    expect(series.map((point) => point.date)).toEqual(expected);
    // Every day found its account's row: a key the SQL spells differently is an
    // account with no balance for the day, not a zero.
    expect(series.every((point) => point.cashComplete === true)).toBe(true);
    expect(
      series.every((point) => point.unknownCashAccountIds.length === 0),
    ).toBe(true);
    // The balances line up with the ledger on the days the keys claim, so the
    // agreement above is not two lists that merely happen to be the same length.
    expect(series.map((point) => point.value)).toEqual([
      1000, 1000, 1500, 1500, 1500,
    ]);
  });
});
