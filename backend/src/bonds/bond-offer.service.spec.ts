import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { ManifestName, manifestDocument } from "./adapters/pl/pl-test-input";
import { BondOfferService } from "./bond-offer.service";
import { BondValuationService } from "./bond-valuation.service";
import { ExactDecimal } from "./domain/exact-decimal";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

type Doc = Record<string, any>;

interface Stored {
  id: string;
  country: string;
  /** Newest first, like the query's ORDER BY. */
  versions: Array<{ version: number; terms: Doc }>;
}

const CPI = "PL_CPI_GUS_YOY";

/** A catalog document of a manifest, re-dated and renamed as another series of the same product. */
function series(
  name: ManifestName,
  seriesCode: string,
  window: { from: string; to: string },
  edit: (doc: Doc) => void = () => undefined,
): Stored {
  const doc = manifestDocument(name);
  doc.instrument.seriesCode = seriesCode;
  doc.saleWindow = window;
  edit(doc);
  return {
    id: `id-${seriesCode}`,
    country: "PL",
    versions: [{ version: 1, terms: doc }],
  };
}

const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

/**
 * A manager that answers the offer service's queries from an in-memory catalog.
 * The sale-window predicate of the SQL is emulated here; the real statement is
 * run by the integration spec.
 */
function setup(
  catalog: Stored[],
  options: { cpi?: Record<string, string>; timezone?: string } = {},
) {
  const { manager, dataSource } = createScopedDbMocks();
  manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("FROM user_preferences")) {
      return options.timezone
        ? [{ timezone: options.timezone, last_client_timezone: null }]
        : [];
    }
    if (sql.includes("JOIN LATERAL")) {
      const [country, second] = params as [string, string | undefined];
      const own = catalog.filter((s) => s.country === country);
      if (sql.includes("newest.terms->'saleWindow'")) {
        return own
          .filter((s) => {
            const w = s.versions[0].terms.saleWindow;
            return w && w.from <= second! && w.to >= second!;
          })
          .map((s) => ({ id: s.id }));
      }
      return own
        .filter(
          (s) =>
            second === undefined ||
            s.versions[0].terms.instrument.programCode === second,
        )
        .map((s) => ({
          program_code: s.versions[0].terms.instrument.programCode,
          version: s.versions[0].version,
          terms: s.versions[0].terms,
        }));
    }
    if (sql.includes("FROM bond_instruments")) {
      const found = catalog.find((s) => s.id === params[0]);
      const t = found?.versions[0].terms;
      return found
        ? [
            {
              id: found.id,
              issuer_country_code: t!.instrument.issuerCountryCode,
              issuer_code: t!.instrument.issuerCode,
              program_code: t!.instrument.programCode,
              series_code: t!.instrument.seriesCode,
              currency_code: t!.instrument.currency,
            },
          ]
        : [];
    }
    if (sql.includes("FROM bond_terms_versions")) {
      const found = catalog.find((s) => s.id === params[0])!;
      return [found.versions[0]];
    }
    if (sql.includes("FROM bond_period_rates")) return [];
    if (sql.includes("FROM benchmark_series")) {
      return options.cpi
        ? [
            {
              kind: "MONTHLY",
              publisher: "GUS",
              covered_through: "2026-09-30",
              updated_at: null,
            },
          ]
        : [];
    }
    if (sql.includes("FROM benchmark_values")) {
      return Object.entries(options.cpi ?? {}).map(([month, value]) => ({
        observation_date: `${month}-01`,
        value,
      }));
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const ds = dataSource as unknown as DataSource;
  const valuation = new BondValuationService(ds);
  return { service: new BondOfferService(ds, valuation), manager, valuation };
}

describe("BondOfferService.offer", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-15T10:00:00Z"));
  });
  afterEach(() => jest.useRealTimers());

  it("lists the series whose window holds the financial today: inside, before and after", async () => {
    const { service, manager } = setup([
      series("tos1029", "TOS1029", OCTOBER),
      series("tos1029", "TOS0929", { from: "2026-09-01", to: "2026-09-30" }),
      series("tos1029", "TOS1229", { from: "2026-11-01", to: "2026-11-30" }),
    ]);
    const offer = await service.offer("u1", "pl");
    expect(offer.countryCode).toBe("PL");
    expect(offer.today).toBe("2026-10-15");
    expect(offer.series.map((s) => s.seriesCode)).toEqual(["TOS1029"]);
    const [sql, params] = manager.query.mock.calls.find(([q]) =>
      String(q).includes("newest.terms->'saleWindow'"),
    )!;
    expect(params).toEqual(["PL", "2026-10-15"]);
    expect(sql).toContain("ORDER BY v.version DESC");
  });

  it("includes the first and the last day of the window", async () => {
    const { service } = setup([series("tos1029", "TOS1029", OCTOBER)]);
    jest.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    expect((await service.offer("u1", "PL")).series).toHaveLength(1);
    jest.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    expect((await service.offer("u1", "PL")).series).toHaveLength(1);
    jest.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    expect((await service.offer("u1", "PL")).series).toHaveLength(0);
  });

  it("reads today in the user's own timezone", async () => {
    const stored = [series("tos1029", "TOS1029", OCTOBER)];
    jest.setSystemTime(new Date("2026-10-31T23:30:00Z"));
    const utc = setup(stored);
    expect((await utc.service.offer("u1", "PL")).today).toBe("2026-10-31");
    const warsaw = setup(stored, { timezone: "Europe/Warsaw" });
    const offer = await warsaw.service.offer("u1", "PL");
    expect(offer.today).toBe("2026-11-01");
    expect(offer.series).toHaveLength(0);
  });

  it("offers a series by its newest terms version only", async () => {
    const stored = series("tos1029", "TOS1029", OCTOBER);
    const v2 = manifestDocument("tos1029");
    v2.saleWindow = { from: "2026-11-01", to: "2026-11-30" };
    stored.versions.unshift({ version: 2, terms: v2 });
    const { service } = setup([stored]);
    expect((await service.offer("u1", "PL")).series).toEqual([]);
  });

  it("answers an empty offer for a country with no series", async () => {
    const { service } = setup([series("tos1029", "TOS1029", OCTOBER)]);
    await expect(service.offer("u1", "DE")).resolves.toMatchObject({
      countryCode: "DE",
      series: [],
    });
  });

  it("states the terms of a series and its source", async () => {
    const { service } = setup([series("edo1036", "EDO1036", OCTOBER)], {
      cpi: { "2026-08": "0.0290" },
    });
    const [edo] = (await service.offer("u1", "PL")).series;
    expect(edo).toMatchObject({
      instrumentId: "id-EDO1036",
      issuerCountryCode: "PL",
      issuerCode: "PL_MF",
      programCode: "EDO",
      seriesCode: "EDO1036",
      currency: "PLN",
      saleWindow: OCTOBER,
      periodMonths: 12,
      periodCount: 10,
      rateRule: {
        type: "INFLATION_PLUS_MARGIN_AS_RATE",
        benchmarkId: CPI,
        annualRate: null,
        firstPeriodRate: "0.0535",
        addend: "0.0200",
        benchmarkFloor: "0",
      },
      capitalization: "COMPOUND_AT_PERIOD_END",
      termsSource: {
        provider: "PL_MF",
        document: "List emisyjny nr 99/2026",
      },
    });
    expect(edo.redemption).toMatchObject({
      type: "ON_DEMAND",
      penalties: [{ type: "FIXED_FEE_PER_UNIT", amount: "3.00" }],
      proceedsFloor: { type: "FACE_VALUE", appliesTo: "ALL_PERIODS" },
    });
  });

  it("has no redemption policy for a series redeemable at maturity only", async () => {
    const stored = series("tos1029", "TOS1029", OCTOBER, (doc) => {
      doc.redemption = { type: "MATURITY_ONLY" };
    });
    const { service } = setup([stored]);
    const [tos] = (await service.offer("u1", "PL")).series;
    expect(tos.redemption).toBeNull();
  });

  describe("the projection", () => {
    it("is the engine's maturity value of one bond bought today for a compounding bond", async () => {
      const { service, valuation } = setup([
        series("tos1029", "TOS1029", OCTOBER),
      ]);
      const spy = jest.spyOn(valuation, "valueLotFrom");
      const [tos] = (await service.offer("u1", "PL")).series;
      const engine = spy.mock.results[0].value;
      expect(spy.mock.calls[0][1]).toEqual({
        purchaseDate: "2026-10-15",
        quantity: 1,
      });
      expect(spy.mock.calls[0][2]).toBe("2026-10-15");
      expect(engine.maturityValueKnown).toBe("113.79");
      expect(tos.projection.maturityValue).toBe(engine.maturityValueKnown);
      expect(tos.projection).toMatchObject({
        maturityValue: "113.79",
        totalReturn: "0.1379",
        projected: false,
        assumptions: [],
        projectionMissing: [],
      });
    });

    describe("a discount bill", () => {
      const bill = (code: string, issue: string, maturity: string) =>
        series("tos1029", code, OCTOBER, (doc) => {
          doc.instrument.faceValue = "100";
          doc.instrument.issuePrice = "99.00";
          doc.schedule = {
            anchor: "ISSUE_DATE",
            issueDate: issue,
            maturityDate: maturity,
            periodCount: 1,
            calendarId: "PL",
          };
          doc.rateRule = { type: "ZERO_COUPON_DISCOUNT" };
          doc.capitalization = { type: "NONE" };
          doc.redemption = { type: "MATURITY_ONLY" };
        });

      it("gives a 28-day bill its exact length and annualizes over 28/365 of a year", async () => {
        const { service } = setup([
          bill("BIL0001", "2026-10-15", "2026-11-12"),
        ]);
        const [b] = (await service.offer("u1", "PL")).series;
        expect(b.lengthDays).toBe(28);
        // The month fields stay the whole months, at least one: display only.
        expect(b.periodMonths).toBe(1);
        // (100 / 99)^(365 / 28) - 1 = 0.13998: not the 0.1281 of
        // (100 / 99)^12 - 1 that a length of "1 month" would give.
        expect(b.projection.totalReturn).toBe("0.0101");
        expect(b.projection.annualizedReturn).toBe("0.1400");
      });

      it("gives a 182-day bill its exact length and annualizes over 182/365 of a year", async () => {
        const { service } = setup([
          bill("BIL0002", "2026-10-15", "2027-04-15"),
        ]);
        const [b] = (await service.offer("u1", "PL")).series;
        expect(b.lengthDays).toBe(182);
        expect(b.periodMonths).toBe(6);
        // (100 / 99)^(365 / 182) - 1 = 0.0204...
        expect(b.projection.annualizedReturn).toBe("0.0204");
      });
    });

    it("has no length in days for a schedule counted in months", async () => {
      const { service } = setup([series("tos1029", "TOS1029", OCTOBER)]);
      const [tos] = (await service.offer("u1", "PL")).series;
      expect(tos.lengthDays).toBeNull();
      expect(tos.periodMonths * tos.periodCount).toBe(36);
    });

    it("annualizes E1 (TOS at 4.40 percent for 3 years, compounding) to 0.0440", async () => {
      const { service } = setup([series("tos1029", "TOS1029", OCTOBER)]);
      const [tos] = (await service.offer("u1", "PL")).series;
      expect(tos.projection.annualizedReturn).toBe("0.0440");
    });

    it("sums every coupon and the face value for a coupon bond, coupons not reinvested", async () => {
      const { service } = setup([series("coi1030", "COI1030", OCTOBER)], {
        cpi: { "2026-08": "0.0290" },
      });
      const assume = new Map([[CPI, "0.025"]]);
      const [coi] = (await service.offer("u1", "PL", assume)).series;
      // 4.75 (first period) + 3 x 4.00 (2.5% + 1.5% margin) + 100 face
      expect(coi.projection).toMatchObject({
        maturityValue: "116.75",
        totalReturn: "0.1675",
        annualizedReturn: "0.0395",
        projected: true,
        assumptions: [{ benchmarkId: CPI, value: "0.0250", basis: "SUPPLIED" }],
        projectionMissing: [],
      });
    });

    it("labels the latest observation when no assumption is supplied", async () => {
      const { service } = setup([series("coi1030", "COI1030", OCTOBER)], {
        cpi: { "2026-07": "0.0300", "2026-08": "0.0290" },
      });
      const [coi] = (await service.offer("u1", "PL")).series;
      expect(coi.projection.projected).toBe(true);
      expect(coi.projection.assumptions).toEqual([
        expect.objectContaining({
          benchmarkId: CPI,
          value: "0.0290",
          basis: "LATEST_OBSERVATION",
        }),
      ]);
      // 4.75 + 3 x 4.40 (2.90% + 1.50%) + 100
      expect(coi.projection.maturityValue).toBe("117.95");
    });

    it("an assumption replaces future periods only: a known first period stays", async () => {
      const { service } = setup([series("edo1036", "EDO1036", OCTOBER)]);
      const low = (await service.offer("u1", "PL", new Map([[CPI, "0"]])))
        .series[0].projection;
      const high = (await service.offer("u1", "PL", new Map([[CPI, "0.05"]])))
        .series[0].projection;
      expect(
        ExactDecimal.parse(high.maturityValue as string).cmp(
          ExactDecimal.parse(low.maturityValue as string),
        ),
      ).toBe(1);
      expect(low.projected && high.projected).toBe(true);
    });

    it("has null figures and says what is missing with neither an observation nor an assumption", async () => {
      const { service } = setup([
        series("coi1030", "COI1030", OCTOBER),
        series("edo1036", "EDO1036", OCTOBER),
      ]);
      const offer = await service.offer("u1", "PL");
      for (const s of offer.series) {
        expect(s.projection).toMatchObject({
          maturityValue: null,
          totalReturn: null,
          annualizedReturn: null,
          assumptions: [],
        });
        expect(s.projection.projectionMissing).toEqual([
          { benchmarkId: CPI, publisher: null },
        ]);
      }
    });

    it("applies an assumption only to the series that read its benchmark", async () => {
      const { service } = setup(
        [
          series("tos1029", "TOS1029", OCTOBER),
          series("coi1030", "COI1030", OCTOBER),
        ],
        { cpi: { "2026-08": "0.0290" } },
      );
      const offer = await service.offer("u1", "PL", new Map([[CPI, "0.05"]]));
      const bySeries = Object.fromEntries(
        offer.series.map((s) => [s.seriesCode, s.projection]),
      );
      expect(bySeries.TOS1029).toMatchObject({
        projected: false,
        assumptions: [],
        maturityValue: "113.79",
      });
      expect(bySeries.COI1030.assumptions).toEqual([
        expect.objectContaining({ value: "0.0500", basis: "SUPPLIED" }),
      ]);
      // An assumption nobody reads changes nothing and is not an error.
      const unread = await service.offer(
        "u1",
        "PL",
        new Map([["OTHER", "0.1"]]),
      );
      expect(unread.series[0].projection.projected).toBe(false);
    });
  });
});

describe("BondOfferService.history", () => {
  const month = (year: number, m: number) => {
    const mm = String(m).padStart(2, "0");
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` };
  };
  const edo = (
    code: string,
    window: { from: string; to: string },
    first: string,
    margin: string,
    fee: string,
  ) =>
    series("edo1036", code, window, (doc) => {
      doc.rateRule.firstPeriodRate = first;
      doc.rateRule.margin = margin;
      doc.redemption.penalties[0].amount = fee;
    });

  it("orders a program by the start of the sale window, with its rate, margin, fee and floor", async () => {
    const { service } = setup([
      edo("EDO0225", month(2025, 2), "0.0560", "0.0200", "2.00"),
      edo("EDO0125", month(2025, 1), "0.0575", "0.0250", "3.00"),
      series("ots0127", "OTS0425", month(2025, 1)),
    ]);
    const history = await service.history("PL", "EDO");
    expect(history.countryCode).toBe("PL");
    expect(history.programs).toHaveLength(1);
    const [program] = history.programs;
    expect(program.programCode).toBe("EDO");
    expect(program.series.map((s) => s.seriesCode)).toEqual([
      "EDO0125",
      "EDO0225",
    ]);
    expect(program.series[0]).toEqual({
      seriesCode: "EDO0125",
      saleWindow: month(2025, 1),
      firstPeriodRate: "0.0575",
      annualRate: null,
      addend: "0.0250",
      fee: "3.00",
      proceedsFloor: "ALL_PERIODS",
      termsVersion: 1,
      termsSource: expect.objectContaining({ provider: "PL_MF" }),
    });
    expect(program.series[1].fee).toBe("2.00");
  });

  it("states a fixed rate as the annual rate, no fee and no floor as null", async () => {
    const { service } = setup([
      series("ots0127", "OTS0127", OCTOBER),
      series("tos1029", "TOS1029", OCTOBER),
    ]);
    const { programs } = await service.history("PL");
    expect(programs.map((p) => p.programCode)).toEqual(["OTS", "TOS"]);
    expect(programs[0].series[0]).toMatchObject({
      annualRate: "0.0200",
      firstPeriodRate: null,
      addend: null,
      fee: null,
      proceedsFloor: null,
    });
    expect(programs[1].series[0]).toMatchObject({
      annualRate: "0.0440",
      fee: "1.00",
    });
  });

  it("reports the newest terms version of each series", async () => {
    const stored = edo("EDO0125", month(2025, 1), "0.0575", "0.0250", "3.00");
    const v2 = JSON.parse(JSON.stringify(stored.versions[0].terms));
    v2.rateRule.firstPeriodRate = "0.0580";
    stored.versions.unshift({ version: 2, terms: v2 });
    const { service } = setup([stored]);
    const [program] = (await service.history("PL", "EDO")).programs;
    expect(program.series[0]).toMatchObject({
      termsVersion: 2,
      firstPeriodRate: "0.0580",
    });
  });

  it("names the months between the first and the last stored one that are absent, from the adapter's first validated month", async () => {
    const { service } = setup([
      edo("EDO0125", month(2025, 1), "0.0575", "0.0250", "3.00"),
      edo("EDO0225", month(2025, 2), "0.0560", "0.0200", "2.00"),
      edo("EDO0425", month(2025, 4), "0.0560", "0.0200", "2.00"),
    ]);
    const [program] = (await service.history("PL", "EDO")).programs;
    expect(program.coverage).toEqual({
      from: "2024-01",
      to: "2025-04",
      missingMonths: [
        "2024-01",
        "2024-02",
        "2024-03",
        "2024-04",
        "2024-05",
        "2024-06",
        "2024-07",
        "2024-08",
        "2024-09",
        "2024-10",
        "2024-11",
        "2024-12",
        "2025-03",
      ],
    });
  });

  it("is complete when every month between is stored, and starts at the earliest stored month without a validated start", async () => {
    const { service } = setup(
      [
        edo("EDO0125", month(2025, 1), "0.0575", "0.0250", "3.00"),
        edo("EDO0225", month(2025, 2), "0.0560", "0.0200", "2.00"),
      ].map((s) => ({ ...s, country: "XX" })),
    );
    const [program] = (await service.history("XX", "EDO")).programs;
    expect(program.coverage).toEqual({
      from: "2025-01",
      to: "2025-02",
      missingMonths: [],
    });
  });

  it("has no coverage for a program whose series carry no sale window", async () => {
    const { service } = setup([
      series("tos1029", "TOS1029", OCTOBER, (doc) => {
        doc.saleWindow = null;
      }),
    ]);
    const [program] = (await service.history("PL")).programs;
    expect(program.series[0].saleWindow).toBeNull();
    expect(program.coverage).toEqual({
      from: null,
      to: null,
      missingMonths: [],
    });
  });

  it("answers no programs for a country with nothing stored", async () => {
    const { service } = setup([]);
    await expect(service.history("PL")).resolves.toEqual({
      countryCode: "PL",
      programs: [],
    });
  });

  it("passes the program to the query as a parameter, never in the text", async () => {
    const { service, manager } = setup([]);
    await service.history("pl", "EDO");
    const [sql, params] = manager.query.mock.calls[0];
    expect(params).toEqual(["PL", "EDO"]);
    expect(sql).not.toContain("EDO");
  });
});
