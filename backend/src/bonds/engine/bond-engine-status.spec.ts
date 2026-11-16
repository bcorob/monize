import { BenchmarkData } from "../domain/benchmark";
import { lotInput, manifestDocument } from "../adapters/pl/pl-test-input";
import { parseBondTerms } from "../domain/bond-terms";
import { BondEngineInput, valueBondLot } from "./bond-engine";

const CPI = "PL_CPI_GUS_YOY";

const cpi = (...entries: [string, string][]) =>
  new Map<string, BenchmarkData>([
    [CPI, { kind: "MONTHLY", publisher: "GUS", values: new Map(entries) }],
  ]);

const edo = (
  purchase: string,
  asOf: string,
  overrides: Partial<BondEngineInput> = {},
) => valueBondLot(lotInput("edo1036", purchase, asOf, overrides));

describe("valueBondLot: the sale window (R2)", () => {
  const refused = (purchase: string) => edo(purchase, purchase);

  it.each(["2026-10-01", "2026-10-15", "2026-10-31"])(
    "a lot bought on %s, inside the window, is valued",
    (purchase) => {
      const v = refused(purchase);
      expect(v).toMatchObject({ status: "OPEN", refusal: null });
      expect(v.grossValue).toBe("100.00");
    },
  );

  it("a lot whose purchase date is a stand-in (an unpaired transfer in) is valued even outside the window", () => {
    const base = lotInput("edo1036", "2026-11-05", "2026-11-05");
    const v = valueBondLot({
      ...base,
      lot: { ...base.lot, purchaseDateAssumed: true },
    });
    expect(v).toMatchObject({ status: "OPEN", refusal: null });
    expect(v.grossValue).toBe("100.00");
  });

  it.each(["2026-09-30", "2026-11-01", "2027-01-15"])(
    "a lot bought on %s, outside the window, gets no valuation",
    (purchase) => {
      const v = refused(purchase);
      expect(v).toMatchObject({
        status: "REFUSED",
        refusal: {
          code: "PURCHASE_OUTSIDE_SALE_WINDOW",
          params: {
            from: "2026-10-01",
            to: "2026-10-31",
            purchaseDate: purchase,
          },
        },
        currentPeriod: null,
        principal: null,
        accruedInterest: null,
        grossValue: null,
        earlyRedemptionValue: null,
        maturityValueKnown: null,
        maturityValueProjected: null,
        knownCashflows: [],
        projectedCashflows: [],
        valuationComplete: false,
      });
    },
  );

  it("is refused on a later day too, whatever the data says", () => {
    const v = edo("2026-11-15", "2027-05-01", {
      announcedRates: new Map([[2, "0.0500"]]),
      benchmarks: cpi(["2027-08", "0.0300"]),
    });
    expect(v.status).toBe("REFUSED");
    expect(v.grossValue).toBeNull();
  });

  it("a null sale window is no restriction", () => {
    const doc = manifestDocument("edo1036");
    doc.saleWindow = null;
    const v = valueBondLot({
      ...lotInput("edo1036", "2031-03-03", "2031-03-03"),
      terms: parseBondTerms(doc),
    });
    expect(v).toMatchObject({ status: "OPEN", refusal: null });
    expect(v.grossValue).toBe("100.00");
  });
});

describe("valueBondLot: lot status and the current period (R22)", () => {
  it("an open lot is OPEN and always names its current period, even with the rate unknown", () => {
    const v = edo("2026-10-01", "2028-02-01");
    expect(v.status).toBe("OPEN");
    expect(v.currentPeriod).toEqual({
      index: 2,
      start: "2027-10-01",
      end: "2028-10-01",
      annualRate: null,
      rateSource: null,
    });
    const known = edo("2026-10-01", "2028-02-01", {
      benchmarks: cpi(["2027-08", "0.0290"]),
    });
    expect(known.currentPeriod).toMatchObject({
      index: 2,
      annualRate: "0.0490",
      rateSource: "DERIVED",
    });
  });

  it("a lot on or after its maturity is MATURED with no current period", () => {
    const day = edo("2026-10-01", "2036-09-30");
    expect(day.status).toBe("OPEN");
    const v = edo("2026-10-01", "2036-10-01");
    expect(v.status).toBe("MATURED");
    expect(v.currentPeriod).toBeNull();
  });
});

describe("valueBondLot: unknown amounts are never dropped (R5)", () => {
  it("a coupon whose rate is unknown is an UNKNOWN cash flow with a null amount", () => {
    // COI bought 2026-10-15, valued in period 2 with no CPI for 2027-08.
    const v = valueBondLot(
      lotInput("coi1030", "2026-10-15", "2027-10-20", {
        lot: { purchaseDate: "2026-10-15", quantity: 10 },
        benchmarks: cpi(["2026-08", "0.0290"]),
      }),
    );
    expect(v.knownCashflows).toEqual([
      expect.objectContaining({
        period: 4,
        type: "PRINCIPAL",
        amount: "1000.00",
      }),
    ]);
    // Period 2 started and is unknown; 3 and 4 are projected from 2026-08.
    expect(v.projectedCashflows).toEqual([
      {
        date: "2028-10-15",
        type: "INTEREST",
        amount: null,
        status: "UNKNOWN",
        period: 2,
      },
      expect.objectContaining({
        period: 3,
        status: "PROJECTED",
        amount: "44.00",
      }),
      expect.objectContaining({
        period: 4,
        status: "PROJECTED",
        amount: "44.00",
      }),
    ]);
    expect(v.missing).toEqual([
      { benchmarkId: CPI, observation: "2027-08", publisher: "GUS" },
    ]);
  });

  it("a compounding maturity that cannot be worked out is an UNKNOWN PRINCIPAL flow", () => {
    const v = edo("2026-10-01", "2027-10-16", {
      benchmarks: cpi(["2026-08", "0.0290"]),
    });
    expect(v.maturityValueKnown).toBeNull();
    expect(v.maturityValueProjected).toBeNull();
    expect(v.projectedCashflows).toEqual([
      {
        date: "2036-10-01",
        type: "PRINCIPAL",
        amount: null,
        status: "UNKNOWN",
        period: 10,
      },
    ]);
  });

  it("names a benchmark with neither an observation nor an assumption in projectionMissing", () => {
    const v = edo("2026-10-01", "2026-10-10");
    expect(v.projectionMissing).toEqual([
      { benchmarkId: CPI, publisher: null },
    ]);
    expect(v.valuationComplete).toBe(true);
    const withData = edo("2026-10-01", "2026-10-10", {
      benchmarks: cpi(["2026-08", "0.0290"]),
    });
    expect(withData.projectionMissing).toEqual([]);
    expect(withData.valuationComplete).toBe(true);
    const publisher = edo("2026-10-01", "2026-10-10", { benchmarks: cpi() });
    expect(publisher.projectionMissing).toEqual([
      { benchmarkId: CPI, publisher: "GUS" },
    ]);
  });

  it("a completed period with a missing observation is named in missing (coupon bond)", () => {
    const v = valueBondLot(
      lotInput("coi1030", "2026-10-15", "2028-10-20", {
        benchmarks: cpi(["2028-08", "0.0300"]),
      }),
    );
    expect(v.grossValue).not.toBeNull();
    expect(v.missing).toEqual([
      { benchmarkId: CPI, observation: "2027-08", publisher: "GUS" },
    ]);
    expect(v.valuationComplete).toBe(false);
  });
});

describe("valueBondLot: boundaries pinned (audit idx 85 and 86)", () => {
  it("a period that starts on asOf has started: its missing observation is named", () => {
    const v = edo("2026-10-01", "2027-10-01", {
      benchmarks: cpi(["2026-08", "0.0290"]),
    });
    expect(v.currentPeriod).toEqual({
      index: 2,
      start: "2027-10-01",
      end: "2028-10-01",
      annualRate: null,
      rateSource: null,
    });
    expect(v.missing).toEqual([
      { benchmarkId: CPI, observation: "2027-08", publisher: "GUS" },
    ]);
    expect(v.valuationComplete).toBe(false);
    expect(v.grossValue).toBeNull();
    // The day before, period 2 has not started: projected, nothing missing.
    const before = edo("2026-10-01", "2027-09-30", {
      benchmarks: cpi(["2026-08", "0.0290"]),
    });
    expect(before.missing).toEqual([]);
    expect(before.grossValue).not.toBeNull();
  });

  it("a compounding maturity with one projected period stays projected even when the last period is announced", () => {
    // r3..r10 announced at 4.90%, period 2 (not started) projected from the
    // newest CPI (2.90% + 2.00% margin = 4.90%): 100 * 1.0535 * 1.049^9 = 162.04
    // (python fractions, rounded half up).
    const announced = new Map<number, string>(
      [3, 4, 5, 6, 7, 8, 9, 10].map((k) => [k, "0.0490"]),
    );
    const v = edo("2026-10-01", "2026-10-10", {
      benchmarks: cpi(["2026-07", "0.0310"], ["2026-08", "0.0290"]),
      announcedRates: announced,
    });
    expect(v.rateSchedule[1].rateSource).toBe("PROJECTED");
    expect(v.rateSchedule[9].rateSource).toBe("ANNOUNCED");
    expect(v.maturityValueKnown).toBeNull();
    expect(v.maturityValueProjected).toBe("162.04");
    expect(v.projectedCashflows).toEqual([
      {
        date: "2036-10-01",
        type: "PRINCIPAL",
        amount: "162.04",
        status: "PROJECTED",
        period: 10,
      },
    ]);
    expect(v.knownCashflows).toEqual([]);
  });
});
