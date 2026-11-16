import { EntityManager } from "typeorm";
import {
  EmbeddedSeriesCarry,
  readEmbeddedSeriesCarry,
  takeCarriedSeries,
} from "./embedded-series-carry";

const carry = (
  over: Partial<EmbeddedSeriesCarry> = {},
): EmbeddedSeriesCarry => ({
  securityId: "sec-1",
  action: "BUY",
  quantity: 10,
  transactionDate: "2026-10-15",
  bondInstrumentId: "series-1",
  ...over,
});

const incoming = (over: Record<string, unknown> = {}) => ({
  securityId: "sec-1",
  action: "BUY",
  quantity: 10,
  transactionDate: "2026-10-15",
  ...over,
});

describe("readEmbeddedSeriesCarry", () => {
  it("reads the parent's embedded rows with their series, in id order, scoped to the user", async () => {
    const query = jest.fn(async () => [
      {
        security_id: "sec-1",
        action: "BUY",
        quantity: "10.00000000",
        tx_date: "2026-10-15",
        bond_instrument_id: null,
      },
    ]);
    const rows = await readEmbeddedSeriesCarry(
      { query } as unknown as EntityManager,
      "user-1",
      "parent-1",
    );
    expect(rows).toEqual([
      {
        securityId: "sec-1",
        action: "BUY",
        quantity: 10,
        transactionDate: "2026-10-15",
        bondInstrumentId: null,
      },
    ]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("ORDER BY it.id");
    expect(sql).toContain("it.user_id = $2");
    expect(params).toEqual(["parent-1", "user-1"]);
  });
});

describe("takeCarriedSeries (the same split: security, action, quantity and date)", () => {
  it("returns and consumes the matching predecessor, NULL series included", () => {
    const pool = [carry({ bondInstrumentId: null })];
    expect(takeCarriedSeries(pool, incoming())).toEqual(
      carry({ bondInstrumentId: null }),
    );
    expect(pool).toEqual([]);
  });

  it("uses each predecessor once, in order, so look-alike rows pair deterministically", () => {
    const pool = [
      carry({ bondInstrumentId: "a" }),
      carry({ bondInstrumentId: "b" }),
    ];
    expect(takeCarriedSeries(pool, incoming())?.bondInstrumentId).toBe("a");
    expect(takeCarriedSeries(pool, incoming())?.bondInstrumentId).toBe("b");
    expect(takeCarriedSeries(pool, incoming())).toBeNull();
  });

  it.each([
    ["another security", { securityId: "sec-2" }],
    ["another action", { action: "SELL" }],
    ["another quantity", { quantity: 11 }],
    ["another date", { transactionDate: "2026-10-16" }],
  ])("does not match %s: a changed row is a new decision", (_name, over) => {
    const pool = [carry()];
    expect(takeCarriedSeries(pool, incoming(over))).toBeNull();
    expect(pool).toHaveLength(1);
  });

  it("compares a missing quantity as zero and cuts a date-time to its date", () => {
    expect(
      takeCarriedSeries(
        [carry({ quantity: 0 })],
        incoming({
          quantity: undefined,
          transactionDate: "2026-10-15T00:00:00Z",
        }),
      ),
    ).not.toBeNull();
  });
});
