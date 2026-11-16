import {
  FIXTURE_CATALOG,
  manifestDocument,
  polishCalendars,
} from "./adapters/pl/pl-test-input";
import { CatalogEntry } from "./bond-adapter";
import { BenchmarkData } from "./domain/benchmark";
import { BondTerms, parseBondTerms } from "./domain/bond-terms";
import { BondValuation, valueBondLot } from "./engine/bond-engine";

/**
 * Historical stability: what a lot of an existing series is worth never depends
 * on which other series the catalog holds. A series is valued from its own
 * terms document and the shared reference observations, so a later series of
 * the same product (another margin, another first rate) changes nothing about
 * the series already issued. A lookup that matched on the program code, or a
 * shared mutable default, would break this.
 */

const CPI = "PL_CPI_GUS_YOY";
const NBP = "PL_NBP_REFERENCE";

/** Hypothetical later series: same products, other first rate and margin or spread. */
function laterSeries(): CatalogEntry[] {
  const edo = manifestDocument("edo1036");
  edo.instrument.seriesCode = "EDO1136";
  edo.saleWindow = { from: "2026-11-01", to: "2026-11-30" };
  edo.rateRule.firstPeriodRate = "0.0510";
  edo.rateRule.margin = "0.0275";
  const ror = manifestDocument("ror1027");
  ror.instrument.seriesCode = "ROR1127";
  ror.saleWindow = { from: "2026-11-01", to: "2026-11-30" };
  ror.rateRule.firstPeriodRate = "0.0375";
  ror.rateRule.spread = "0.0010";
  return [edo, ror].map((terms) => ({
    termsVersion: 1,
    publishedAt: "2026-10-26",
    terms,
  }));
}

const BASELINE: readonly CatalogEntry[] = FIXTURE_CATALOG;
const EXTENDED: readonly CatalogEntry[] = [...BASELINE, ...laterSeries()];

function termsOf(
  catalog: readonly CatalogEntry[],
  seriesCode: string,
): { terms: BondTerms; termsVersion: number } {
  const matches = catalog
    .map((entry) => ({
      terms: parseBondTerms(entry.terms),
      termsVersion: entry.termsVersion,
    }))
    .filter((entry) => entry.terms.instrument.seriesCode === seriesCode);
  expect(matches).toHaveLength(1);
  return matches[0];
}

// Hypothetical reference data, shared by both catalogs.
const BENCHMARKS = new Map<string, BenchmarkData>([
  [
    CPI,
    {
      kind: "MONTHLY",
      publisher: "GUS",
      values: new Map([
        ["2027-07", "0.0100"],
        ["2027-08", "0.0340"],
        ["2027-09", "0.0900"],
      ]),
    },
  ],
  [
    NBP,
    {
      kind: "STEP",
      publisher: "NBP",
      coveredThrough: "2026-12-31",
      changes: [
        { effectiveFrom: "2026-03-05", value: "0.0375" },
        { effectiveFrom: "2026-10-15", value: "0.0350" },
      ],
    },
  ],
]);

const LOTS: Record<string, { purchaseDates: string[]; asOfs: string[] }> = {
  EDO1036: {
    purchaseDates: ["2026-10-01", "2026-10-15", "2026-10-31"],
    asOfs: ["2026-11-02", "2027-04-01", "2027-11-02", "2028-04-01"],
  },
  ROR1027: {
    purchaseDates: ["2026-10-01", "2026-10-31"],
    asOfs: ["2026-11-02", "2026-11-15", "2026-12-10", "2027-01-15"],
  },
};

function valueAll(catalog: readonly CatalogEntry[]) {
  const valuations = new Map<string, BondValuation>();
  for (const [seriesCode, { purchaseDates, asOfs }] of Object.entries(LOTS)) {
    const { terms, termsVersion } = termsOf(catalog, seriesCode);
    for (const purchaseDate of purchaseDates) {
      for (const asOf of asOfs) {
        for (const quantity of [1, 25]) {
          valuations.set(
            [seriesCode, purchaseDate, asOf, quantity].join("|"),
            valueBondLot({
              terms,
              termsVersion,
              announcedRates: new Map(),
              benchmarks: BENCHMARKS,
              calendars: polishCalendars,
              lot: { purchaseDate, quantity },
              asOf,
            }),
          );
        }
      }
    }
  }
  return valuations;
}

describe("catalog stability: a later series changes no figure of an earlier one", () => {
  it("the extra series are real, distinct catalog entries", () => {
    const codes = EXTENDED.map(
      (entry) => parseBondTerms(entry.terms).instrument.seriesCode,
    );
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(expect.arrayContaining(["EDO1136", "ROR1127"]));
    expect(EXTENDED).toHaveLength(BASELINE.length + 2);
  });

  it("every figure of every EDO1036 and ROR1027 lot is identical", () => {
    const before = valueAll(BASELINE);
    const after = valueAll(EXTENDED);
    expect(before.size).toBe(3 * 4 * 2 + 2 * 4 * 2);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [key, valuation] of before) {
      expect({ key, valuation: after.get(key) }).toEqual({ key, valuation });
    }
  });

  it("the stable figures are real figures: independently computed anchors", () => {
    const before = valueAll(EXTENDED);
    // EDO1036 period 1, a = 182, ACT = 365: 100 (1 + 0.0535 x 182 / 365) = 102.67
    expect(before.get("EDO1036|2026-10-01|2027-04-01|1")).toMatchObject({
      accruedInterest: "2.67",
      currentPeriod: { index: 1, annualRate: "0.0535", rateSource: "TERMS" },
    });
    // Period 2 is derived: CPI of 2027-08 (3.40%) + 2.00% = 5.40%, on the base
    // 105.35: round(105.35 (1 + 0.054 x 183 / 366)) = 108.19
    expect(before.get("EDO1036|2026-10-01|2028-04-01|1")).toMatchObject({
      accruedInterest: "8.19",
      currentPeriod: { index: 2, annualRate: "0.0540", rateSource: "DERIVED" },
    });
    // ROR1027 period 1, a = 15, D = 30: 100 x 0.04 x 15 / 360 = 0.17
    expect(before.get("ROR1027|2026-10-31|2026-11-15|1")).toMatchObject({
      accruedInterest: "0.17",
    });
    // Period 2 reads the NBP rate in force on 2026-10-19 (3.50%), a = 10, D = 31:
    // 100 x 0.035 x 10 / 372 = 0.09
    expect(before.get("ROR1027|2026-10-31|2026-12-10|1")).toMatchObject({
      accruedInterest: "0.09",
      currentPeriod: { index: 2, annualRate: "0.0350", rateSource: "DERIVED" },
    });
  });

  it("the later series values differently, so a leak would show", () => {
    const later = termsOf(EXTENDED, "EDO1136");
    const valuation = valueBondLot({
      terms: later.terms,
      termsVersion: later.termsVersion,
      announcedRates: new Map(),
      benchmarks: BENCHMARKS,
      calendars: polishCalendars,
      lot: { purchaseDate: "2026-11-02", quantity: 1 },
      asOf: "2027-05-03",
    });
    // 100 (1 + 0.0510 x 182 / 365) = 102.54: not the 5.35% of EDO1036
    expect(valuation).toMatchObject({
      accruedInterest: "2.54",
      currentPeriod: { annualRate: "0.0510", rateSource: "TERMS" },
    });
  });
});
