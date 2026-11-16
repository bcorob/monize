import { lotInput } from "./adapters/pl/pl-test-input";
import { BenchmarkData } from "./domain/benchmark";
import { ExactDecimal } from "./domain/exact-decimal";
import { scenarioOf } from "./bond-scenarios";
import { BondEngineInput, valueBondLot } from "./engine/bond-engine";

const CPI = "PL_CPI_GUS_YOY";
const NBP = "PL_NBP_REFERENCE";

const cpi = (...entries: [string, string][]) =>
  new Map<string, BenchmarkData>([
    [CPI, { kind: "MONTHLY", publisher: "GUS", values: new Map(entries) }],
  ]);

function lot(
  name: "edo1036" | "ror1027",
  purchase: string,
  asOf: string,
  quantity: number,
  overrides: Partial<BondEngineInput> = {},
) {
  return valueBondLot(
    lotInput(name, purchase, asOf, {
      lot: { purchaseDate: purchase, quantity },
      ...overrides,
    }),
  );
}

const sum = (...figures: (string | null)[]) =>
  figures
    .reduce(
      (total, f) => total.add(ExactDecimal.parse(f as string)),
      ExactDecimal.ZERO,
    )
    .toFixed(2);

// Every expected value below was computed with Python fractions (exact
// rationals, half-up rounding), never with the engine.
describe("scenarioOf (spec 13.3)", () => {
  it("a coupon bond's interest is the coupons as paid, rounded per bond", () => {
    // ROR1027, 1000 bonds, scenario 5.75% for every month after the first (4.00%).
    // Coupon 100 * r / 12: 0.33 for month 1, 0.48 for each of the 11 others,
    // although the exact accrual is 0.3333 and 0.4792.
    const valuation = lot("ror1027", "2026-10-15", "2026-10-15", 1000, {
      projection: new Map([[NBP, "0.0575"]]),
    });
    const s = scenarioOf("0.0575", [valuation], 2);
    expect(s).toMatchObject({
      fixedInterest: "330.00",
      benchmarkInterest: "5270.83",
      addendInterest: "9.17",
      announcedInterest: "0.00",
      totalInterest: "5610.00",
      maturityValue: "100480.00",
    });
  });

  it("rounds each part once per lot, and the total is the sum of the rounded parts", () => {
    // EDO1036, 10 and 3 bonds, scenario 1.20%. Parts per lot (10 | 3):
    // fixed 53.50 | 16.05, benchmark 129.48 | 38.84, addend 215.80 | 64.74.
    // Rounding the total once for all 13 bonds would give 518.42 and rounding it
    // per bond 518.44; the rounded parts add to 518.41.
    const projection = new Map([[CPI, "0.0120"]]);
    const lots = [10, 3].map((q) =>
      lot("edo1036", "2026-10-01", "2026-10-01", q, { projection }),
    );
    const s = scenarioOf("0.0120", lots, 2);
    expect(s).toMatchObject({
      fixedInterest: "69.55",
      benchmarkInterest: "168.32",
      addendInterest: "280.54",
      announcedInterest: "0.00",
      totalInterest: "518.41",
    });
    expect(sum(s.fixedInterest, s.benchmarkInterest, s.addendInterest)).toBe(
      s.totalInterest,
    );
  });

  it.each([
    [1, "5.35", "4.54", "21.24", "31.13"],
    [7, "37.45", "31.77", "148.65", "217.87"],
  ])(
    "the parts of %i bonds with a derived period sum to the total (audit idx 36)",
    (quantity, fixed, benchmark, addend, total) => {
      // 2027-08 stored at 3.40% (period 2 = 5.40%), scenario 0.10% after it.
      const valuation = lot("edo1036", "2026-10-01", "2027-10-16", quantity, {
        benchmarks: cpi(["2027-08", "0.0340"]),
        projection: new Map([[CPI, "0.0010"]]),
      });
      const s = scenarioOf("0.0010", [valuation], 2);
      expect(s).toMatchObject({
        fixedInterest: fixed,
        benchmarkInterest: benchmark,
        addendInterest: addend,
        totalInterest: total,
      });
      expect(sum(s.fixedInterest, s.benchmarkInterest, s.addendInterest)).toBe(
        s.totalInterest,
      );
    },
  );

  it("every period's parts add exactly to its interest", () => {
    const valuation = lot("edo1036", "2026-10-01", "2027-10-16", 1, {
      benchmarks: cpi(["2027-08", "0.0340"]),
      projection: new Map([[CPI, "0.0010"]]),
    });
    for (const entry of valuation.rateSchedule) {
      const parts = ExactDecimal.parse(entry.fixedPart!)
        .add(ExactDecimal.parse(entry.benchmarkPart!))
        .add(ExactDecimal.parse(entry.addendPart!))
        .add(ExactDecimal.parse(entry.announcedPart!));
      expect(parts.toFixed(10)).toBe(entry.interest);
    }
  });

  it("is null for every figure when a lot has an unknown period", () => {
    const valuation = lot("edo1036", "2026-10-01", "2026-10-10", 1);
    expect(scenarioOf("0.0100", [valuation], 2)).toMatchObject({
      totalInterest: null,
      fixedInterest: null,
      benchmarkInterest: null,
      addendInterest: null,
      announcedInterest: null,
    });
  });
});
