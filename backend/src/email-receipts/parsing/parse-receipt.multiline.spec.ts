import { parseReceipt, parseReceiptTraced } from "./parse-receipt";
import { isPlainReceiptAmount } from "./receipt-amount";
import {
  capturePart,
  matchReceiptLines,
  matchReceiptPattern,
} from "./receipt-glob";
import { normalizeReceiptLines } from "./receipt-lines";
import { ReceiptParserDefinition } from "./receipt-parser.types";

/**
 * Multi-line patterns: parts joined by the two characters `\n`, each part a
 * whole-line glob, the parts matched against consecutive lines. The case that
 * asked for them: a receipt that prints the total between two other lines.
 */

const CAT = "33333333-3333-4333-8333-333333333333";
const always = (): boolean => true;
const plainAmount = (c: Readonly<Record<string, string>>): boolean =>
  c.amount !== undefined && isPlainReceiptAmount(c.amount);

const ANTHROPIC = [
  "Thanks for your purchase",
  "Receipt from Anthropic, PBC",
  "$333",
  "Paid",
  "October 16, 2026",
];

const parse = (d: ReceiptParserDefinition, lines: string[], subject = "") =>
  parseReceiptTraced(d, subject, lines.join("\n"), null);

describe("matchReceiptLines", () => {
  const lines = ["Receipt from Anthropic, PBC", "$333", "Paid", "Thanks"];

  it("matches the parts against consecutive lines and merges their captures", () => {
    expect(
      matchReceiptLines("Receipt from *\\n${amount}\\nPaid", lines, 0, always),
    ).toEqual({ captures: { amount: "333" }, span: 3 });
  });

  it("reads a one-line pattern at one line, as matchReceiptPattern does", () => {
    expect(matchReceiptLines("${amount}", lines, 1, always)).toEqual({
      captures: { amount: "333" },
      span: 1,
    });
    expect(matchReceiptLines("${amount}", lines, 0, always)).toBeNull();
  });

  it("needs every part on the line after the last: no gap, no reordering", () => {
    expect(
      matchReceiptLines("Receipt from *\\nPaid", lines, 0, always),
    ).toBeNull();
    expect(matchReceiptLines("Paid\\n${amount}", lines, 1, always)).toBeNull();
  });

  it("lets a part of only * stand for any one line", () => {
    expect(
      matchReceiptLines("Receipt from *\\n*\\nPaid", lines, 0, always),
    ).toEqual({ captures: {}, span: 3 });
  });

  it("does not run past the last line, or past `end`", () => {
    expect(matchReceiptLines("Paid\\nThanks\\n*", lines, 2, always)).toBeNull();
    expect(matchReceiptLines("Paid\\nThanks", lines, 2, always)).not.toBeNull();
    expect(matchReceiptLines("Paid\\nThanks", lines, 2, always, 3)).toBeNull();
  });

  it("tries a part's greedy reading when its lazy one is not accepted", () => {
    // Lazy: name "USB-C", amount "cable 19.98" (not an amount); greedy reads it.
    expect(
      matchReceiptLines(
        "Item\\n{name} {amount}",
        ["Item", "USB-C cable 19.98"],
        0,
        plainAmount,
      ),
    ).toEqual({ captures: { name: "USB-C cable", amount: "19.98" }, span: 2 });
  });

  it("gives accept the captures of every part together", () => {
    const seen: Record<string, string>[] = [];
    matchReceiptLines("{name}\\n{amount}", ["Pen", "1.00"], 0, (c) => {
      seen.push({ ...c });
      return false;
    });
    expect(seen).toContainEqual({ name: "Pen", amount: "1.00" });
  });
});

describe("a multi-line pattern against one text", () => {
  it("never matches: a subject, an item name or a payee is one line", () => {
    expect(
      matchReceiptPattern("Order\\n{orderid}", "Order", always),
    ).toBeNull();
    expect(
      matchReceiptPattern("Order\\n{orderid}", "Order\\n123", always),
    ).toBeNull();
  });
});

describe("capturePart", () => {
  it("names the part holding a capture", () => {
    expect(capturePart("Fee\\n{amount}", "amount")).toBe(1);
    expect(capturePart("Fee {amount}", "amount")).toBe(0);
    expect(capturePart("Fee\\nnone", "amount")).toBe(0);
  });
});

describe("fields read with a multi-line pattern", () => {
  const anthropic: ReceiptParserDefinition = {
    version: 2,
    total: ["Receipt from Anthropic, PBC\\n${amount}\\nPaid"],
  };

  it("reads a total printed between two lines", () => {
    const { parsed, trace } = parse(anthropic, ANTHROPIC);
    expect(parsed.total).toBe(3_330_000);
    expect(trace.total).toEqual({
      entry: 0,
      pattern: "Receipt from Anthropic, PBC\\n${amount}\\nPaid",
      line: { line: 2, text: "Receipt from Anthropic, PBC" },
      lines: [
        { line: 2, text: "Receipt from Anthropic, PBC" },
        { line: 3, text: "$333" },
        { line: 4, text: "Paid" },
      ],
    });
  });

  it("reads an amount with a country-prefixed dollar sign under its caption", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      total: ["Amount paid\\n{amount}"],
    };
    expect(parse(d, ["Amount paid", "CA$158.20"]).parsed.total).toBe(1_582_000);
  });

  it("does not read the amount when the line after it is not there", () => {
    const lines = ANTHROPIC.map((line) =>
      line === "Paid" ? "Refunded" : line,
    );
    expect(parse(anthropic, lines).parsed.total).toBeNull();
  });

  it("counts lines as normalised: blank lines between the parts are not lines", () => {
    const body = "Receipt from Anthropic, PBC\n\n  \n$333\n\nPaid";
    expect(parseReceipt(anthropic, "", body, null).total).toBe(3_330_000);
  });

  it("leaves a one-line hit's trace without `lines`", () => {
    const { trace } = parse({ version: 2, total: ["${amount}"] }, ANTHROPIC);
    expect(trace.total).not.toHaveProperty("lines");
  });

  it("reads an order number from lines only, never the subject", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      orderId: ["Order number\\n{orderid}"],
    };
    expect(parse(d, ["Order number", "A-123"]).parsed.orderId).toBe("A-123");
    expect(parse(d, ["Hello"], "Order number A-9").parsed.orderId).toBeNull();
  });

  it("counts a labelled entry's window from the last line of a multi-line label", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      total: [{ label: "Summary\\nTotal", value: "${amount}", within: 1 }],
    };
    expect(parse(d, ["Summary", "Total", "$5.00"]).parsed.total).toBe(50_000);
    expect(
      parse(d, ["Summary", "Total", "note", "$5.00"]).parsed.total,
    ).toBeNull();
  });

  it("reads a labelled entry's multi-line value", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      total: [{ label: "TOTAL", value: "${amount}\\nPaid" }],
    };
    expect(parse(d, ["TOTAL", "$7.00", "Due"]).parsed.total).toBeNull();
    expect(parse(d, ["TOTAL", "$7.00", "Paid"]).parsed.total).toBe(70_000);
  });

  it("counts a fee once when a one-line and a multi-line entry read the same amount line", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      fees: ["Service fee ${amount}", "Fees\\nService fee ${amount}"],
    };
    const { parsed } = parse(d, ["Fees", "Service fee $2.00"]);
    expect(parsed.fees).toEqual([20_000]);
  });

  it("still counts two fees whose multi-line blocks start on different lines", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      fees: ["Deposit\\n${amount}", "Packing\\n${amount}"],
    };
    const { parsed } = parse(d, ["Deposit", "$1.00", "Packing", "$2.00"]);
    expect(parsed.fees).toEqual([10_000, 20_000]);
  });
});

describe("guards and category rules with a multi-line pattern", () => {
  it("applies requireLine only when the lines follow each other", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      requireLine: ["Receipt from Anthropic, PBC\\n*\\nPaid"],
    };
    expect(parse(d, ANTHROPIC).outcome).toBe("read");
    expect(parse(d, ["Receipt from Anthropic, PBC", "Paid"]).outcome).toBe(
      "not_applicable",
    );
    expect(parse(d, ANTHROPIC).trace.requireLine?.lines).toHaveLength(3);
  });

  it("covers every item with a multi-line `line` rule", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      total: ["${amount}"],
      items: { single: { name: "Receipt from {name}" } },
      categoryRules: [
        { match: "Receipt from *\\n*\\nPaid", categoryId: CAT, field: "line" },
      ],
    };
    expect(parse(d, ANTHROPIC).parsed.items[0].categoryId).toBe(CAT);
    expect(
      parse(
        d,
        ANTHROPIC.filter((line) => line !== "Paid"),
      ).parsed.items[0].categoryId,
    ).toBeNull();
  });
});

describe("items read with a multi-line pattern", () => {
  it("reads an item over several lines and starts the next item after them", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      items: { patterns: ["{name}\\nQty {qty}\\n${amount}"] },
    };
    const { parsed, trace } = parse(d, [
      "Pen",
      "Qty 2",
      "$4.00",
      "Ink",
      "Qty 1",
      "$3.00",
    ]);
    expect(
      parsed.items.map(({ name, qty, amount }) => [name, qty, amount]),
    ).toEqual([
      ["Pen", 2, 40_000],
      ["Ink", 1, 30_000],
    ]);
    expect(trace.items[1].lines.map((line) => line.line)).toEqual([4, 5, 6]);
  });

  it("keeps a multi-line item inside the item section", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      items: { stopAt: "Total", patterns: ["{name}\\n${amount}"] },
    };
    expect(parse(d, ["Pen", "Total", "$4.00"]).parsed.items).toEqual([]);
  });

  it("tries one-line and multi-line patterns in list order", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      items: { patterns: ["{name} ${amount}", "{name}\\n${amount}"] },
    };
    const items = parse(d, ["Pen $1.00", "Ink", "$2.00"]).parsed.items;
    expect(items.map((item) => item.name)).toEqual(["Pen", "Ink"]);
  });

  it("lets a record step take several lines and traces each with its glob", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      items: {
        record: [{ line: "Item\\n{name}" }, { line: "${amount}" }],
      },
    };
    const { parsed, trace } = parse(d, ["Item", "Pen", "$4.00"]);
    expect(parsed.items[0]).toMatchObject({ name: "Pen", amount: 40_000 });
    expect(trace.items[0].patterns).toEqual([
      "Item\\n{name}",
      "Item\\n{name}",
      "${amount}",
    ]);
    expect(trace.items[0].lines.map((line) => line.line)).toEqual([1, 2, 3]);
  });

  it("drops every line a multi-line skip glob matched", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      items: {
        skipLines: ["Gift note\\n*"],
        record: [{ line: "{name}" }, { line: "${amount}" }],
      },
    };
    const items = parse(d, ["Gift note", "Love you", "Pen", "$4.00"]).parsed
      .items;
    expect(items.map((item) => item.name)).toEqual(["Pen"]);
  });

  it("reads a single item's name over several lines", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      total: ["${amount}"],
      items: { single: { name: "Receipt from {name}\\n*\\nPaid" } },
    };
    const { parsed, trace } = parse(d, ANTHROPIC);
    expect(parsed.items[0]).toMatchObject({
      name: "Anthropic, PBC",
      amount: 3_330_000,
    });
    expect(trace.items[0].lines).toHaveLength(3);
  });
});

describe("a pattern that held the two characters before", () => {
  it("no longer matches a line holding a literal backslash and n", () => {
    const lines = normalizeReceiptLines("C:\\new 5.00");
    expect(matchReceiptLines("C:\\new {amount}", lines, 0, always)).toBeNull();
  });
});
