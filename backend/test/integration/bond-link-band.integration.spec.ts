import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { manifestDocument } from "@/bonds/adapters/pl/pl-test-input";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondInstrumentId, bondProgramId } from "@/bonds/bond-instrument-id";
import { withUserContext } from "@/common/db/with-context";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  insertBondProgram,
  storeFixtureSeries,
} from "../helpers/integration-setup";

/**
 * INV-BOND-005 (a linked security's quantities are counts of bonds, on EVERY
 * write) and INV-BOND-007 (a split parent's delete and void are checked like any
 * other removal) against a real PostgreSQL. The outer join over the program's
 * series, the template face value the empty catalog falls back to and the
 * rollback of a refused parent operation are properties of the database that a
 * mocked manager cannot show.
 */
describe("a bond-linked security's quantities are numbers of bonds (integration, INV-BOND-005)", () => {
  jest.setTimeout(120000);

  let module: TestingModule;
  let dataSource: DataSource;
  let investments: InvestmentTransactionsService;
  let securities: SecuritiesService;
  let transactions: TransactionsService;
  let catalog: BondCatalogService;

  let userId: string;
  let accountId: string;
  let cashAccountId: string;
  let securityId: string;

  const EDO_PROGRAM = bondProgramId("PL", "PL_MF", "EDO");
  const code = (errorCode: string) => ({ response: { errorCode } });

  beforeAll(async () => {
    module = await createIntegrationModule([
      SecuritiesModule,
      TransactionsModule,
    ]);
    dataSource = module.get(DataSource);
    investments = module.get(InvestmentTransactionsService);
    securities = module.get(SecuritiesService);
    transactions = module.get(TransactionsService);
    catalog = module.get(BondCatalogService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "security_prices",
      "investment_transactions",
      "transaction_splits",
      "transactions",
      "securities",
      "accounts",
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'zl', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    accountId = await insertAccount("Brokerage", "INVESTMENT_BROKERAGE", null);
    cashAccountId = await insertAccount(
      "Brokerage Cash",
      "INVESTMENT_CASH",
      accountId,
    );
  });

  async function insertAccount(
    name: string,
    subType: string,
    linkedAccountId: string | null,
  ): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance,
                             linked_account_id)
       VALUES ($1, 'INVESTMENT', $2, $3, 'PLN', 0, 0, $4)
       RETURNING id`,
      [userId, subType, name, linkedAccountId],
    );
    return rows[0].id;
  }

  async function insertSecurity(
    symbol: string,
    programId: string | null,
  ): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
       VALUES ($1, $2, $2, 'BOND', 'PLN', $3)
       RETURNING id`,
      [userId, symbol, programId],
    );
    return rows[0].id;
  }

  /** A row written straight to the table, as a legacy path would. */
  async function raw(
    security: string,
    action: string,
    date: string,
    quantity: number,
    price: number,
    series: string | null = null,
  ): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'UNRECONCILED')
       RETURNING id`,
      [
        userId,
        accountId,
        security,
        series,
        action,
        date,
        quantity,
        price,
        quantity * price,
      ],
    );
    return rows[0].id;
  }

  async function storeSeries(
    seriesCode: string,
    from: string,
    to: string,
  ): Promise<string> {
    const id = bondInstrumentId("PL", "PL_MF", seriesCode);
    const terms = manifestDocument("edo1036");
    terms.instrument.seriesCode = seriesCode;
    terms.saleWindow = { from, to };
    await dataSource.query(
      `INSERT INTO bond_instruments (id, issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
       VALUES ($1, 'PL', 'PL_MF', 'EDO', $2, $3, 'PLN', 'RETAIL_REDEEMABLE')`,
      [id, EDO_PROGRAM, seriesCode],
    );
    await dataSource.query(
      `INSERT INTO bond_terms_versions (bond_instrument_id, version, terms, content_hash, source_url, retrieved_at)
       VALUES ($1, 1, $2::jsonb, repeat('c', 64), 'https://example.test/terms', NOW())`,
      [id, JSON.stringify(terms)],
    );
    return id;
  }

  const rowCount = async (): Promise<number> =>
    Number(
      (
        await dataSource.query(
          `SELECT COUNT(*) AS n FROM investment_transactions`,
        )
      )[0].n,
    );
  const priceOf = async (id: string): Promise<number> =>
    Number(
      (
        await dataSource.query(
          `SELECT price FROM investment_transactions WHERE id = $1`,
          [id],
        )
      )[0].price,
    );

  const dto = (over: Record<string, unknown> = {}) => ({
    accountId,
    securityId,
    action: InvestmentAction.BUY,
    transactionDate: "2026-10-05",
    quantity: 10,
    price: 100,
    commission: 0,
    ...over,
  });
  const create = (over: Record<string, unknown> = {}) =>
    withUserContext(userId, () =>
      investments.create(userId, dto(over) as never),
    );
  const update = (id: string, over: Record<string, unknown>) =>
    withUserContext(userId, () =>
      investments.update(userId, id, over as never),
    );
  const link = (id: string) =>
    withUserContext(userId, () =>
      securities.update(userId, id, { bondProgramId: EDO_PROGRAM } as never),
    );
  const linkedProgram = async (id: string) =>
    (
      await dataSource.query(
        `SELECT bond_program_id FROM securities WHERE id = $1`,
        [id],
      )
    )[0].bond_program_id;

  describe("an EMPTY program (no stored series): the template's face value is the band", () => {
    beforeEach(async () => {
      await insertBondProgram(dataSource, "EDO");
    });

    it("refuses the link of a security with BUY 1000 @ 1.00 and links nothing", async () => {
      const legacy = await insertSecurity("LEGACY", null);
      await raw(legacy, "BUY", "2026-10-05", 1000, 1);

      await expect(link(legacy)).rejects.toMatchObject({
        message: expect.stringMatching(/not numbers of bonds/),
      });
      expect(await linkedProgram(legacy)).toBeNull();
    });

    it("links a security whose rows are priced per bond of the template's face value", async () => {
      const legacy = await insertSecurity("LEGACY2", null);
      await raw(legacy, "BUY", "2026-10-05", 10, 100);
      await expect(link(legacy)).resolves.toBeDefined();
      expect(await linkedProgram(legacy)).toBe(EDO_PROGRAM);
    });

    it("accepts a SELL at 2.5 x face of a linked security (only acquisitions are read)", async () => {
      securityId = await insertSecurity("EDO", EDO_PROGRAM);
      await raw(securityId, "BUY", "2026-01-01", 1000, 100);
      const before = await rowCount();

      // A removal is not read by the band: 2.5 x face is a legitimate value.
      await create({
        action: InvestmentAction.SELL,
        transactionDate: "2026-01-02",
        quantity: 10,
        price: 250,
      });
      expect(await rowCount()).toBe(before + 1);
    });

    it("refuses an edit of a linked security's BUY to a price that is not a price per bond, rolling it back", async () => {
      securityId = await insertSecurity("EDO", EDO_PROGRAM);
      // The acquisition has no series (none stored, the row keeps it): it is
      // read against the program template's face value.
      const id = await raw(securityId, "BUY", "2026-01-01", 1000, 100);

      await expect(update(id, { price: 1 })).rejects.toMatchObject(
        code("QUANTITY_NOT_BONDS"),
      );
      expect(await priceOf(id)).toBe(100);
    });
  });

  describe("a program with a stored series on sale", () => {
    beforeEach(async () => {
      await storeFixtureSeries(dataSource, catalog);
      securityId = await insertSecurity("EDO", EDO_PROGRAM);
    });

    it("refuses BUY 1000 @ 1.00 of a linked security (the series on sale has face value 100), writing nothing", async () => {
      await expect(create({ quantity: 1000, price: 1 })).rejects.toMatchObject(
        code("QUANTITY_NOT_BONDS"),
      );
      expect(await rowCount()).toBe(0);
    });

    it("accepts a BUY at a price within half to twice the face value", async () => {
      await create({ quantity: 10, price: 100.08 });
      await create({ quantity: 10, price: 50 });
      await expect(
        create({ quantity: 10, price: 49.99 }),
      ).rejects.toMatchObject(code("QUANTITY_NOT_BONDS"));
      await expect(
        create({ quantity: 10, price: 200.01 }),
      ).rejects.toMatchObject(code("QUANTITY_NOT_BONDS"));
      expect(await rowCount()).toBe(2);
    });
  });

  describe("a split parent's delete and void are guarded like any removal (M1, INV-BOND-007)", () => {
    let jan: string;
    let embeddedSecurity: string;
    let parentId: string;

    beforeEach(async () => {
      await insertBondProgram(dataSource, "EDO");
      jan = await storeSeries("EDO0126", "2026-01-01", "2026-01-31");
      await storeSeries("EDO0226", "2026-02-01", "2026-02-28");
      embeddedSecurity = await insertSecurity("EDO", EDO_PROGRAM);
      securityId = embeddedSecurity;

      // The split parent T with an embedded BUY 10 (EDO0126, inferred), a
      // standalone BUY 10 (EDO0226) and a SELL 10 naming EDO0126: the SELL
      // depends on the embedded BUY.
      const parent = await withUserContext(userId, () =>
        transactions.create(userId, {
          accountId: cashAccountId,
          transactionDate: "2026-01-10",
          amount: -1000,
          currencyCode: "PLN",
          isSplit: true,
          splits: [
            {
              amount: -1000,
              investment: {
                action: InvestmentAction.BUY,
                securityId: embeddedSecurity,
                quantity: 10,
                price: 100,
                commission: 0,
              },
            },
          ],
        } as never),
      );
      parentId = parent.id;
      await create({ transactionDate: "2026-02-05", quantity: 10 });
      await create({
        action: InvestmentAction.SELL,
        transactionDate: "2026-03-01",
        quantity: 10,
        bondInstrumentId: jan,
      });
    });

    const embeddedCount = async (): Promise<number> =>
      Number(
        (
          await dataSource.query(
            `SELECT COUNT(*) AS n FROM investment_transactions WHERE transaction_split_id IS NOT NULL`,
          )
        )[0].n,
      );

    it("refuses deleting T (REMOVAL_EXCEEDS_SERIES) and keeps T, its split and its embedded row", async () => {
      await expect(
        withUserContext(userId, () => transactions.remove(userId, parentId)),
      ).rejects.toMatchObject(code("REMOVAL_EXCEEDS_SERIES"));
      expect(await embeddedCount()).toBe(1);
      const kept = await dataSource.query(
        `SELECT COUNT(*) AS n FROM transactions WHERE id = $1`,
        [parentId],
      );
      expect(Number(kept[0].n)).toBe(1);
    });

    it("refuses voiding T (REMOVAL_EXCEEDS_SERIES) and keeps the embedded row active", async () => {
      await expect(
        withUserContext(userId, () =>
          transactions.update(userId, parentId, {
            status: TransactionStatus.VOID,
          } as never),
        ),
      ).rejects.toMatchObject(code("REMOVAL_EXCEEDS_SERIES"));
      const status = await dataSource.query(
        `SELECT status FROM investment_transactions WHERE transaction_split_id IS NOT NULL`,
      );
      expect(status[0].status).not.toBe("VOID");
    });

    it("accepts a replacement of the splits that leaves the lots as they were (one guard, verified after the successors are written)", async () => {
      await withUserContext(userId, () =>
        transactions.update(userId, parentId, {
          splits: [
            {
              amount: -1000,
              investment: {
                action: InvestmentAction.BUY,
                securityId: embeddedSecurity,
                quantity: 10,
                price: 100,
                commission: 0,
              },
            },
          ],
        } as never),
      );
      expect(await embeddedCount()).toBe(1);
    });
  });
});
