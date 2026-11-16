import { BenchmarkData } from "../../domain/benchmark";
import { redemptionSplit } from "../../engine/bond-engine";
import edo0423Cases from "./edo0423-cases.json";
import {
  FixtureName,
  fixtureLotInput,
  lotInput,
  ManifestName,
} from "./pl-test-input";
import cases from "./redemption-split-cases.json";

interface SplitCase {
  id: string;
  description: string;
  source?: string;
  hypothetical?: boolean;
  terms?: string;
  manifest?: string;
  /** The id of an edo0423 valuation case whose CPI observations the case reads. */
  benchmarksFrom?: string;
  announcedRates?: Record<string, string>;
  lot: { purchaseDate: string; quantity: number };
  date: string;
  expect: Record<string, unknown>;
  perBond?: Record<string, unknown>;
}

/** The monthly observations of an edo0423 valuation case (real GUS data, source in the file). */
function benchmarksFrom(id: string): Map<string, BenchmarkData> {
  const source = edo0423Cases.cases.find((c) => c.id === id);
  if (!source) throw new Error(`no edo0423 case ${id}`);
  return new Map(
    Object.entries(source.benchmarks).map(([key, b]) => [
      key,
      {
        kind: "MONTHLY",
        publisher: b.publisher,
        values: new Map(Object.entries(b.values)),
      },
    ]),
  );
}

function splitOf(c: SplitCase) {
  const overrides = {
    lot: c.lot,
    announcedRates: new Map(
      Object.entries(c.announcedRates ?? {}).map(([k, v]) => [Number(k), v]),
    ),
    ...(c.benchmarksFrom
      ? { benchmarks: benchmarksFrom(c.benchmarksFrom) }
      : {}),
  };
  const { asOf: _asOf, ...input } = c.terms
    ? fixtureLotInput(
        c.terms as FixtureName,
        c.lot.purchaseDate,
        c.date,
        overrides,
      )
    : lotInput(
        c.manifest as ManifestName,
        c.lot.purchaseDate,
        c.date,
        overrides,
      );
  return redemptionSplit(input, c.date);
}

// Expected figures are worked by hand from the stored terms, see the notes of
// redemption-split-cases.json; never from the engine's output (INV-BOND-009).
describe("golden redemption splits", () => {
  const all = cases.cases as SplitCase[];

  it.each(all)("$id: $description", (c) => {
    const split = splitOf(c);
    expect(split).toMatchObject(c.expect);
    if (c.perBond) expect(split.perBond).toEqual(c.perBond);
    expect(split.date).toBe(c.date);
    expect(split.quantity).toBe(c.lot.quantity);
  });

  it("every case asserts figures", () => {
    for (const c of all) {
      expect({ id: c.id, asserted: Object.keys(c.expect).length > 0 }).toEqual({
        id: c.id,
        asserted: true,
      });
    }
  });

  it("the Ministry's EDO0423 maturity value is the payout", () => {
    const maturity = edo0423Cases.cases.find((c) => c.id === "EDO0423-OFF-M");
    expect(maturity?.expect.grossValue).toBe("147.05");
    expect(splitOf(all[0]).payout).toBe(maturity?.expect.grossValue);
  });
});
