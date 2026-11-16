import { addDaysYMD } from "@/common/date-utils";
import { BenchmarkData } from "../domain/benchmark";
import { lotInput, ManifestName } from "../adapters/pl/pl-test-input";
import {
  BondEngineError,
  BondEngineInput,
  BondLotSeriesInput,
  grossValueSeries,
  valueBondLot,
  valueBondLotSeries,
} from "./bond-engine";

const CPI = "PL_CPI_GUS_YOY";
const NBP = "PL_NBP_REFERENCE";

const cpi = (...entries: [string, string][]) =>
  new Map<string, BenchmarkData>([
    [CPI, { kind: "MONTHLY", publisher: "GUS", values: new Map(entries) }],
  ]);

const nbp = (coveredThrough: string, ...changes: [string, string][]) =>
  new Map<string, BenchmarkData>([
    [
      NBP,
      {
        kind: "STEP",
        publisher: "NBP",
        changes: changes.map(([effectiveFrom, value]) => ({
          effectiveFrom,
          value,
        })),
        coveredThrough,
      },
    ],
  ]);

function daysFrom(start: string, count: number, step = 1): string[] {
  return Array.from({ length: count }, (_u, i) => addDaysYMD(start, i * step));
}

function seriesInput(
  name: ManifestName,
  purchase: string,
  days: string[],
  overrides: Partial<BondEngineInput> = {},
): BondLotSeriesInput {
  const { asOf: _asOf, ...rest } = lotInput(name, purchase, purchase, {
    lot: { purchaseDate: purchase, quantity: 7 },
    ...overrides,
  });
  return { ...rest, days };
}

/** The series API against the single-day API: the same figures, day by day. */
function expectEquivalent(input: BondLotSeriesInput) {
  const { days, ...rest } = input;
  const series = valueBondLotSeries(input);
  const gross = grossValueSeries(input);
  expect(series).toHaveLength(days.length);
  days.forEach((day, i) => {
    const single = valueBondLot({ ...rest, asOf: day });
    expect(series[i]).toEqual(single);
    expect(gross[i]).toEqual({
      asOf: day,
      status: single.status,
      grossValue: single.grossValue,
    });
  });
}

describe("valueBondLotSeries and grossValueSeries equal valueBondLot on every day", () => {
  it("EDO over its whole life with some months stored, some announced, some missing", () => {
    const purchase = "2026-10-01";
    // Every 5th day plus both sides of each period boundary, 10+ years.
    const boundaries = Array.from(
      { length: 11 },
      (_u, k) => `${2026 + k}-10-01`,
    )
      .flatMap((d) => [addDaysYMD(d, -1), d, addDaysYMD(d, 1)])
      .filter((d) => d >= purchase);
    const days = [...new Set([...daysFrom(purchase, 740, 5), ...boundaries])];
    expectEquivalent(
      seriesInput("edo1036", purchase, days, {
        // 2027-08 and 2029-08 stored, 2028-08 missing: a hole in the middle.
        benchmarks: cpi(["2027-08", "0.0310"], ["2029-08", "0.0250"]),
        announcedRates: new Map([[5, "0.0480"]]),
      }),
    );
  });

  it("EDO with no data at all and with a supplied projection", () => {
    const purchase = "2026-10-15";
    const days = daysFrom(purchase, 120, 31);
    expectEquivalent(seriesInput("edo1036", purchase, days));
    expectEquivalent(
      seriesInput("edo1036", purchase, days, {
        projection: new Map([[CPI, "0.0300"]]),
      }),
    );
  });

  it("ROR over its year, with an NBP series that stops being covered", () => {
    const purchase = "2026-10-31";
    expectEquivalent(
      seriesInput("ror1027", purchase, daysFrom(purchase, 400), {
        benchmarks: nbp(
          "2027-03-15",
          ["2026-09-01", "0.0450"],
          ["2026-12-10", "0.0425"],
          ["2027-02-05", "0.0400"],
        ),
      }),
    );
  });

  it("COI over its four years with CPI stored for only one of the periods", () => {
    const purchase = "2026-10-15";
    expectEquivalent(
      seriesInput("coi1030", purchase, daysFrom(purchase, 1500, 3), {
        benchmarks: cpi(["2028-08", "0.0400"]),
        projection: new Map([[CPI, "0.0250"]]),
      }),
    );
  });

  it("a lot bought outside the sale window is refused on every day", () => {
    const purchase = "2026-11-15";
    const input = seriesInput("edo1036", purchase, daysFrom(purchase, 5));
    expectEquivalent(input);
    expect(grossValueSeries(input).map((p) => p.status)).toEqual(
      Array(5).fill("REFUSED"),
    );
  });

  it("keeps the order of the days it is given, repeats and gaps included", () => {
    const input = seriesInput("edo1036", "2026-10-01", [
      "2027-10-01",
      "2026-10-05",
      "2027-10-01",
      "2026-10-01",
    ]);
    expect(grossValueSeries(input).map((p) => p.asOf)).toEqual(input.days);
    expectEquivalent(input);
  });

  it("an empty list of days gives an empty series", () => {
    expect(
      valueBondLotSeries(seriesInput("edo1036", "2026-10-01", [])),
    ).toEqual([]);
  });

  it("rejects the same inputs valueBondLot rejects", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as BondEngineError).code;
      }
      return null;
    };
    const base = (days: string[], quantity = 1) =>
      seriesInput("edo1036", "2026-10-01", days, {
        lot: { purchaseDate: "2026-10-01", quantity },
      });
    expect(code(() => grossValueSeries(base(["2026-09-30"])))).toBe(
      "AS_OF_BEFORE_PURCHASE",
    );
    expect(code(() => grossValueSeries(base(["2026-02-30"])))).toBe(
      "DATE_INVALID",
    );
    expect(code(() => valueBondLotSeries(base(["2026-10-01"], 0)))).toBe(
      "QUANTITY_INVALID",
    );
  });
});

describe("series performance", () => {
  it("values a 10-year EDO lot over ~3650 days well inside the bound", () => {
    const purchase = "2026-10-01";
    const days = daysFrom(purchase, 3650);
    const input = seriesInput("edo1036", purchase, days, {
      benchmarks: cpi(["2027-08", "0.0310"], ["2028-08", "0.0290"]),
      projection: new Map([[CPI, "0.0300"]]),
    });
    const started = Date.now();
    const gross = grossValueSeries(input);
    const full = valueBondLotSeries(input);
    const elapsed = Date.now() - started;
    expect(gross).toHaveLength(3650);
    expect(full).toHaveLength(3650);
    // A regression to per-day schedule and rate resolution takes tens of seconds.
    expect(elapsed).toBeLessThan(1500);
  });
});
