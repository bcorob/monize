import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { manifestDocument } from "@/bonds/adapters/pl/pl-test-input";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { BondHoldingsService } from "@/bonds/bond-holdings.service";
import { bondInstrumentId, bondProgramId } from "@/bonds/bond-instrument-id";
import { BondValuationService } from "@/bonds/bond-valuation.service";
import { withUserContext } from "@/common/db/with-context";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  storeFixtureSeries,
} from "../helpers/integration-setup";

/**
 * INV-BOND-007 against a real PostgreSQL: a removal the account cannot cover is
 * refused INSIDE the write's transaction (nothing commits), an edit keeps the
 * series it does not change, an undo restores the snapshot's series exactly, an
 * ADD_SHARES or an unpaired TRANSFER_IN must name its series, and the two
 * endpoints of the transaction form read the same derivation the write does.
 * The ledger read, the rollback and the series SQL are properties of the
 * database that a mocked manager cannot show.
 *
 * Two series of one program: the seeded EDO1036 (on sale in October 2026) and an
 * EDO1136 stored here (on sale in November 2026).
 */
describe("a program-linked security's series on write (integration, INV-BOND-007)", () => {
  jest.setTimeout(120000);

  let module: TestingModule;
  let dataSource: DataSource;
  let investments: InvestmentTransactionsService;
  let history: ActionHistoryService;
  let securities: SecuritiesService;
  let holdings: BondHoldingsService;
  let valuation: BondValuationService;
  let catalog: BondCatalogService;

  let userId: string;
  let otherUserId: string;
  let accountId: string;
  let secondAccountId: string;
  let securityId: string;

  const EDO_PROGRAM = bondProgramId("PL", "PL_MF", "EDO");
  const TOS_PROGRAM = bondProgramId("PL", "PL_MF", "TOS");
  const TOS_ID = bondInstrumentId("PL", "PL_MF", "TOS1029");
  /** On sale in October 2026. */
  const OCT = bondInstrumentId("PL", "PL_MF", "EDO1036");
  /** On sale in November 2026. */
  const NOV = bondInstrumentId("PL", "PL_MF", "EDO1136");

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    dataSource = module.get(DataSource);
    investments = module.get(InvestmentTransactionsService);
    history = module.get(ActionHistoryService);
    securities = module.get(SecuritiesService);
    holdings = module.get(BondHoldingsService);
    valuation = module.get(BondValuationService);
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

    // The second series of the program, sold in November.
    const november = manifestDocument("edo1036");
    november.instrument.seriesCode = "EDO1136";
    november.saleWindow = { from: "2026-11-01", to: "2026-11-30" };
    await dataSource.query(
      `INSERT INTO bond_instruments (id, issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
       VALUES ($1, 'PL', 'PL_MF', 'EDO', $2, 'EDO1136', 'PLN', 'RETAIL_REDEEMABLE')`,
      [NOV, EDO_PROGRAM],
    );
    await dataSource.query(
      `INSERT INTO bond_terms_versions (bond_instrument_id, version, terms, content_hash, source_url, retrieved_at)
       VALUES ($1, 1, $2::jsonb, repeat('b', 64), 'https://example.test/terms', NOW())`,
      [NOV, JSON.stringify(november)],
    );

    userId = (await createTestUserDirect(dataSource)).id;
    otherUserId = (await createTestUserDirect(dataSource)).id;
    accountId = await insertAccount("Brokerage");
    secondAccountId = await insertAccount("Second");
    securityId = await insertSecurity("EDO", EDO_PROGRAM);
  });

  async function insertAccount(name: string): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', $2, 'PLN', 0, 0)
       RETURNING id`,
      [userId, name],
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

  /** A row written straight to the table, as a legacy path or an import would. */
  async function raw(
    action: string,
    date: string,
    quantity: number,
    series: string | null,
    account = accountId,
    security = securityId,
  ): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100, $8, 'UNRECONCILED')
       RETURNING id`,
      [
        userId,
        account,
        security,
        series,
        action,
        date,
        quantity,
        quantity * 100,
      ],
    );
    return rows[0].id;
  }

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

  const seriesOf = async (id: string): Promise<string | null> =>
    (
      await dataSource.query(
        `SELECT bond_instrument_id FROM investment_transactions WHERE id = $1`,
        [id],
      )
    )[0].bond_instrument_id;
  const rowCount = async (): Promise<number> =>
    Number(
      (
        await dataSource.query(
          `SELECT COUNT(*) AS n FROM investment_transactions`,
        )
      )[0].n,
    );
  const held = async (account = accountId): Promise<number> =>
    Number(
      (
        await dataSource.query(
          `SELECT COALESCE(SUM(quantity), 0) AS q FROM holdings WHERE account_id = $1 AND security_id = $2`,
          [account, securityId],
        )
      )[0].q,
    );
  const code = (errorCode: string) => ({ response: { errorCode } });
  const asOther = <T>(fn: () => Promise<T>) => withUserContext(otherUserId, fn);

  describe("a removal is checked at write time (A)", () => {
    it("refuses a SELL naming a series the account holds too little of, though the program's total covers it, and commits nothing", async () => {
      await create(); // 10 of EDO1036 (inferred from October)
      await create({ transactionDate: "2026-11-05" }); // 10 of EDO1136
      expect(await rowCount()).toBe(2);
      // `holdings` counts only rows up to today, so the November purchase may
      // not be in it yet; what matters is that a refused SELL leaves it as is.
      const position = await held();

      await expect(
        create({
          action: InvestmentAction.SELL,
          transactionDate: "2026-11-10",
          quantity: 15,
          bondInstrumentId: OCT,
        }),
      ).rejects.toMatchObject(code("REMOVAL_EXCEEDS_SERIES"));

      // Nothing committed: no row, the position as it was.
      expect(await rowCount()).toBe(2);
      expect(await held()).toBe(position);

      // The same quantity leaving the account's lots first-in first-out across
      // series is covered, and is accepted.
      await create({
        action: InvestmentAction.SELL,
        transactionDate: "2026-11-10",
        quantity: 15,
      });
      expect(await rowCount()).toBe(3);
    });

    it("refuses an edit that shrinks a purchase below a later removal of its series, rolling the edit back", async () => {
      const buy = await create(); // 10 of EDO1036
      await create({ transactionDate: "2026-11-05" }); // 10 of EDO1136
      await create({
        action: InvestmentAction.SELL,
        transactionDate: "2026-11-10",
        quantity: 8,
        bondInstrumentId: OCT,
      });

      // The total (5 + 10 - 8) stays positive, so only the series ledger refuses.
      await expect(update(buy.id, { quantity: 5 })).rejects.toMatchObject(
        code("REMOVAL_EXCEEDS_SERIES"),
      );
      const row = await dataSource.query(
        `SELECT quantity::text AS q FROM investment_transactions WHERE id = $1`,
        [buy.id],
      );
      expect(Number(row[0].q)).toBe(10);
    });

    it("does not block an unrelated edit while a removal problem that already existed stands", async () => {
      const buyNov = await create({ transactionDate: "2026-11-05" });
      await create();
      // Written past the service (a legacy path): 15 of EDO1036 left an account
      // that holds 10 of it, yet the program's total of 20 covers it.
      await raw("SELL", "2026-11-10", 15, OCT);

      await expect(
        update(buyNov.id, { description: "renamed" }),
      ).resolves.toBeDefined();
    });

    it("refuses a security transfer naming a series the source holds too little of", async () => {
      await create();
      await create({ transactionDate: "2026-11-05" });
      await expect(
        withUserContext(userId, () =>
          investments.transferSecurity(userId, {
            fromAccountId: accountId,
            toAccountId: secondAccountId,
            securityId,
            transactionDate: "2026-11-10",
            quantity: 15,
            costPerShare: 100,
            bondInstrumentId: OCT,
          } as never),
        ),
      ).rejects.toMatchObject(code("REMOVAL_EXCEEDS_SERIES"));
      expect(await rowCount()).toBe(2);
    });
  });

  describe("deleting or voiding an acquisition is checked like any write (A)", () => {
    it("refuses deleting, voiding and undoing the create of a purchase a later SELL of its series depends on, and commits nothing", async () => {
      const buyOct = await create(); // 10 of EDO1036
      await create({ transactionDate: "2026-11-05" }); // 10 of EDO1136
      await create({
        action: InvestmentAction.SELL,
        transactionDate: "2026-11-10",
        quantity: 8,
        bondInstrumentId: OCT,
      });
      // The program's total (10 - 8) stays positive, so only the series ledger refuses.
      await expect(
        withUserContext(userId, () => investments.remove(userId, buyOct.id)),
      ).rejects.toMatchObject(code("REMOVAL_EXCEEDS_SERIES"));
      expect(await rowCount()).toBe(3);

      await expect(
        withUserContext(userId, () =>
          investments.updateStatus(userId, buyOct.id, "VOID" as never),
        ),
      ).rejects.toMatchObject(code("REMOVAL_EXCEEDS_SERIES"));
      const status = await dataSource.query(
        `SELECT status FROM investment_transactions WHERE id = $1`,
        [buyOct.id],
      );
      expect(status[0].status).not.toBe("VOID");

      // A delete nothing depends on is accepted.
      const other = await create({ transactionDate: "2026-11-06" });
      await withUserContext(userId, () => investments.remove(userId, other.id));
      expect(await rowCount()).toBe(3);
    });
  });

  describe("an edit keeps what it does not change (B)", () => {
    it("keeps the NULL series of a legacy BUY with none on sale, and of a legacy ADD_SHARES, on an unrelated edit", async () => {
      const legacyBuy = await raw("BUY", "2026-09-01", 4, null);
      const legacyAdd = await raw("ADD_SHARES", "2026-09-02", 3, null);

      await update(legacyBuy, { description: "renamed" });
      await update(legacyAdd, {
        description: "renamed",
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2026-09-02",
      });

      expect(await seriesOf(legacyBuy)).toBeNull();
      expect(await seriesOf(legacyAdd)).toBeNull();
    });

    it("resolves the series again when the date of a legacy BUY changes: none on sale that day is refused before any write", async () => {
      const legacyBuy = await raw("BUY", "2026-09-01", 4, null);
      await expect(
        update(legacyBuy, { transactionDate: "2026-12-15" }),
      ).rejects.toMatchObject(code("SERIES_NOT_DETERMINED"));
      expect(await seriesOf(legacyBuy)).toBeNull();
    });

    it("stores a different series when one is requested, and a NULL one for a removal that asks for the oldest lots first", async () => {
      await create();
      const buyNov = await create({ transactionDate: "2026-11-05" });
      const sell = await create({
        action: InvestmentAction.SELL,
        transactionDate: "2026-11-10",
        quantity: 2,
        bondInstrumentId: OCT,
      });
      expect(await seriesOf(sell.id)).toBe(OCT);
      await update(sell.id, { bondInstrumentId: null });
      expect(await seriesOf(sell.id)).toBeNull();
      await update(buyNov.id, { bondInstrumentId: OCT });
      expect(await seriesOf(buyNov.id)).toBe(OCT);
    });
  });

  describe("undo and redo restore the snapshot's series exactly (C)", () => {
    it("reinserts a deleted row with the series it carried, never an inferred one, and a NULL one as NULL without SERIES_NOT_DETERMINED", async () => {
      // Named EDO1136 although October puts EDO1036 on sale.
      const named = await create({ bondInstrumentId: NOV });
      // A legacy row no series covers the date of.
      const legacy = await raw("BUY", "2026-09-01", 4, null);

      for (const id of [named.id, legacy]) {
        await withUserContext(userId, () => investments.remove(userId, id));
        await settlePendingHistoryWrites();
        await withUserContext(userId, () => history.undo(userId));
      }

      expect(await seriesOf(named.id)).toBe(NOV);
      expect(await seriesOf(legacy)).toBeNull();
    });

    it("restores a series the security's program no longer holds as NULL", async () => {
      const named = await create({ bondInstrumentId: NOV });
      await withUserContext(userId, () => investments.remove(userId, named.id));
      await settlePendingHistoryWrites();
      // The security is relinked to another program meanwhile.
      await dataSource.query(
        `UPDATE securities SET bond_program_id = $2 WHERE id = $1`,
        [securityId, TOS_PROGRAM],
      );
      await withUserContext(userId, () => history.undo(userId));
      expect(await seriesOf(named.id)).toBeNull();
    });
  });

  describe("acquisitions with no purchase date of their own name their series (I)", () => {
    it.each([InvestmentAction.ADD_SHARES, InvestmentAction.TRANSFER_IN])(
      "refuses %s without a series (SERIES_REQUIRED), and accepts it with one",
      async (action) => {
        await expect(
          create({ action, price: undefined }),
        ).rejects.toMatchObject(code("SERIES_REQUIRED"));
        expect(await rowCount()).toBe(0);

        const row = await create({
          action,
          price: undefined,
          bondInstrumentId: NOV,
        });
        expect(await seriesOf(row.id)).toBe(NOV);
      },
    );

    it("still infers a BUY from its own date", async () => {
      const row = await create({ transactionDate: "2026-11-05" });
      expect(await seriesOf(row.id)).toBe(NOV);
    });

    it("the lots of a legacy ADD_SHARES without a series are unknown (SERIES_NOT_DETERMINED), never inferred from its date", async () => {
      await raw("ADD_SHARES", "2026-10-05", 4, null);
      const valued = await withUserContext(userId, () =>
        valuation.valueSecurity(userId, securityId, "2026-12-01"),
      );
      expect(valued.refusal).toMatchObject({ code: "SERIES_NOT_DETERMINED" });
    });
  });

  describe("GET series-on-sale (E)", () => {
    it("answers the series a BUY on that date would be given, the same as the write", async () => {
      const on = (date: string) =>
        withUserContext(userId, () =>
          holdings.seriesOnSale(userId, securityId, date),
        );
      await expect(on("2026-10-10")).resolves.toEqual({
        instrumentId: OCT,
        seriesCode: "EDO1036",
      });
      await expect(on("2026-11-10")).resolves.toEqual({
        instrumentId: NOV,
        seriesCode: "EDO1136",
      });
      await expect(on("2027-05-01")).resolves.toBeNull();

      const written = await create({ transactionDate: "2026-11-10" });
      expect(await seriesOf(written.id)).toBe(NOV);
    });

    it("is a 404 for another user's security and for one that is not linked", async () => {
      await expect(
        asOther(() =>
          holdings.seriesOnSale(otherUserId, securityId, "2026-10-10"),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      const plain = await insertSecurity("PLAIN", null);
      await expect(
        withUserContext(userId, () =>
          holdings.seriesOnSale(userId, plain, "2026-10-10"),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("GET series-holdings (F)", () => {
    it("lists the series the account holds on the date, oldest first, without the excluded row", async () => {
      const buyOct = await create();
      const buyNov = await create({
        transactionDate: "2026-11-05",
        quantity: 7,
      });
      await create({
        accountId: secondAccountId,
        transactionDate: "2026-11-06",
        quantity: 3,
      });
      const at = (date: string, exclude?: string, account = accountId) =>
        withUserContext(userId, () =>
          holdings.seriesHoldings(userId, securityId, account, date, exclude),
        );

      await expect(at("2026-12-01")).resolves.toEqual({
        holdings: [
          { instrumentId: OCT, seriesCode: "EDO1036", quantity: 10 },
          { instrumentId: NOV, seriesCode: "EDO1136", quantity: 7 },
        ],
      });
      // As of a date: the November purchase is not made yet in October.
      await expect(at("2026-10-31")).resolves.toEqual({
        holdings: [{ instrumentId: OCT, seriesCode: "EDO1036", quantity: 10 }],
      });
      // The row being edited is not counted.
      await expect(at("2026-12-01", buyNov.id)).resolves.toEqual({
        holdings: [{ instrumentId: OCT, seriesCode: "EDO1036", quantity: 10 }],
      });
      await expect(at("2026-12-01", buyOct.id)).resolves.toEqual({
        holdings: [{ instrumentId: NOV, seriesCode: "EDO1136", quantity: 7 }],
      });
      // Only the account asked about.
      await expect(
        at("2026-12-01", undefined, secondAccountId),
      ).resolves.toEqual({
        holdings: [{ instrumentId: NOV, seriesCode: "EDO1136", quantity: 3 }],
      });

      // A series sold out of is not listed.
      await create({
        action: InvestmentAction.SELL,
        transactionDate: "2026-11-20",
        quantity: 10,
        bondInstrumentId: OCT,
      });
      await expect(at("2026-12-01")).resolves.toEqual({
        holdings: [{ instrumentId: NOV, seriesCode: "EDO1136", quantity: 7 }],
      });
    });

    it("is a 422 with the refusal code when the lots cannot be derived, and a 404 for another user's security", async () => {
      await raw("SELL", "2026-10-10", 99, null);
      const error = await withUserContext(userId, () =>
        holdings.seriesHoldings(userId, securityId, accountId, "2026-12-01"),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse()).toMatchObject({ errorCode: "OVER_REMOVAL" });

      await expect(
        asOther(() =>
          holdings.seriesHoldings(
            otherUserId,
            securityId,
            accountId,
            "2026-12-01",
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("redemption-split reads the lots the removal takes", () => {
    const DAY = "2026-12-01";
    const split = (
      quantity: number,
      over: { user?: string; account?: string; exclude?: string } = {},
    ) =>
      withUserContext(over.user ?? userId, () =>
        holdings.redemptionSplit(
          over.user ?? userId,
          securityId,
          over.account ?? accountId,
          OCT,
          DAY,
          quantity,
          over.exclude,
        ),
      );
    const portion = async (purchaseDate: string, quantity: number) =>
      withUserContext(userId, () =>
        dataSource.transaction(async (m) =>
          valuation.redemptionSplitFrom(
            await valuation.loadReference(m, OCT),
            { purchaseDate, quantity },
            DAY,
          ),
        ),
      );

    it("splits two lots of one series bought on two dates first in first out, and sums the portions exactly", async () => {
      await raw("BUY", "2026-10-05", 3, OCT);
      await raw("BUY", "2026-10-12", 5, OCT);
      const first = await portion("2026-10-05", 3);
      const second = await portion("2026-10-12", 1);
      expect(first.refusal).toBeNull();
      expect(second.refusal).toBeNull();

      const four = await split(4);
      expect(four.refusal).toBeNull();
      expect(four.principal).toBe("400.00");
      expect(four.interest).toBe(
        (Number(first.interest) + Number(second.interest)).toFixed(2),
      );
      expect(four.payout).toBe(
        (Number(first.payout) + Number(second.payout)).toFixed(2),
      );
      expect(
        Number(four.principalReturned) + Number(four.interest),
      ).toBeCloseTo(Number(four.payout), 2);
      // Only the first lot: one purchase date, the oldest.
      expect((await split(3)).interest).toBe(first.interest);
    });

    it("refuses a quantity above what the account holds of the series, and leaves the other account's lots alone", async () => {
      await raw("BUY", "2026-10-05", 3, OCT);
      await raw("BUY", "2026-10-12", 5, OCT, secondAccountId);
      const error = await split(4).catch((e) => e);
      expect(error.getResponse()).toMatchObject({
        errorCode: "REMOVAL_EXCEEDS_SERIES",
      });
      await expect(
        split(5, { account: secondAccountId }),
      ).resolves.toMatchObject({ principal: "500.00", refusal: null });
    });

    it("does not count the row being edited, and writes nothing", async () => {
      await raw("BUY", "2026-10-05", 3, OCT);
      const redeem = await raw("REDEEM", "2026-11-20", 3, OCT);
      await expect(split(3)).rejects.toMatchObject({
        response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
      });
      const rows = await rowCount();
      await expect(split(3, { exclude: redeem })).resolves.toMatchObject({
        principal: "300.00",
      });
      expect(await rowCount()).toBe(rows);
    });

    it("is a 404 for another user's security", async () => {
      await raw("BUY", "2026-10-05", 3, OCT);
      await expect(
        asOther(() =>
          holdings.redemptionSplit(
            otherUserId,
            securityId,
            accountId,
            OCT,
            DAY,
            1,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("linking a security reads each row as the series it will be read as (G)", () => {
    const link = (id: string) =>
      withUserContext(userId, () =>
        securities.update(userId, id, { bondProgramId: EDO_PROGRAM } as never),
      );

    it("checks a row that names a series of ANOTHER program against the new program's series, never skipping it", async () => {
      const legacy = await insertSecurity("LEGACY", null);
      // 5000 a unit is not a price per bond (face 100): its quantity is not a
      // number of bonds. The stored series is TOS1029's, not the new program's.
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, $4, 'BUY', '2026-10-10', 2, 5000, 10000, 'UNRECONCILED')`,
        [userId, accountId, legacy, TOS_ID],
      );
      await expect(link(legacy)).rejects.toMatchObject({
        message: expect.stringMatching(/not numbers of bonds/),
      });
    });

    it("checks a row with no series and none on sale that day against the program's newest series", async () => {
      const legacy = await insertSecurity("LEGACY2", null);
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, 'BUY', '2020-01-01', 2, 5000, 10000, 'UNRECONCILED')`,
        [userId, accountId, legacy],
      );
      await expect(link(legacy)).rejects.toMatchObject({
        message: expect.stringMatching(/not numbers of bonds/),
      });
    });

    it("links a security whose rows are priced per bond, whatever series they name", async () => {
      const legacy = await insertSecurity("LEGACY3", null);
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, $4, 'BUY', '2020-01-01', 2, 100, 200, 'UNRECONCILED')`,
        [userId, accountId, legacy, TOS_ID],
      );
      await expect(link(legacy)).resolves.toBeDefined();
    });
  });
});
