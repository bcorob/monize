import { BenchmarkData } from "../domain/benchmark";
import { lotInput } from "../adapters/pl/pl-test-input";
import { valueBondLot } from "./bond-engine";
import { BondEngineInput } from "./bond-engine-types";

const NBP = "PL_NBP_REFERENCE";

const nbp: ReadonlyMap<string, BenchmarkData> = new Map([
  [
    NBP,
    {
      kind: "STEP",
      publisher: "NBP",
      changes: [{ effectiveFrom: "2020-01-01", value: "0.0400" }],
      coveredThrough: "2030-01-01",
    },
  ],
]);

const ror = (asOf: string, overrides: Partial<BondEngineInput> = {}) =>
  valueBondLot(lotInput("ror1027", "2026-10-31", asOf, overrides));
const edo = (asOf: string, overrides: Partial<BondEngineInput> = {}) =>
  valueBondLot(lotInput("edo1036", "2026-10-01", asOf, overrides));
const tos = (asOf: string) =>
  valueBondLot(lotInput("tos1029", "2026-10-15", asOf));

describe("valueBondLot: nextPayment", () => {
  it("a coupon bond's next payment is the coming coupon, alone", () => {
    const v = ror("2026-11-05", { benchmarks: nbp });
    const coming = v.knownCashflows
      .concat(v.projectedCashflows)
      .filter((c) => c.period === 1);
    expect(coming).toHaveLength(1);
    expect(coming[0].type).toBe("INTEREST");
    expect(v.nextPayment).toEqual(coming);
  });

  it("a coupon on the day asOf is already paid; the next one follows", () => {
    const first = ror("2026-11-05", { benchmarks: nbp }).nextPayment[0];
    const v = ror(first.date, { benchmarks: nbp });
    expect(v.nextPayment).toHaveLength(1);
    expect(v.nextPayment[0].period).toBe(2);
    expect(v.nextPayment[0].date > first.date).toBe(true);
  });

  it("on the last period the coupon and the principal fall on one date", () => {
    const v = ror("2027-10-15", { benchmarks: nbp });
    expect(v.nextPayment.map((c) => c.type).sort()).toEqual([
      "INTEREST",
      "PRINCIPAL",
    ]);
    expect(new Set(v.nextPayment.map((c) => c.date)).size).toBe(1);
  });

  it("a compounding bond pays only at maturity", () => {
    const v = edo("2026-10-20");
    expect(v.nextPayment).toHaveLength(1);
    expect(v.nextPayment[0]).toMatchObject({
      date: v.maturityDate,
      type: "PRINCIPAL",
    });
    expect(v.nextPayment).toEqual(
      v.knownCashflows.concat(v.projectedCashflows),
    );
  });

  it("an UNKNOWN flow is listed with a null amount", () => {
    const v = edo("2026-10-20");
    expect(v.nextPayment).toEqual([
      expect.objectContaining({ status: "UNKNOWN", amount: null }),
    ]);
  });

  it("is empty for a matured lot", () => {
    const v = ror("2027-10-31", { benchmarks: nbp });
    expect(v.status).toBe("MATURED");
    expect(v.nextPayment).toEqual([]);
  });

  it("is empty for a refused lot", () => {
    const v = valueBondLot(lotInput("tos1029", "2020-01-01", "2020-01-02"));
    expect(v.status).toBe("REFUSED");
    expect(v.nextPayment).toEqual([]);
    expect(v.nextRateReset).toBeNull();
    expect(v.nextCapitalization).toBeNull();
  });
});

describe("valueBondLot: nextRateReset", () => {
  it("is null for a fixed rate", () => {
    expect(tos("2026-10-20").nextRateReset).toBeNull();
  });

  it("is the start of the next period for a benchmark rate", () => {
    const v = ror("2026-11-05", { benchmarks: nbp });
    expect(v.currentPeriod?.index).toBe(1);
    expect(v.nextRateReset).toBe(v.rateSchedule[1].start);
    expect(v.nextRateReset).toBe(v.currentPeriod?.end);
  });

  it("is null in the last period", () => {
    const v = ror("2027-10-15", { benchmarks: nbp });
    expect(v.currentPeriod?.index).toBe(12);
    expect(v.nextRateReset).toBeNull();
  });

  it("is null once matured", () => {
    expect(ror("2027-10-31", { benchmarks: nbp }).nextRateReset).toBeNull();
  });
});

describe("valueBondLot: nextCapitalization", () => {
  it("is the end of the current period for a compounding bond", () => {
    const v = edo("2026-10-20");
    expect(v.nextCapitalization).toBe(v.currentPeriod?.end);
    expect(v.nextCapitalization).toBe("2027-10-01");
  });

  it("is null in the last period of a compounding bond", () => {
    const v = edo("2036-09-30");
    expect(v.currentPeriod?.index).toBe(10);
    expect(v.nextCapitalization).toBeNull();
  });

  it("is null for a coupon bond and once matured", () => {
    expect(
      ror("2026-11-05", { benchmarks: nbp }).nextCapitalization,
    ).toBeNull();
    expect(edo("2036-10-01").nextCapitalization).toBeNull();
  });
});
