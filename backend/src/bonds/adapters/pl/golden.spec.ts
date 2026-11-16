import { BenchmarkData } from "../../domain/benchmark";
import { valueBondLot } from "../../engine/bond-engine";
import coiCases from "./coi-cases.json";
import dorCases from "./dor-cases.json";
import edo0423Cases from "./edo0423-cases.json";
import edo0524Cases from "./edo0524-cases.json";
import edoCases from "./edo-cases.json";
import {
  FixtureName,
  fixtureLotInput,
  lotInput,
  ManifestName,
} from "./pl-test-input";
import otsCases from "./ots-cases.json";
import rodCases from "./rod-cases.json";
import ror0623Cases from "./ror0623-cases.json";
import rorCases from "./ror-cases.json";
import rosCases from "./ros-cases.json";
import tosCases from "./tos-cases.json";

/** Reference observations a case carries instead of (or beside) announced rates. */
type GoldenBenchmark =
  | {
      kind: "STEP";
      publisher: string;
      source: string;
      hypothetical?: boolean;
      coveredThrough: string;
      changes: { effectiveFrom: string; value: string }[];
    }
  | {
      kind: "MONTHLY";
      publisher: string;
      source: string;
      hypothetical?: boolean;
      values: Record<string, string>;
    };

interface GoldenCase {
  id: string;
  description: string;
  /** The page or document the expected figures are copied from, when official. */
  source?: string;
  hypothetical?: boolean;
  lot: { purchaseDate: string; quantity: number };
  asOf: string;
  announcedRates?: Record<string, string>;
  benchmarks?: Record<string, GoldenBenchmark>;
  /**
   * Any figure of the valuation, e.g. `accruedInterest` and
   * `currentPeriod: { index, annualRate, rateSource }`.
   */
  expect: Record<string, unknown>;
  /** Entries of `rateSchedule` by period number: rate, source, addend, observation. */
  expectedRates?: Record<string, Record<string, unknown>>;
  knownCashflows?: Record<string, unknown>[];
}

/** A catalog series (`manifest`) or a historical fixture series (`terms`). */
interface GoldenFile {
  manifest?: string;
  terms?: string;
  cases: GoldenCase[];
}

function benchmarksOf(c: GoldenCase): Map<string, BenchmarkData> {
  const result = new Map<string, BenchmarkData>();
  for (const [id, b] of Object.entries(c.benchmarks ?? {})) {
    result.set(
      id,
      b.kind === "STEP"
        ? {
            kind: "STEP",
            publisher: b.publisher,
            changes: b.changes,
            coveredThrough: b.coveredThrough,
          }
        : {
            kind: "MONTHLY",
            publisher: b.publisher,
            values: new Map(Object.entries(b.values)),
          },
    );
  }
  return result;
}

function valueCase(file: GoldenFile, c: GoldenCase) {
  const overrides = {
    lot: c.lot,
    announcedRates: new Map(
      Object.entries(c.announcedRates ?? {}).map(([k, v]) => [Number(k), v]),
    ),
    benchmarks: benchmarksOf(c),
  };
  return valueBondLot(
    file.terms
      ? fixtureLotInput(
          file.terms as FixtureName,
          c.lot.purchaseDate,
          c.asOf,
          overrides,
        )
      : lotInput(
          file.manifest as ManifestName,
          c.lot.purchaseDate,
          c.asOf,
          overrides,
        ),
  );
}

const FILES = [
  tosCases,
  edoCases,
  coiCases,
  rorCases,
  dorCases,
  rosCases,
  rodCases,
  otsCases,
  ror0623Cases,
  edo0524Cases,
  edo0423Cases,
] as GoldenFile[];

// Never from the engine's output. E1 to E16 (TOS, ROR, COI, EDO) are copied from
// spec section 5; the OTS, DOR, ROS and ROD fixtures were computed independently
// from their issue letters (nr 94, 96, 100 and 101/2026), and section 5 rows E17
// to E22 summarize them. The accrued-interest and rate expectations were computed
// with exact fractions from the letter formulas (spec 2.4). The cases whose
// `source` is a obligacjeskarbowe.pl page or interest table, and the derived
// ROR0623, EDO0524 and EDO0423 cases, reproduce published figures and real NBP
// and GUS observations; a `hypothetical` case says its inputs are invented.
describe.each(FILES)("golden cases for $manifest$terms", (file) => {
  it.each(file.cases)("$id: $description", (c) => {
    const valuation = valueCase(file, c);
    expect(valuation).toMatchObject(c.expect);
    for (const [period, want] of Object.entries(c.expectedRates ?? {})) {
      const entry = valuation.rateSchedule.find(
        (e) => e.index === Number(period),
      );
      expect(entry).toBeDefined();
      expect(entry).toMatchObject(want);
    }
    for (const flow of c.knownCashflows ?? []) {
      expect(valuation.knownCashflows).toContainEqual(flow);
    }
  });
});

describe("golden case files", () => {
  const catalogFiles = FILES.filter((f) => f.manifest);

  it("every case asserts at least one figure", () => {
    for (const file of FILES) {
      for (const c of file.cases) {
        const asserted =
          Object.keys(c.expect).length +
          Object.keys(c.expectedRates ?? {}).length +
          (c.knownCashflows ?? []).length;
        expect({ id: c.id, asserted: asserted > 0 }).toEqual({
          id: c.id,
          asserted: true,
        });
      }
    }
  });

  it("every product pins its accrued interest and rate mid-period", () => {
    for (const file of catalogFiles) {
      const pinned = file.cases.filter((c) => {
        const period = c.expect.currentPeriod as
          { annualRate?: string } | undefined;
        return (
          typeof c.expect.accruedInterest === "string" &&
          typeof period?.annualRate === "string"
        );
      });
      expect({ manifest: file.manifest, pinned: pinned.length > 0 }).toEqual({
        manifest: file.manifest,
        pinned: true,
      });
    }
  });

  it("a case that reads benchmark observations names where they come from", () => {
    for (const file of FILES) {
      for (const c of file.cases) {
        for (const b of Object.values(c.benchmarks ?? {})) {
          expect({ id: c.id, sourced: b.source.length > 0 }).toEqual({
            id: c.id,
            sourced: true,
          });
        }
      }
    }
  });

  it("the catalog products with a derived rate have a derived case", () => {
    const derived = (name: string) =>
      FILES.find((f) => f.manifest === name)?.cases.some(
        (c) =>
          c.expect.currentPeriod &&
          (c.expect.currentPeriod as { rateSource?: string }).rateSource ===
            "DERIVED",
      );
    expect(["ror1027", "dor1028", "coi1030", "edo1036"].map(derived)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});
