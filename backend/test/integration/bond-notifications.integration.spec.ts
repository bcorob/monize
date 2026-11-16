import { DataSource } from "typeorm";

import { BondHoldingsService } from "@/bonds/bond-holdings.service";
import { BondNotificationService } from "@/bonds/bond-notification.service";
import { BondValuationService } from "@/bonds/bond-valuation.service";
import { withUserContext } from "@/common/db/with-context";
import { NotificationService } from "@/notification-center/notification.service";
import {
  ManifestName,
  manifestDocument,
} from "@/bonds/adapters/pl/pl-test-input";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
  insertBondProgram,
} from "../helpers/integration-setup";

/**
 * The bond notification producer against a real PostgreSQL enforcing RLS
 * (docs/specs/bond-notifications.md section 8). The unit spec drives the
 * service over a mocked manager; the properties here are the ones a mock cannot
 * show: that the producer's own SQL (the user fan-out, the active-security
 * list, the interest-booked probe, the benchmark freshness read) parses and
 * returns rows under the identity it runs with, and that the row the real
 * `NotificationService.create` writes carries the engine's figures and is not
 * written twice.
 *
 * Only the outbound side of the dispatch (push and email) is stubbed: `notify`
 * is forwarded to the real write door, as the system-alert dedupe suite does.
 *
 * The financial today is fixed by faking `Date` alone (every timer stays real,
 * so the pool and the transactions are untouched): 2026-10-13, a Tuesday. The
 * database clock is not faked, so a timestamp is seeded on the clock its reader
 * compares it with: `retrieved_at` relative to `NOW()` (the freshness read is
 * SQL), `dismissed_at` relative to `daysAgo` (`purgeOld` takes its cutoffs from
 * the faked `Date`). Seeding the latter from `NOW()` passed only while the real
 * date was within a day of TODAY.
 */
describe("BondNotificationService (integration)", () => {
  jest.setTimeout(240000);

  const TODAY = "2026-10-13";

  let harness: EnforcedIntegrationHarness;
  let owner: DataSource;
  let service: BondNotificationService;
  let holdings: BondHoldingsService;
  let writeDoor: NotificationService;

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([]);
    owner = harness.owner;
    const valuation = new BondValuationService(harness.app);
    holdings = new BondHoldingsService(harness.app, valuation);
    writeDoor = new NotificationService(harness.app);
    service = new BondNotificationService(
      harness.app,
      valuation,
      holdings,
      // The real write door; push and email are the stubbed outbound side.
      {
        notify: (userId: string, input: unknown) =>
          writeDoor.create(userId, input as never),
      } as never,
    );
    jest.useFakeTimers({
      now: new Date(`${TODAY}T10:00:00.000Z`),
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
  });

  afterAll(async () => {
    jest.useRealTimers();
    await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(owner, [
      "notifications",
      "holdings",
      "investment_transactions",
      "securities",
      "accounts",
      "users",
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
    ]);
    await owner.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'z', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
  });

  /** A timestamp `days` before the faked `Date`, the clock `purgeOld` reads. */
  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 86_400_000);
  }

  /** Store a series whose sale window covers every purchase date the cases use. */
  async function seedSeries(
    manifest: ManifestName,
    program: string,
    series: string,
  ): Promise<string> {
    const existing: Array<{ id: string }> = await owner.query(
      `SELECT id FROM bond_instruments WHERE series_code = $1`,
      [series],
    );
    if (existing.length > 0) return existing[0].id;
    const rows: Array<{ id: string }> = await owner.query(
      `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
       VALUES ('PL', 'PL_MF', $1, $3, $2, 'PLN', 'RETAIL_REDEEMABLE')
       RETURNING id`,
      [program, series, await insertBondProgram(owner, program)],
    );
    const document = manifestDocument(manifest);
    document.saleWindow = { from: "2020-01-01", to: "2030-12-31" };
    await owner.query(
      `INSERT INTO bond_terms_versions (bond_instrument_id, version, terms, content_hash, source_url, retrieved_at)
       VALUES ($1, 1, $2::jsonb, repeat('a', 64), 'https://example.test/terms', NOW())`,
      [rows[0].id, JSON.stringify(document)],
    );
    return rows[0].id;
  }

  interface Held {
    userId: string;
    accountId: string;
    securityId: string;
    instrumentId: string;
  }

  /** A person holding `quantity` of a series bought on `purchaseDate`. */
  async function hold(
    manifest: ManifestName,
    program: string,
    series: string,
    purchaseDate: string,
    quantity: number,
    options: { userId?: string; active?: boolean } = {},
  ): Promise<Held> {
    const instrumentId = await seedSeries(manifest, program, series);
    const userId = options.userId ?? (await createTestUserDirect(owner)).id;
    const account: Array<{ id: string }> = await owner.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Brokerage', 'PLN', 0, 0)
       RETURNING id`,
      [userId],
    );
    const security: Array<{ id: string }> = await owner.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id, is_active)
       VALUES ($1, $2, $2, 'BOND', 'PLN', $3, $4)
       RETURNING id`,
      [
        userId,
        series,
        await insertBondProgram(owner, program),
        options.active ?? true,
      ],
    );
    await owner.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
       VALUES ($1, $2, $3, $4, 'BUY', $5, $6, 100, $7, 'UNRECONCILED')`,
      [
        userId,
        account[0].id,
        security[0].id,
        instrumentId,
        purchaseDate,
        quantity,
        quantity * 100,
      ],
    );
    return {
      userId,
      accountId: account[0].id,
      securityId: security[0].id,
      instrumentId,
    };
  }

  interface Row {
    user_id: string;
    alert_type: string;
    dedupe_key: string;
    target: string;
    data: Record<string, unknown>;
  }

  const rowsOf = (type: string): Promise<Row[]> =>
    owner.query(
      `SELECT user_id, alert_type, dedupe_key, target, data
         FROM notifications WHERE alert_type = $1 ORDER BY dedupe_key`,
      [type],
    );

  it("raises one BOND_MATURITY_SOON per held series maturing within 14 days, with the engine's payout, and none on a second run", async () => {
    // TOS1029 runs three 12-month periods: bought 2023-10-16, it matures on
    // 2026-10-16, three days after the fixed today.
    const held = await hold("tos1029", "TOS", "TOS1029", "2023-10-16", 40);

    expect(await service.evaluateUser(held.userId)).toBe(1);

    const rows = await rowsOf("BOND_MATURITY_SOON");
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(
      `bond:maturity:${held.accountId}:${held.instrumentId}:2026-10-16`,
    );
    expect(rows[0].target).toBe(`/securities/${held.securityId}`);

    const split = await withUserContext(held.userId, () =>
      holdings.redemptionSplit(
        held.userId,
        held.securityId,
        held.accountId,
        held.instrumentId,
        "2026-10-16",
        40,
      ),
    );
    expect(split.payout).not.toBeNull();
    expect(rows[0].data).toMatchObject({
      securityId: held.securityId,
      accountId: held.accountId,
      instrumentId: held.instrumentId,
      seriesCode: "TOS1029",
      maturityDate: "2026-10-16",
      quantity: 40,
      payout: split.payout,
      interest: split.interest,
      principalReturned: split.principalReturned,
      missing: null,
    });

    // A second run, and a run by a second replica, write nothing new.
    expect(await service.evaluateUser(held.userId)).toBe(0);
    expect(await rowsOf("BOND_MATURITY_SOON")).toHaveLength(1);
  });

  it("raises BOND_INTEREST_PAYMENT for a coupon paid today, and none once the person has booked the INTEREST", async () => {
    // COI1030 pays its coupon at the end of each 12-month period: bought
    // 2025-10-13, the first period ends today and the bond matures in 2029.
    const held = await hold("coi1030", "COI", "COI1030", "2025-10-13", 10);

    await service.evaluateUser(held.userId);
    const raised = await rowsOf("BOND_INTEREST_PAYMENT");
    expect(raised).toHaveLength(1);
    expect(raised[0].dedupe_key).toBe(
      `bond:interest:${held.accountId}:${held.instrumentId}:${TODAY}`,
    );
    expect(raised[0].data).toMatchObject({
      paymentDate: TODAY,
      quantity: 10,
      seriesCode: "COI1030",
    });
    expect(raised[0].data.amount).toEqual(expect.any(String));

    // The same day, with the person's own INTEREST row: the probe finds it.
    await owner.query(`DELETE FROM notifications`);
    await owner.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, total_amount, status)
       VALUES ($1, $2, $3, $4, 'INTEREST', $5, 47.50, 'UNRECONCILED')`,
      [held.userId, held.accountId, held.securityId, held.instrumentId, TODAY],
    );
    await service.evaluateUser(held.userId);
    expect(await rowsOf("BOND_INTEREST_PAYMENT")).toHaveLength(0);

    // A voided booking is not a booking.
    await owner.query(
      `UPDATE investment_transactions SET status = 'VOID' WHERE action = 'INTEREST'`,
    );
    await service.evaluateUser(held.userId);
    expect(await rowsOf("BOND_INTEREST_PAYMENT")).toHaveLength(1);
  });

  it("raises BOND_BENCHMARK_PUBLISHED once for an observation stored within 7 days, and none for one stored 10 days ago", async () => {
    const held = await hold("coi1030", "COI", "COI1030", "2026-07-01", 5);
    await owner.query(
      `INSERT INTO benchmark_series (code, kind, publisher, source_url, unit)
       VALUES ('PL_CPI_GUS_YOY', 'MONTHLY', 'GUS', 'https://example.test/cpi', 'FRACTION')`,
    );
    await owner.query(
      `INSERT INTO benchmark_values (benchmark_code, observation_date, value, source_url, retrieved_at)
       VALUES ('PL_CPI_GUS_YOY', '2026-08-01', 0.0290000000, 'https://example.test/cpi', NOW())`,
    );

    await service.evaluateUser(held.userId);
    const fresh = await rowsOf("BOND_BENCHMARK_PUBLISHED");
    expect(fresh).toHaveLength(1);
    expect(fresh[0].dedupe_key).toBe("bond:bench:PL_CPI_GUS_YOY:2026-08");
    expect(fresh[0].data).toMatchObject({
      benchmarkId: "PL_CPI_GUS_YOY",
      publisher: "GUS",
      unit: "FRACTION",
      observation: "2026-08",
      securityId: null,
      accountId: null,
    });
    expect(fresh[0].target).toBe(`/securities/${held.securityId}`);

    await service.evaluateUser(held.userId);
    expect(await rowsOf("BOND_BENCHMARK_PUBLISHED")).toHaveLength(1);

    await owner.query(`DELETE FROM notifications`);
    await owner.query(
      `UPDATE benchmark_values SET retrieved_at = NOW() - INTERVAL '10 days'`,
    );
    await service.evaluateUser(held.userId);
    expect(await rowsOf("BOND_BENCHMARK_PUBLISHED")).toHaveLength(0);
  });

  it("raises BOND_REDEMPTION_UNBOOKED once for as long as the state lasts: the nightly purge keeps its dedupe row until it was dismissed a year ago", async () => {
    // TOS1029 bought 2023-10-10 matured on 2026-10-10 and no REDEEM is booked.
    const held = await hold("tos1029", "TOS", "TOS1029", "2023-10-10", 40);

    expect(await service.evaluateUser(held.userId)).toBe(1);
    expect(await rowsOf("BOND_REDEMPTION_UNBOOKED")).toHaveLength(1);

    // Dismissed 31 days ago: any other notification would be purged now.
    await owner.query(
      `UPDATE notifications SET dismissed_at = $1, is_read = true`,
      [daysAgo(31)],
    );
    await writeDoor.purgeOld();
    expect(await rowsOf("BOND_REDEMPTION_UNBOOKED")).toHaveLength(1);
    expect(await service.evaluateUser(held.userId)).toBe(0);
    expect(await rowsOf("BOND_REDEMPTION_UNBOOKED")).toHaveLength(1);

    // Dismissed over a year ago: forgotten, so the state raises it afresh.
    await owner.query(`UPDATE notifications SET dismissed_at = $1`, [
      daysAgo(366),
    ]);
    await writeDoor.purgeOld();
    expect(await rowsOf("BOND_REDEMPTION_UNBOOKED")).toHaveLength(0);
    expect(await service.evaluateUser(held.userId)).toBe(1);
  });

  it("run() picks up the owner of an active bond security and ignores one whose bond security is inactive", async () => {
    const active = await hold("tos1029", "TOS", "TOS1029", "2023-10-16", 40);
    const inactive = await hold("tos1029", "TOS", "TOS1029", "2023-10-16", 40, {
      active: false,
    });

    await service.run();

    const rows = await rowsOf("BOND_MATURITY_SOON");
    expect(rows.map((r) => r.user_id)).toEqual([active.userId]);
    const other: Array<{ n: string }> = await owner.query(
      `SELECT COUNT(*)::text AS n FROM notifications WHERE user_id = $1`,
      [inactive.userId],
    );
    expect(other[0].n).toBe("0");
  });
});
