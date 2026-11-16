import type { ReceiptLinkReport } from "../parsing/receipt-parser.types";
import {
  linkRowsOf,
  removeLinkRows,
  replaceLinkRows,
  unitsToDecimal,
} from "./link-rows";

const report = (over: Partial<ReceiptLinkReport>): ReceiptLinkReport => ({
  partIndex: 0,
  link: "L1",
  partAmount: 1098900,
  outcome: "not_found",
  componentReceiptId: null,
  ...over,
});

describe("linkRowsOf", () => {
  it("names the component only for a joined or scaled part", () => {
    const rows = linkRowsOf([
      report({ partIndex: 0, outcome: "joined", componentReceiptId: "c1" }),
      report({ partIndex: 1, outcome: "scaled", componentReceiptId: "c2" }),
      report({
        partIndex: 2,
        outcome: "amount_exceeds",
        componentReceiptId: "c3",
      }),
      report({
        partIndex: 3,
        outcome: "component_used",
        componentReceiptId: "c4",
      }),
      report({
        partIndex: 4,
        outcome: "component_incomplete",
        componentReceiptId: "c5",
      }),
      report({ partIndex: 5, link: null, outcome: "no_link" }),
    ]);
    expect(rows.map((r) => r.componentReceiptId)).toEqual([
      "c1",
      "c2",
      null,
      null,
      null,
      null,
    ]);
    expect(rows[5]).toEqual({
      partIndex: 5,
      link: null,
      partAmount: 1098900,
      componentReceiptId: null,
      outcome: "no_link",
    });
  });
});

describe("unitsToDecimal", () => {
  it("writes integer units as an exact decimal string", () => {
    expect(unitsToDecimal(1098900)).toBe("109.8900");
    expect(unitsToDecimal(1)).toBe("0.0001");
    expect(unitsToDecimal(0)).toBe("0.0000");
    expect(unitsToDecimal(123456789012)).toBe("12345678.9012");
  });
});

describe("replaceLinkRows", () => {
  it("deletes the settlement's rows, then inserts all of them in one statement", async () => {
    const query = jest.fn(async () => []);
    await replaceLinkRows({ query } as never, "u1", "s1", [
      {
        partIndex: 0,
        link: "L1",
        partAmount: 1098900,
        componentReceiptId: null,
        outcome: "not_found",
      },
      {
        partIndex: 1,
        link: null,
        partAmount: 5,
        componentReceiptId: null,
        outcome: "no_link",
      },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("DELETE FROM email_receipt_links"),
      [["s1"], "u1"],
    ]);
    const [sql, values] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(sql).toContain("INSERT INTO email_receipt_links");
    expect(values).toEqual([
      "u1",
      "s1",
      0,
      "L1",
      "109.8900",
      null,
      "not_found",
      1,
      null,
      "0.0005",
      null,
      "no_link",
    ]);
  });

  it("only deletes when there are no rows to write", async () => {
    const query = jest.fn(async () => []);
    await replaceLinkRows({ query } as never, "u1", "s1", undefined);
    await replaceLinkRows({ query } as never, "u1", "s1", []);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("resets the components the old rows named once the new rows are written", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { component_receipt_id: "c1" },
        { component_receipt_id: "c1" },
        { component_receipt_id: null },
        { component_receipt_id: "c2" },
      ])
      .mockResolvedValue([]);
    await replaceLinkRows({ query } as never, "u1", "s1", [
      {
        partIndex: 0,
        link: "L1",
        partAmount: 1,
        componentReceiptId: "c2",
        outcome: "joined",
      },
    ]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toContain("INSERT INTO email_receipt_links");
    const [sql, values] = query.mock.calls[2] as [string, unknown[]];
    expect(sql).toContain("status = 'component'");
    expect(sql).toContain("NOT EXISTS");
    expect(values).toEqual(["u1", ["c1", "c2"], "awaiting_settlement"]);
  });
});

describe("removeLinkRows", () => {
  it("deletes the rows of every settlement, then resets the components that lost their last row", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ component_receipt_id: "c1" }])
      .mockResolvedValue([]);
    await removeLinkRows({ query } as never, "u1", ["s1", "s2"]);
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("RETURNING component_receipt_id"),
      [["s1", "s2"], "u1"],
    ]);
    expect(query.mock.calls[1][1]).toEqual([
      "u1",
      ["c1"],
      "awaiting_settlement",
    ]);
  });

  it("resets nothing when the rows named no component", async () => {
    const query = jest.fn(async () => []);
    await removeLinkRows({ query } as never, "u1", ["s1"]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
