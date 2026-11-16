import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { withUserContext } from "@/common/db/with-context";
import { ImportModule } from "@/import/import.module";
import { ImportRegularProcessorService } from "@/import/import-regular-processor.service";
import { ImportService } from "@/import/import.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * An OFX import keys each row by the bank's `FITID` against a real PostgreSQL
 * enforcing RLS (discussion #1782). The key lands in `transactions.external_id`
 * as `ofx:<FITID>`, under the per-account unique index
 * `idx_transactions_account_external_id` (INV-API-001), so a statement that
 * overlaps an earlier one imports only the rows the account does not hold
 * yet, and the result names each row it left out.
 */
describe("OFX import deduplicated by FITID (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let importer: ImportService;
  let processor: ImportRegularProcessorService;

  let aliceId: string;
  let checkingId: string;
  let savingsId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const row = (
    fitId: string,
    date: string,
    amount: string,
    name: string,
    type = "DEBIT",
  ) =>
    `<STMTTRN>\n<TRNTYPE>${type}\n<DTPOSTED>${date}\n<TRNAMT>${amount}\n` +
    `<FITID>${fitId}\n<NAME>${name}\n</STMTTRN>\n`;
  const ofx = (...rows: string[]) =>
    "OFXHEADER:100\n<OFX>\n<BANKMSGSRSV1>\n<STMTTRNRS>\n<STMTRS>\n" +
    `<BANKTRANLIST>\n${rows.join("")}</BANKTRANLIST>\n` +
    "</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>\n";

  const GROCERY = row("20260115-1", "20260115", "-50.00", "Grocery Store");
  const FUEL = row("20260116-1", "20260116", "-20.00", "Fuel");
  const RENT = row("20260201-1", "20260201", "-900.00", "Rent");

  const importOfx = (
    content: string,
    accountId = checkingId,
    accountMappings: Array<{ originalName: string; accountId: string }> = [],
  ) =>
    asAlice(() =>
      importer.importOfxFile(aliceId, {
        content,
        accountId,
        categoryMappings: [],
        accountMappings,
      } as never),
    );

  const stored = (accountId = checkingId) =>
    db.query(
      `SELECT payee_name, amount, external_id FROM transactions
        WHERE account_id = $1 ORDER BY transaction_date`,
      [accountId],
    ) as Promise<
      Array<{ payee_name: string; amount: string; external_id: string | null }>
    >;
  const balance = async (accountId = checkingId): Promise<number> =>
    Number(
      (
        await db.query(`SELECT current_balance FROM accounts WHERE id = $1`, [
          accountId,
        ])
      )[0].current_balance,
    );

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([ImportModule]);
    module = harness.module;
    db = harness.owner;
    importer = module.get(ImportService);
    processor = module.get(ImportRegularProcessorService);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanTables(db, [
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    const account = (name: string) =>
      createTestAccount(db, aliceId, {
        name,
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      });
    checkingId = (await account("Checking")).id;
    savingsId = (await account("Savings")).id;
  });

  it("stores each row's bank id as its external id", async () => {
    const result = await importOfx(ofx(GROCERY, FUEL));

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.skippedRows).toEqual([]);
    expect((await stored()).map((r) => r.external_id)).toEqual([
      "ofx:20260115-1",
      "ofx:20260116-1",
    ]);
  });

  it("skips every row of a statement imported a second time, and moves the balance once", async () => {
    await importOfx(ofx(GROCERY, FUEL));

    const again = await importOfx(ofx(GROCERY, FUEL));

    expect(again.imported).toBe(0);
    expect(again.errors).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.skippedRows).toEqual([
      {
        date: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        payee: "Grocery Store",
        reason: "alreadyImported",
      },
      {
        date: "2026-01-16",
        amount: -20,
        currencyCode: "USD",
        payee: "Fuel",
        reason: "alreadyImported",
      },
    ]);
    expect(await stored()).toHaveLength(2);
    expect(await balance()).toBe(930);
  });

  it("imports only the new rows of a statement that overlaps an earlier one", async () => {
    await importOfx(ofx(GROCERY, FUEL));

    const overlap = await importOfx(ofx(FUEL, RENT));

    expect(overlap.imported).toBe(1);
    expect(overlap.skippedRows.map((r) => r.payee)).toEqual(["Fuel"]);
    expect((await stored()).map((r) => r.payee_name)).toEqual([
      "Grocery Store",
      "Fuel",
      "Rent",
    ]);
    expect(await balance()).toBe(30);
  });

  it("imports the same bank id into another account, since the key is per account", async () => {
    await importOfx(ofx(GROCERY));

    const other = await importOfx(ofx(GROCERY), savingsId);

    expect(other.imported).toBe(1);
    expect(other.skipped).toBe(0);
    expect((await stored(savingsId)).map((r) => r.external_id)).toEqual([
      "ofx:20260115-1",
    ]);
  });

  it("imports a row whose bank id the bank reused for a different row, without the key", async () => {
    await importOfx(ofx(GROCERY));
    // The next statement numbers its rows from the same counter again.
    const REUSED = row("20260115-1", "20260215", "-12.00", "Bakery");

    const next = await importOfx(ofx(REUSED));

    expect(next.imported).toBe(1);
    expect(next.skipped).toBe(0);
    expect((await stored()).map((r) => [r.payee_name, r.external_id])).toEqual([
      ["Grocery Store", "ofx:20260115-1"],
      ["Bakery", null],
    ]);
  });

  it("imports a new transfer identical to two already imported ones, which a later download skips by key", async () => {
    const toSavings = (fitId: string) =>
      row(fitId, "20260115", "-100.00", "Savings", "XFER");
    const savings = [{ originalName: "Savings", accountId: savingsId }];
    await importOfx(ofx(toSavings("X1"), toSavings("X2")), checkingId, savings);

    const next = await importOfx(
      ofx(toSavings("X1"), toSavings("X2"), toSavings("X3")),
      checkingId,
      savings,
    );

    expect(next.imported).toBe(1);
    expect(next.skippedRows.map((r) => r.reason)).toEqual([
      "alreadyImported",
      "alreadyImported",
    ]);
    expect((await stored()).map((r) => r.external_id)).toEqual([
      "ofx:X1",
      "ofx:X2",
      "ofx:X3",
    ]);
  });

  it("imports the new transfer whatever its place among identical ones already imported", async () => {
    const toSavings = (fitId: string) =>
      row(fitId, "20260115", "-100.00", "Savings", "XFER");
    const savings = [{ originalName: "Savings", accountId: savingsId }];
    await importOfx(ofx(toSavings("X1"), toSavings("X2")), checkingId, savings);

    // The new row comes first, before the two the account holds.
    const next = await importOfx(
      ofx(toSavings("X3"), toSavings("X1"), toSavings("X2")),
      checkingId,
      savings,
    );

    expect(next.imported).toBe(1);
    expect(next.skippedRows.map((r) => r.reason)).toEqual([
      "alreadyImported",
      "alreadyImported",
    ]);
    expect((await stored()).map((r) => r.external_id).sort()).toEqual([
      "ofx:X1",
      "ofx:X2",
      "ofx:X3",
    ]);
    expect(await balance()).toBe(700);
  });

  it("gives the other account's statement row its bank id on the transfer leg the first import created", async () => {
    await importOfx(
      ofx(row("C1", "20260115", "-100.00", "Savings", "XFER")),
      checkingId,
      [{ originalName: "Savings", accountId: savingsId }],
    );
    expect((await stored(savingsId)).map((r) => r.external_id)).toEqual([null]);
    const fromChecking = [{ originalName: "Checking", accountId: checkingId }];
    const SAVINGS_STATEMENT = ofx(
      row("S1", "20260115", "100.00", "Checking", "XFER"),
    );

    const first = await importOfx(SAVINGS_STATEMENT, savingsId, fromChecking);

    expect(first.imported).toBe(0);
    expect(first.skippedRows.map((r) => r.reason)).toEqual([
      "duplicateTransfer",
    ]);
    expect((await stored(savingsId)).map((r) => r.external_id)).toEqual([
      "ofx:S1",
    ]);
    expect(await balance(savingsId)).toBe(1100);

    // The next download of the savings statement is skipped by its key.
    const again = await importOfx(SAVINGS_STATEMENT, savingsId, fromChecking);

    expect(again.skippedRows.map((r) => r.reason)).toEqual(["alreadyImported"]);
    expect(await stored(savingsId)).toHaveLength(1);
    expect(await balance(savingsId)).toBe(1100);
  });

  it("imports every row of a file that gives two rows the same bank id", async () => {
    const result = await importOfx(
      ofx(
        row("0", "20260115", "-5.00", "Coffee"),
        row("0", "20260115", "-5.00", "Coffee"),
      ),
    );

    expect(result.imported).toBe(2);
    expect((await stored()).map((r) => r.external_id)).toEqual([null, null]);
  });

  it("counts a row whose bank id another writer committed after the check as skipped, and keeps the rest of the file", async () => {
    await importOfx(ofx(GROCERY));
    // The other writer's row is already committed when this import reaches
    // the unique index: the keys read before the first row are made to miss
    // it, so only the index can stop the copy.
    const processRow = processor.processTransaction.bind(processor);
    jest
      .spyOn(processor, "processTransaction")
      .mockImplementation((ctx, tx) => {
        ctx.heldExternalIds.clear();
        return processRow(ctx, tx);
      });

    const result = await importOfx(ofx(GROCERY, FUEL));

    expect(result.imported).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.skippedRows).toEqual([
      {
        date: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        payee: "Grocery Store",
        reason: "alreadyImported",
      },
    ]);
    expect((await stored()).map((r) => r.payee_name)).toEqual([
      "Grocery Store",
      "Fuel",
    ]);
    expect(await balance()).toBe(930);
  });
});
