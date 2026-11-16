import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondInstrumentId } from "@/bonds/bond-instrument-id";
import { withUserContext } from "@/common/db/with-context";
import { ImportModule } from "@/import/import.module";
import { ImportService } from "@/import/import.service";
import { SecuritiesModule } from "@/securities/securities.module";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  storeFixtureSeries,
} from "../helpers/integration-setup";

/**
 * INV-BOND-007 on the QIF import path, against a real PostgreSQL: an imported
 * BUY of a program-linked security takes the series on sale on its date, an
 * import after which a removal is not covered by the lots is refused in full
 * (the guard runs inside the import's one transaction, so nothing commits), and
 * an acquisition with no purchase date of its own (SHRSIN, unpaired) is stored
 * with NULL and counted instead of failing the file.
 *
 * The seeded EDO1036 is on sale in October 2026 (`storeFixtureSeries`).
 */
describe("bond series on the QIF import (integration, INV-BOND-007)", () => {
  jest.setTimeout(120000);

  let module: TestingModule;
  let dataSource: DataSource;
  let importer: ImportService;
  let catalog: BondCatalogService;

  let userId: string;
  let accountId: string;
  let securityId: string;

  /** On sale in October 2026. */
  const OCT = bondInstrumentId("PL", "PL_MF", "EDO1036");

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule, ImportModule]);
    dataSource = module.get(DataSource);
    importer = module.get(ImportService);
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
      "monthly_account_balances",
      "securities",
      "accounts",
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'zl', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    await storeFixtureSeries(dataSource, catalog);

    userId = (await createTestUserDirect(dataSource)).id;
    const accounts = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Brokerage', 'PLN', 0, 0)
       RETURNING id`,
      [userId],
    );
    accountId = accounts[0].id;
    const programs = await dataSource.query(
      `SELECT id FROM bond_programs WHERE program_code = 'EDO'`,
    );
    const securities = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
       VALUES ($1, 'EDO', 'EDO', 'BOND', 'PLN', $2)
       RETURNING id`,
      [userId, programs[0].id],
    );
    securityId = securities[0].id;
  });

  /** A QIF investment file; each row is [MM/DD/YYYY, action, quantity, price]. */
  const qif = (rows: Array<[string, string, number, number]>): string =>
    "!Type:Invst\n" +
    rows
      .map(
        ([date, action, quantity, price]) =>
          `D${date}\nN${action}\nYEDO\nI${price}\nQ${quantity}\nT${quantity * price}\n^\n`,
      )
      .join("");

  const importQif = (content: string) =>
    withUserContext(userId, () =>
      importer.importQifFile(userId, {
        content,
        accountId,
        categoryMappings: [],
        accountMappings: [],
        securityMappings: [{ originalName: "EDO", securityId }],
        dateFormat: "MM/DD/YYYY",
      } as never),
    );

  /** A lot already in the ledger, written straight to the table. */
  const existingBuy = async (quantity: number): Promise<void> => {
    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
       VALUES ($1, $2, $3, $4, 'BUY', '2026-10-01', $5, 100, $6, 'UNRECONCILED')`,
      [userId, accountId, securityId, OCT, quantity, quantity * 100],
    );
  };

  const stored = (): Promise<
    Array<{ action: string; bond_instrument_id: string | null }>
  > =>
    dataSource.query(
      `SELECT action, bond_instrument_id FROM investment_transactions
        ORDER BY transaction_date, action`,
    );
  const count = async (table: string): Promise<number> =>
    Number(
      (await dataSource.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n,
    );

  it("stores the series on sale on its date for an imported BUY of a linked security", async () => {
    const result = await importQif(qif([["10/05/2026", "Buy", 10, 100]]));

    expect(result.imported).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.bondRowsWithoutSeries).toBeUndefined();
    expect(await stored()).toEqual([
      { action: "BUY", bond_instrument_id: OCT },
    ]);
  });

  it("refuses in full an import whose SELL exceeds the series held, writing nothing", async () => {
    await existingBuy(10);
    const before = {
      investments: await count("investment_transactions"),
      transactions: await count("transactions"),
    };

    // The BUY is fine on its own; the SELL of 20 against 15 held is not, and
    // the whole file goes with it.
    await expect(
      importQif(
        qif([
          ["10/06/2026", "Buy", 5, 100],
          ["10/07/2026", "Sell", 20, 100],
        ]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(await count("investment_transactions")).toBe(before.investments);
    expect(await count("transactions")).toBe(before.transactions);
    expect(await stored()).toEqual([
      { action: "BUY", bond_instrument_id: OCT },
    ]);
  });

  it("stores an ADD_SHARES-like acquisition (ShrsIn) with NULL and counts it instead of refusing the file", async () => {
    const result = await importQif(qif([["10/05/2026", "ShrsIn", 10, 100]]));

    expect(result.imported).toBe(1);
    expect(result.bondRowsWithoutSeries).toBe(1);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].bond_instrument_id).toBeNull();
  });
});
