import { Logger, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { FetchSyncJob } from "../common/jobs/fetch-sync.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { manifest, manifestDocument } from "./adapters/pl/pl-test-input";
import { parseBondTerms } from "./domain/bond-terms";
import { ExactDecimal } from "./domain/exact-decimal";
import {
  BOND_ENGINE_PRICE_SOURCE,
  BondPriceService,
} from "./bond-price.service";
import {
  BondReferenceData,
  BondValuationService,
} from "./bond-valuation.service";
import * as engine from "./engine/bond-engine";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
  withUserContext: jest.fn((_userId: string, fn: () => unknown) => fn()),
}));
jest.mock("../securities/holding-accounts-dirty.util", () => ({
  markHoldingAccountsDirty: jest.fn(),
}));
jest.mock("../securities/portfolio-summary-memo", () => ({
  invalidatePortfolioSummary: jest.fn(),
}));

import { withSystemContext, withUserContext } from "../common/db/with-context";
import { markHoldingAccountsDirty } from "../securities/holding-accounts-dirty.util";
import { invalidatePortfolioSummary } from "../securities/portfolio-summary-memo";

const USER = "user-1";
const SECURITY = "sec-1";
const INSTRUMENT = "11111111-1111-5111-8111-111111111111";
const PROGRAM = "33333333-3333-5333-8333-333333333333";

/** TOS1029: 100.00 face, 4.40 % for the first 12-month period, per-bond value rounded to cents. */
const TOS: BondReferenceData = {
  instrument: {
    id: INSTRUMENT,
    issuerCountryCode: "PL",
    issuerCode: "PL_MF",
    programCode: "TOS",
    seriesCode: "TOS1029",
    currencyCode: "PLN",
    termsProvider: "curated",
  },
  termsVersion: 1,
  terms: manifest("tos1029"),
  announcedRates: new Map(),
  benchmarks: new Map(),
};

/**
 * The per-bond gross value `a` days into a 365-day first period, in cents,
 * computed on its own (integers only): 100 x (1 + 0.044 a / 365), half-up.
 */
function grossCents(a: number): bigint {
  const num = 10000n * (365000n + 44n * BigInt(a));
  return (2n * num + 365000n) / (2n * 365000n);
}
const money = (cents: bigint) =>
  `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
/** price = sum(lot cents x quantity) / quantity, 10 decimals. */
function price(lots: Array<{ a: number; qty: bigint }>): string {
  const total = lots.reduce((s, l) => s + grossCents(l.a) * l.qty, 0n);
  const qty = lots.reduce((s, l) => s + l.qty, 0n);
  const scaled = (2n * total * 10n ** 10n + qty * 100n) / (2n * qty * 100n);
  const digits = scaled.toString().padStart(11, "0");
  return `${digits.slice(0, -10)}.${digits.slice(-10)}`;
}

interface Tx {
  action: string;
  status?: string;
  date: string;
  quantity: string | null;
  account?: string;
  /** The other leg's account when this row is a paired transfer leg. */
  counterpart?: string;
  /** The series the row stores (the one instrument by default); null for none. */
  series?: string | null;
}

function setup(
  transactions: Tx[],
  opts: {
    upsertRows?: number;
    deleteRows?: number;
    security?: unknown[];
    reference?: BondReferenceData;
    /** Reference data per series id, for a ledger of several series. */
    references?: Record<string, BondReferenceData>;
    timezone?: string | null;
    /** The series ids the sale-window inference of a row with none finds. */
    onSale?: string[];
  } = {},
) {
  const { manager, dataSource } = createScopedDbMocks();
  const events: string[] = [];
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  dataSource.transaction.mockImplementation(
    async (fn: (m: unknown) => unknown) => {
      events.push("begin");
      const result = await fn(manager);
      events.push("commit");
      return result;
    },
  );
  manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes("pg_advisory_xact_lock")) {
      events.push("lock");
      return [];
    }
    if (sql.includes("saleWindow")) {
      return (opts.onSale ?? []).map((id) => ({ id }));
    }
    if (sql.includes("FROM user_preferences")) {
      return opts.timezone === undefined
        ? []
        : [{ timezone: opts.timezone, last_client_timezone: null }];
    }
    if (sql.includes("FROM securities")) {
      return (
        opts.security ?? [
          {
            id: SECURITY,
            user_id: USER,
            symbol: "TOS1029",
            currency_code: "PLN",
            bond_program_id: PROGRAM,
            bond_auto_fetch: false,
          },
        ]
      );
    }
    if (sql.includes("FROM investment_transactions")) {
      return transactions.map((t) => ({
        action: t.action,
        status: t.status ?? "UNRECONCILED",
        tx_date: t.date,
        quantity: t.quantity,
        account_id: t.account ?? "acct-1",
        counterpart_account_id: t.counterpart ?? null,
        bond_instrument_id: t.series === undefined ? INSTRUMENT : t.series,
      }));
    }
    if (sql.includes("INSERT INTO security_prices")) {
      events.push("upsert");
      return Array.from({ length: opts.upsertRows ?? 0 }, (_, i) => ({
        id: i,
      }));
    }
    if (sql.includes("DELETE FROM security_prices")) {
      events.push("delete");
      // A DELETE ... RETURNING answers the tuple [rows, rowCount].
      const rows = Array.from({ length: opts.deleteRows ?? 0 }, (_, i) => ({
        id: i,
      }));
      return [rows, rows.length];
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  const valuation = new BondValuationService(
    dataSource as unknown as DataSource,
  );
  jest.spyOn(valuation, "loadReference").mockImplementation(async (_m, id) => {
    const reference = opts.references?.[id] ?? opts.reference ?? TOS;
    return reference;
  });
  const netWorth = {
    triggerDebouncedRecalc: jest.fn(() => events.push("recalc")),
  };
  (markHoldingAccountsDirty as jest.Mock).mockImplementation(async () => {
    events.push("dirty");
    return ["acct-1", "acct-2"];
  });
  (invalidatePortfolioSummary as jest.Mock).mockImplementation(() =>
    events.push("invalidate"),
  );
  const fetchSync = {
    withLease: jest.fn(async (_job: string, _ms: number, fn: () => unknown) =>
      fn(),
    ),
  };
  const service = new BondPriceService(
    dataSource as unknown as DataSource,
    valuation,
    netWorth as never,
    fetchSync as never,
  );
  const call = (sqlPart: string) =>
    statements.find((s) => s.sql.includes(sqlPart));
  return { service, valuation, netWorth, fetchSync, events, statements, call };
}

const buy = (date: string, quantity: string): Tx => ({
  action: "BUY",
  date,
  quantity,
});

describe("BondPriceService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe("recomputeSecurity: the price of each day", () => {
    it("is the engine's gross value per bond on every day from the first lot to today", async () => {
      const { service, call } = setup([buy("2026-10-15", "25.00000000")]);

      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-20" });

      const [, dates, prices] = call("INSERT INTO security_prices")!.params;
      expect(dates).toEqual([
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
        "2026-10-18",
        "2026-10-19",
        "2026-10-20",
      ]);
      expect(prices).toEqual(
        [0, 1, 2, 3, 4, 5].map((a) => price([{ a, qty: 25n }])),
      );
      // The cents a reader can check by hand: 100.00, then 100.01 (0.0120547..).
      expect((prices as string[]).slice(0, 2)).toEqual([
        "100.0000000000",
        "100.0100000000",
      ]);
    });

    it("equals the TOS value 182 days in: 102.19 per bond, 2554.75 for 25", async () => {
      const { service, call } = setup([buy("2026-10-15", "25")]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2027-04-15" });

      const [, dates, prices] = call("INSERT INTO security_prices")!.params as [
        string,
        string[],
        string[],
      ];
      expect(dates[dates.length - 1]).toBe("2027-04-15");
      expect(prices[prices.length - 1]).toBe("102.1900000000");
      // The lot total follows from what the service wrote: its per-bond price
      // times the 25 bonds (the helper alone proves nothing about the service).
      const [whole, fraction] = prices[prices.length - 1].split(".");
      const writtenCents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2));
      expect(money(writtenCents * 25n)).toBe("2554.75");
    });

    it("averages lots of different dates by quantity, per bond", async () => {
      // Both purchases lie in the series' sale window (October 2026).
      const { service, call } = setup([
        buy("2026-10-10", "10"),
        buy("2026-10-31", "30"),
      ]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-31" });

      const [, dates, prices] = call("INSERT INTO security_prices")!.params as [
        string,
        string[],
        string[],
      ];
      const at = (d: string) => prices[dates.indexOf(d)];
      // Before the second purchase: the first lot alone, 20 days in.
      expect(at("2026-10-30")).toBe(price([{ a: 20, qty: 10n }]));
      // On it: 21 days into lot 1, 0 into lot 2, weighted 10 : 30.
      expect(at("2026-10-31")).toBe(
        price([
          { a: 21, qty: 10n },
          { a: 0, qty: 30n },
        ]),
      );
      expect(at("2026-10-31")).toBe("100.0625000000");
    });

    it("blends the lots of every account into the one price of the security", async () => {
      const { service, call } = setup([
        { ...buy("2026-10-10", "10"), account: "acct-ike" },
        { ...buy("2026-10-31", "30"), account: "acct-plain" },
      ]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-31" });
      const [, dates, prices] = call("INSERT INTO security_prices")!.params as [
        string,
        string[],
        string[],
      ];
      expect(prices[dates.indexOf("2026-10-31")]).toBe(
        price([
          { a: 21, qty: 10n },
          { a: 0, qty: 30n },
        ]),
      );
    });

    it("a sale in one account leaves the other account's lot priced, FIFO within the account (R6)", async () => {
      const { service, call } = setup([
        { ...buy("2026-10-10", "10"), account: "acct-ike" },
        { ...buy("2026-10-20", "10"), account: "acct-plain" },
        {
          action: "SELL",
          date: "2026-10-25",
          quantity: "10",
          account: "acct-plain",
        },
      ]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-26" });
      const [, dates, prices] = call("INSERT INTO security_prices")!.params as [
        string,
        string[],
        string[],
      ];
      // The older IKE lot is what is left (16 days in), not the plain account's.
      expect(prices[dates.indexOf("2026-10-26")]).toBe(
        price([{ a: 16, qty: 10n }]),
      );
    });

    it("gives no price on a day a lot is outside the sale window (REFUSED), as for any unknown", async () => {
      const { service, call } = setup([
        buy("2026-10-10", "10"),
        buy("2026-11-05", "10"),
      ]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-11-06" });
      const [, dates] = call("INSERT INTO security_prices")!.params as [
        string,
        string[],
      ];
      expect(dates).toContain("2026-11-04");
      expect(dates).not.toContain("2026-11-05");
      expect(dates).not.toContain("2026-11-06");
    });

    it("resolves each distinct lot's schedule once, not once per day (R1)", async () => {
      const { service } = setup([buy("2026-10-10", "10")]);
      const spy = jest.spyOn(engine, "grossValueSeries");
      await service.recomputeSecurity(USER, SECURITY, { today: "2027-10-10" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].days).toHaveLength(366);
    });

    it("prices a past day on the lots held that day, not on what is left today", async () => {
      const { service, call } = setup([
        buy("2026-10-15", "10"),
        { action: "SELL", date: "2026-10-18", quantity: "10" },
        buy("2026-10-20", "5"),
      ]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-21" });

      const [, dates, prices] = call("INSERT INTO security_prices")!.params as [
        string,
        string[],
        string[],
      ];
      // Held 15th-17th (sold out on the 18th: no lots, no price), bought again on the 20th.
      expect(dates).toEqual([
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
        "2026-10-20",
        "2026-10-21",
      ]);
      expect(prices[2]).toBe(price([{ a: 2, qty: 10n }]));
      expect(prices[3]).toBe(price([{ a: 0, qty: 5n }]));
    });

    it("gives no price from the day the lots become unknowable (a split), and keeps the days before", async () => {
      const { service, call } = setup([
        buy("2026-10-15", "10"),
        { action: "SPLIT", date: "2026-10-17", quantity: "2" },
      ]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-20" });
      const [, dates] = call("INSERT INTO security_prices")!.params;
      expect(dates).toEqual(["2026-10-15", "2026-10-16"]);
    });

    it("skips a day on which any open lot has no gross value, never pricing it from the others", async () => {
      const { service, call } = setup([
        buy("2026-10-15", "10"),
        buy("2026-10-16", "30"),
      ]);
      const real = engine.grossValueSeries;
      jest.spyOn(engine, "grossValueSeries").mockImplementation((input) =>
        real(input).map((point) =>
          // The second lot has no rate on the 18th (a started period, INV-BOND-002).
          input.lot.purchaseDate === "2026-10-16" && point.asOf === "2026-10-18"
            ? { ...point, grossValue: null }
            : point,
        ),
      );

      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-19" });

      const [, dates] = call("INSERT INTO security_prices")!.params;
      expect(dates).toEqual([
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
        "2026-10-19",
      ]);
    });

    it("ignores VOID rows and prices nothing when there are no lots", async () => {
      const { service, call } = setup([
        { ...buy("2026-10-15", "10"), status: "VOID" },
      ]);
      const result = await service.recomputeSecurity(USER, SECURITY, {
        today: "2026-10-20",
      });
      expect(call("INSERT INTO security_prices")).toBeUndefined();
      expect(call("DELETE FROM security_prices")!.params[1]).toEqual([]);
      expect(result).toEqual({ written: 0, deleted: 0 });
    });

    it("recomputes a 10-year EDO lot bought 10 years ago in well under a second (R1)", async () => {
      // The sale window is lifted so a lot can be that old; every CPI month is known.
      const document = manifestDocument("edo1036");
      document.saleWindow = null;
      const terms = parseBondTerms(document);
      const values = new Map<string, string>();
      for (let y = 2015; y <= 2027; y++)
        for (let m = 1; m <= 12; m++)
          values.set(`${y}-${String(m).padStart(2, "0")}`, "0.034");
      const benchmarkId = (terms.rateRule as { benchmarkId: string })
        .benchmarkId;
      const reference: BondReferenceData = {
        ...TOS,
        terms,
        benchmarks: new Map([
          [benchmarkId, { kind: "MONTHLY", publisher: "GUS", values }],
        ]),
      };
      const { service, call } = setup([buy("2016-10-03", "10")], {
        reference,
      });

      const started = Date.now();
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-10" });
      const elapsed = Date.now() - started;

      const [, dates] = call("INSERT INTO security_prices")!.params as [
        string,
        string[],
      ];
      expect(dates.length).toBeGreaterThan(3600);
      expect(elapsed).toBeLessThan(1000);
    });

    it("blends the lots of two series by quantity, each valued by its own series' terms", async () => {
      const OTHER = "44444444-4444-5444-8444-444444444444";
      const ROR: BondReferenceData = {
        ...TOS,
        instrument: {
          ...TOS.instrument,
          id: OTHER,
          programCode: "ROR",
          seriesCode: "ROR1027",
        },
        terms: manifest("ror1027"),
      };
      const references = { [INSTRUMENT]: TOS, [OTHER]: ROR };
      const day = { today: "2026-10-20" };
      const priceOf = async (rows: Tx[]) => {
        const { service, call } = setup(rows, { references });
        await service.recomputeSecurity(USER, SECURITY, day);
        const [, dates, prices] = call("INSERT INTO security_prices")!.params;
        return new Map(
          (dates as string[]).map((d, i) => [d, (prices as string[])[i]]),
        );
      };
      const tosOnly = await priceOf([buy("2026-10-15", "10")]);
      const rorOnly = await priceOf([
        { ...buy("2026-10-15", "5"), series: OTHER },
      ]);
      const mixed = await priceOf([
        buy("2026-10-15", "10"),
        { ...buy("2026-10-15", "5"), series: OTHER },
      ]);
      for (const [d, blended] of mixed) {
        const expected = ExactDecimal.parse(tosOnly.get(d) as string)
          .mul(ExactDecimal.fromInt(10))
          .add(
            ExactDecimal.parse(rorOnly.get(d) as string).mul(
              ExactDecimal.fromInt(5),
            ),
          )
          .div(ExactDecimal.fromInt(15));
        // Each single-series price is rounded to ten places, so the blend of
        // the rounded prices agrees with the blend of the exact values to 1e-9.
        expect(
          Math.abs(Number(blended) - Number(expected.toFixed(10))),
        ).toBeLessThan(1e-9);
      }
      expect(mixed.size).toBe(6);
      // A blend, not either series' own price (the two series differ).
      expect(mixed.get("2026-10-20")).not.toBe(tosOnly.get("2026-10-20"));
      expect(mixed.get("2026-10-20")).not.toBe(rorOnly.get("2026-10-20"));
    });

    it("loads the reference data of each series once however many days it prices", async () => {
      const OTHER = "44444444-4444-5444-8444-444444444444";
      const { service, valuation } = setup(
        [buy("2026-10-15", "10"), { ...buy("2026-11-01", "5"), series: OTHER }],
        { references: { [INSTRUMENT]: TOS, [OTHER]: TOS } },
      );
      await service.recomputeSecurity(USER, SECURITY, { today: "2027-04-15" });
      expect(valuation.loadReference).toHaveBeenCalledTimes(2);
    });

    it("gives no price when an acquisition has no series and none was on sale, and removes the engine's stale days", async () => {
      const { service, call } = setup(
        [{ ...buy("2026-10-15", "10"), series: null }],
        { deleteRows: 2 },
      );
      await expect(
        service.recomputeSecurity(USER, SECURITY, { today: "2026-10-20" }),
      ).resolves.toEqual({ written: 0, deleted: 2 });
      expect(call("INSERT INTO security_prices")).toBeUndefined();
      expect(call("DELETE FROM security_prices")!.params[1]).toEqual([]);
    });

    it("prices a legacy acquisition from the series the date puts on sale", async () => {
      const { service, call } = setup(
        [{ ...buy("2026-10-15", "10"), series: null }],
        { onSale: [INSTRUMENT] },
      );
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-16" });
      const [, dates] = call("INSERT INTO security_prices")!.params;
      expect(dates).toEqual(["2026-10-15", "2026-10-16"]);
    });

    it("loads the reference data once however many days it prices", async () => {
      const { service, valuation } = setup([buy("2026-10-15", "10")]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2027-04-15" });
      expect(valuation.loadReference).toHaveBeenCalledTimes(1);
      expect(valuation.loadReference).toHaveBeenCalledWith(
        expect.anything(),
        INSTRUMENT,
      );
    });
  });

  describe("recomputeSecurity: what is written", () => {
    it("replaces every non-manual row of its days, never a manual one, and stores adjusted_close NULL (R3)", async () => {
      const { service, call } = setup([buy("2026-10-15", "10")]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-16" });

      const upsert = call("INSERT INTO security_prices")!;
      expect(BOND_ENGINE_PRICE_SOURCE).toBe("bond_engine");
      expect(upsert.sql).toMatch(
        /ON CONFLICT \(security_id, price_date\) DO UPDATE/,
      );
      expect(upsert.sql).toMatch(
        /WHERE security_prices\.source IS DISTINCT FROM \$5::varchar/,
      );
      // An unchanged day is not rewritten: close, source or adjusted differs.
      expect(upsert.sql).toMatch(
        /security_prices\.close_price IS DISTINCT FROM EXCLUDED\.close_price/,
      );
      expect(upsert.sql).toMatch(
        /security_prices\.source IS DISTINCT FROM EXCLUDED\.source/,
      );
      expect(upsert.sql).toMatch(/security_prices\.adjusted_close IS NOT NULL/);
      // The engine's row carries no adjusted close, inserted or on conflict.
      expect(upsert.sql).toMatch(/t\.p, NULL, \$4::varchar/);
      expect(upsert.sql).toMatch(/adjusted_close = NULL/);
      expect(upsert.sql).toMatch(/source = EXCLUDED\.source/);
      expect(upsert.params[3]).toBe("bond_engine");
      expect(upsert.params[4]).toBe("manual");
      expect(upsert.params[0]).toBe(SECURITY);
    });

    it("uses the user's financial today when none is given: the timezone of the preferences, not the request's", async () => {
      jest.useFakeTimers({ now: new Date("2027-01-16T06:00:00Z") });
      try {
        // 22:00 on the 15th in Los Angeles, already the 16th in Warsaw.
        const la = setup([buy("2026-10-20", "10")], {
          timezone: "America/Los_Angeles",
        });
        await la.service.recomputeSecurity(USER, SECURITY);
        const laDates = la.call("INSERT INTO security_prices")!
          .params[1] as string[];
        expect(laDates[laDates.length - 1]).toBe("2027-01-15");

        const pl = setup([buy("2026-10-20", "10")], {
          timezone: "Europe/Warsaw",
        });
        await pl.service.recomputeSecurity(USER, SECURITY);
        const plDates = pl.call("INSERT INTO security_prices")!
          .params[1] as string[];
        expect(plDates[plDates.length - 1]).toBe("2027-01-16");
      } finally {
        jest.useRealTimers();
      }
    });

    it("deletes bond_engine rows of the days that no longer have a price, and only those", async () => {
      const { service, call } = setup([buy("2026-10-15", "10")], {
        deleteRows: 3,
      });
      const result = await service.recomputeSecurity(USER, SECURITY, {
        today: "2026-10-16",
      });

      const del = call("DELETE FROM security_prices")!;
      expect(del.sql).toMatch(/source = \$3::varchar/);
      expect(del.sql).toMatch(/NOT \(price_date = ANY\(\$2::date\[\]\)\)/);
      expect(del.params).toEqual([
        SECURITY,
        ["2026-10-15", "2026-10-16"],
        "bond_engine",
      ]);
      expect(result.deleted).toBe(3);
    });

    it("counts only the rows the upsert reports: an unchanged day or a manual one is not written", async () => {
      const { service } = setup([buy("2026-10-15", "10")], { upsertRows: 1 });
      await expect(
        service.recomputeSecurity(USER, SECURITY, { today: "2026-10-16" }),
      ).resolves.toEqual({ written: 1, deleted: 0 });
    });

    it("loads the security under the caller's identity, and a foreign or unlinked one is a 404 before any write", async () => {
      const foreign = setup([buy("2026-10-15", "10")], { security: [] });
      await expect(
        foreign.service.recomputeSecurity(USER, SECURITY),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(foreign.call("FROM securities")!.params).toEqual([SECURITY, USER]);
      expect(foreign.call("INSERT INTO security_prices")).toBeUndefined();
      expect(foreign.call("DELETE FROM security_prices")).toBeUndefined();

      const unlinked = setup([], {
        security: [
          {
            id: SECURITY,
            user_id: USER,
            symbol: "X",
            currency_code: "PLN",
            bond_program_id: null,
          },
        ],
      });
      await expect(
        unlinked.service.recomputeSecurity(USER, SECURITY),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("reads the ledger in the register order every replay uses, text quantities, across accounts", async () => {
      const { service, call } = setup([buy("2026-10-15", "10")]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-15" });
      const ledger = call("FROM investment_transactions t")!;
      expect(ledger.sql).toContain(
        "ORDER BY transaction_date ASC, created_at ASC, id ASC",
      );
      expect(ledger.sql).toContain("t.quantity::text");
      expect(ledger.sql).not.toMatch(/account_id\s*=/);
      expect(ledger.params).toEqual([SECURITY, USER]);
    });
  });

  describe("recomputeSecurity: derived state (INV-CACHE-001)", () => {
    it("marks the holding accounts inside the transaction and dispatches the recompute only after the commit", async () => {
      const { service, netWorth, events } = setup([buy("2026-10-15", "10")], {
        upsertRows: 2,
      });
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-16" });

      expect(markHoldingAccountsDirty).toHaveBeenCalledWith(
        expect.anything(),
        SECURITY,
        USER,
      );
      expect(events).toEqual([
        "begin",
        "lock",
        "upsert",
        "delete",
        "dirty",
        "commit",
        "invalidate",
        "recalc",
        "recalc",
      ]);
      expect(netWorth.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acct-1",
        USER,
      );
      expect(netWorth.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acct-2",
        USER,
      );
    });

    it("takes the per-security recompute lock before it reads the ledger or the link", async () => {
      const { service, statements } = setup([buy("2026-10-15", "10")]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-16" });
      expect(statements[0].sql).toContain("pg_advisory_xact_lock");
      // Scope 7 (BondPriceRecompute), keyed by the security.
      expect(statements[0].params).toEqual([7, SECURITY]);
      expect(statements[1].sql).toContain("FROM securities");
    });

    it("clearEnginePrices locks, deletes only the engine's rows, marks the accounts, and publishes after the commit", async () => {
      const { service, statements, netWorth, events } = setup([], {
        deleteRows: 3,
      });
      const manager = { query: jest.fn() };
      manager.query.mockImplementation(
        async (sql: string, params: unknown[]) => {
          statements.push({ sql, params });
          if (sql.includes("DELETE FROM security_prices"))
            return [[{}, {}, {}], 3];
          return [];
        },
      );
      const cleared = await service.clearEnginePrices(
        manager as never,
        USER,
        SECURITY,
      );
      expect(cleared).toEqual({ deleted: 3, accountIds: ["acct-1", "acct-2"] });
      expect(statements[0].sql).toContain("pg_advisory_xact_lock");
      const del = statements.find((s) =>
        s.sql.includes("DELETE FROM security_prices"),
      )!;
      expect(del.sql).toMatch(/source = \$3::varchar/);
      expect(del.params[2]).toBe("bond_engine");
      expect(events).toEqual(["dirty"]);

      service.publishClearedPrices(USER, cleared.accountIds);
      expect(invalidatePortfolioSummary).toHaveBeenCalledWith(USER);
      expect(netWorth.triggerDebouncedRecalc).toHaveBeenCalledTimes(2);
    });

    it("clearEnginePrices with nothing to delete marks nothing", async () => {
      const { service } = setup([], { deleteRows: 0 });
      const manager = {
        query: jest.fn(async (sql: string) =>
          sql.includes("DELETE") ? [[], 0] : [],
        ),
      };
      await expect(
        service.clearEnginePrices(manager as never, USER, SECURITY),
      ).resolves.toEqual({ deleted: 0, accountIds: [] });
      expect(markHoldingAccountsDirty).not.toHaveBeenCalled();
    });

    it("does nothing downstream when nothing changed", async () => {
      const { service, netWorth, events } = setup([buy("2026-10-15", "10")]);
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-16" });
      expect(markHoldingAccountsDirty).not.toHaveBeenCalled();
      expect(invalidatePortfolioSummary).not.toHaveBeenCalled();
      expect(netWorth.triggerDebouncedRecalc).not.toHaveBeenCalled();
      expect(events).not.toContain("recalc");
    });

    it("dispatches after a delete alone", async () => {
      const { service, netWorth } = setup([], { deleteRows: 1 });
      await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-16" });
      expect(invalidatePortfolioSummary).toHaveBeenCalledWith(USER);
      expect(netWorth.triggerDebouncedRecalc).toHaveBeenCalledTimes(2);
    });
  });

  describe("recomputeLinkedSecurities (after a ledger write)", () => {
    it("recomputes only the linked securities of the user among the ids, each once, and never throws", async () => {
      const { service, call } = setup([], {
        security: [{ id: "s-1" }, { id: "s-3" }],
      });
      const recompute = jest
        .spyOn(service, "recomputeSecurity")
        .mockRejectedValueOnce(new Error("no rates"))
        .mockResolvedValue({ written: 1, deleted: 0 });
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();

      await expect(
        service.recomputeLinkedSecurities(USER, ["s-1", null, "s-1", "s-3"]),
      ).resolves.toBeUndefined();

      const lookup = call("FROM securities")!;
      expect(lookup.sql).toMatch(/bond_program_id IS NOT NULL/);
      expect(lookup.sql).toMatch(/user_id = \$2/);
      expect(lookup.params).toEqual([["s-1", "s-3"], USER]);
      // One failing security does not stop the next.
      expect(recompute.mock.calls.map((c) => c[1])).toEqual(["s-1", "s-3"]);
      expect(warn).toHaveBeenCalled();
    });

    it("does nothing for no ids", async () => {
      const { service, statements } = setup([]);
      await service.recomputeLinkedSecurities(USER, [null, undefined]);
      expect(statements).toEqual([]);
    });
  });

  describe("recomputeLinkedSecuritiesOfSeries (after a series is stored, INV-CACHE-001)", () => {
    const rows = [
      { id: "s-a1", user_id: "u-a" },
      { id: "s-a2", user_id: "u-a" },
      { id: "s-b1", user_id: "u-b" },
    ];

    it("finds the securities of the stored series' programs across users in a system context, then recomputes each user's under that user's identity", async () => {
      const { service, manager } = setupForJob(rows);
      const recompute = jest
        .spyOn(service, "recomputeLinkedSecurities")
        .mockResolvedValue(undefined);

      await service.recomputeLinkedSecuritiesOfSeries([INSTRUMENT, INSTRUMENT]);

      expect(withSystemContext).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toMatch(
        /bond_program_id IN \(\s*SELECT bond_program_id FROM bond_instruments/,
      );
      expect(params).toEqual([[INSTRUMENT]]);
      expect(
        (withUserContext as jest.Mock).mock.calls.map((c) => c[0]),
      ).toEqual(["u-a", "u-b"]);
      expect(recompute.mock.calls).toEqual([
        ["u-a", ["s-a1", "s-a2"]],
        ["u-b", ["s-b1"]],
      ]);
    });

    it("does nothing for no series", async () => {
      const { service, manager } = setupForJob(rows);
      await service.recomputeLinkedSecuritiesOfSeries([]);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("logs and never throws: the series is stored, and the daily job repairs a price", async () => {
      const { service, manager } = setupForJob(rows);
      manager.query.mockRejectedValue(new Error("db down"));
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      await expect(
        service.recomputeLinkedSecuritiesOfSeries([INSTRUMENT]),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("db down"));
    });
  });

  describe("the daily job", () => {
    const linkedRows = [
      { id: "s-a1", user_id: "u-a" },
      { id: "s-a2", user_id: "u-a" },
      { id: "s-b1", user_id: "u-b" },
    ];

    it("lists linked securities across users, then recomputes each user in its own context", async () => {
      const { service, manager } = setupForJob(linkedRows);
      const recompute = jest
        .spyOn(service, "recomputeSecurity")
        .mockResolvedValue({ written: 0, deleted: 0 });

      const result = await service.recomputeAll();

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE bond_program_id IS NOT NULL"),
      );
      expect(
        (withUserContext as jest.Mock).mock.calls.map((c) => c[0]),
      ).toEqual(["u-a", "u-b"]);
      expect(recompute.mock.calls.map((c) => c.slice(0, 2))).toEqual([
        ["u-a", "s-a1"],
        ["u-a", "s-a2"],
        ["u-b", "s-b1"],
      ]);
      expect(result).toEqual({ securities: 3, failed: 0 });
      // No server-wide day is passed: each recompute resolves its own user's
      // financial today, the definition a request recompute uses (R17).
      for (const call of recompute.mock.calls) {
        expect(call[2]).toEqual({});
      }
    });

    it("isolates a failing security: logged, and the rest still run", async () => {
      const { service } = setupForJob(linkedRows);
      const recompute = jest
        .spyOn(service, "recomputeSecurity")
        .mockRejectedValueOnce(new Error("no rate"))
        .mockResolvedValue({ written: 0, deleted: 0 });

      const result = await service.recomputeAll();

      expect(recompute).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ securities: 3, failed: 1 });
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("security s-a1: no rate"),
      );
    });

    it("isolates a failing user context: its securities count as failed, the next user still runs", async () => {
      const { service } = setupForJob(linkedRows);
      (withUserContext as jest.Mock).mockImplementationOnce(async () => {
        throw new Error("context refused");
      });
      const recompute = jest
        .spyOn(service, "recomputeSecurity")
        .mockResolvedValue({ written: 0, deleted: 0 });

      const result = await service.recomputeAll();

      expect(recompute.mock.calls.map((c) => c[1])).toEqual(["s-b1"]);
      expect(result).toEqual({ securities: 3, failed: 2 });
    });

    it("runs under a system context wrapped around the whole lease call, and never throws out of the cron", async () => {
      const { service, fetchSync } = setupForJob([]);
      const all = jest
        .spyOn(service, "recomputeAll")
        .mockResolvedValue({ securities: 0, failed: 0 });

      await service.scheduledRecompute();

      expect(withSystemContext).toHaveBeenCalledTimes(1);
      expect(fetchSync.withLease).toHaveBeenCalledWith(
        FetchSyncJob.BondPrices,
        30 * 60 * 1000,
        expect.any(Function),
      );
      expect(all).toHaveBeenCalledTimes(1);

      fetchSync.withLease.mockRejectedValueOnce(new Error("db down"));
      await expect(service.scheduledRecompute()).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("db down"),
      );
    });
  });
});

function setupForJob(linked: Array<{ id: string; user_id: string }>) {
  const { manager, dataSource } = createScopedDbMocks();
  manager.query.mockResolvedValue(linked);
  const fetchSync = {
    withLease: jest.fn(async (_job: string, _ms: number, fn: () => unknown) =>
      fn(),
    ),
  };
  const service = new BondPriceService(
    dataSource as unknown as DataSource,
    {} as never,
    {} as never,
    fetchSync as never,
  );
  return { service, manager, fetchSync };
}
