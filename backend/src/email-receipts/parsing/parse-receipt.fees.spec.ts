import {
  completeness,
  parseReceipt,
  parseReceiptTraced,
} from "./parse-receipt";
import type {
  ParsedReceipt,
  ReceiptParserDefinition,
} from "./receipt-parser.types";

/** `fees`, `balanceTolerance` and the shorter `joinWrapped` buffer (spec 4, 7b). */

const CAT = "33333333-3333-4333-8333-333333333333";
const FEES_CAT = "55555555-5555-4555-8555-555555555555";

const def = (over: Partial<ReceiptParserDefinition> = {}) =>
  ({
    version: 2,
    defaultCategoryId: CAT,
    items: { patterns: ["Poz: {name} {amount} zł"] },
    total: ["Razem {amount} zł"],
    ...over,
  }) as ReceiptParserDefinition;

const read = (d: ReceiptParserDefinition, lines: string[]) =>
  parseReceipt(d, "", lines.join("\n"), null);

describe("fees", () => {
  const fees = def({
    fees: ["Kaucja {amount} zł", "Pakowanie {amount} zł"],
    feesCategoryId: FEES_CAT,
  });

  it("sums every entry that reads a fee into gross (items + shipping + fees)", () => {
    const parsed = read(fees, [
      "Poz: Pen 10,00 zł",
      "Kaucja 0,50 zł",
      "Pakowanie 1,25 zł",
      "Razem 11,75 zł",
    ]);
    expect(parsed.fees).toEqual([5000, 12500]);
    expect(parsed.feesCategoryId).toBe(FEES_CAT);
    expect(parsed.complete).toBe(true);
  });

  it("includes shipping in the same gross", () => {
    const parsed = read(
      { ...fees, shipping: ["Dostawa {amount} zł"], shippingCategoryId: CAT },
      [
        "Poz: Pen 10,00 zł",
        "Kaucja 0,50 zł",
        "Dostawa 5,00 zł",
        "Razem 15,50 zł",
      ],
    );
    expect(parsed.complete).toBe(true);
  });

  it("an entry that finds nothing adds nothing", () => {
    const parsed = read(fees, [
      "Poz: Pen 10,00 zł",
      "Kaucja 0,50 zł",
      "Razem 10,50 zł",
    ]);
    expect(parsed.fees).toEqual([5000]);
    expect(parsed.complete).toBe(true);
  });

  it("the same line read by two entries is one fee", () => {
    const parsed = read(
      def({
        fees: ["Kaucja {amount} zł", "{*} {amount} zł"],
        feesCategoryId: FEES_CAT,
      }),
      ["Kaucja 0,50 zł", "Poz: Pen 10,00 zł", "Razem 10,50 zł"],
    );
    expect(parsed.fees).toEqual([5000]);
  });

  it("is unbalanced when the total leaves out a fee", () => {
    const parsed = read(fees, [
      "Poz: Pen 10,00 zł",
      "Kaucja 0,50 zł",
      "Razem 10,00 zł",
    ]);
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("items_unbalanced");
  });

  it("a fee above 0 without a fees category is items_uncategorized", () => {
    const parsed = read(def({ fees: ["Kaucja {amount} zł"] }), [
      "Poz: Pen 10,00 zł",
      "Kaucja 0,50 zł",
      "Razem 10,50 zł",
    ]);
    expect(parsed.reason).toBe("items_uncategorized");
  });

  it("a zero fee needs no category", () => {
    const parsed = read(def({ fees: ["Kaucja {amount} zł"] }), [
      "Poz: Pen 10,00 zł",
      "Kaucja 0,00 zł",
      "Razem 10,00 zł",
    ]);
    expect(parsed.complete).toBe(true);
  });

  it("traces one hit per fee entry that read", () => {
    const traced = parseReceiptTraced(
      fees,
      "",
      "Poz: Pen 10,00 zł\nPakowanie 1,25 zł\nRazem 11,25 zł",
      null,
    );
    expect(traced.trace.fees).toHaveLength(1);
    expect(traced.trace.fees?.[0]).toMatchObject({
      entry: 1,
      line: { line: 2 },
    });
  });
});

describe("balanceTolerance", () => {
  const lines = ["Poz: Pen 10,00 zł", "Poz: Ink 5,00 zł", "Razem 15,01 zł"];

  it("without a tolerance one unit of the cent unbalances the receipt", () => {
    expect(read(def(), lines).reason).toBe("items_unbalanced");
  });

  it("a difference within the tolerance balances, and is carried in 1/10000 units", () => {
    const parsed = read(def({ balanceTolerance: "0.01" }), lines);
    expect(parsed.complete).toBe(true);
    expect(parsed.balanceTolerance).toBe(100);
  });

  it("a difference above the tolerance still unbalances", () => {
    expect(
      read(def({ balanceTolerance: "0.01" }), [
        "Poz: Pen 10,00 zł",
        "Razem 10,02 zł",
      ]).reason,
    ).toBe("items_unbalanced");
  });

  it("the edge is inclusive and applies to paid, to gross and to net", () => {
    const base = {
      orderId: null,
      payee: null,
      shipping: null,
      items: [{ name: "Pen", qty: 1, amount: 100000, categoryId: CAT }],
      shippingCategoryId: null,
      discountCategoryId: CAT,
      balanceTolerance: 500,
    };
    expect(
      completeness({ ...base, total: null, paid: 100500, discount: null }),
    ).toBeNull();
    expect(
      completeness({ ...base, total: null, paid: 100501, discount: null }),
    ).toBe("items_unbalanced");
    expect(
      completeness({ ...base, total: 99500, paid: null, discount: null }),
    ).toBeNull();
    expect(
      completeness({ ...base, total: 100500, paid: null, discount: 20000 }),
    ).toBeNull();
  });
});

describe("joinWrapped with a shorter buffer", () => {
  const withPattern = (pattern: string) =>
    def({ items: { patterns: [pattern], joinWrapped: true } });
  const traced = (pattern: string, lines: string[]) =>
    parseReceiptTraced(withPattern(pattern), "", lines.join("\n"), null);

  it("reads the line alone when the whole buffer makes no item", () => {
    const parsed = read(withPattern("ITEM {name} {amount} zł"), [
      "junk",
      "other",
      "ITEM Pen 1,00 zł",
    ]);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].amount).toBe(10000);
  });

  it("tries the last 2, then 1, then 0 held lines", () => {
    const lines = ["one", "two", "three", "ITEM Pen 1,00 zł"];
    const used = (pattern: string) =>
      traced(pattern, lines).trace.items[0].lines.length;
    expect(used("one two three ITEM {name} {amount} zł")).toBe(4);
    expect(used("two three ITEM {name} {amount} zł")).toBe(3);
    expect(used("three ITEM {name} {amount} zł")).toBe(2);
    expect(used("ITEM {name} {amount} zł")).toBe(1);
  });

  it("prefers the longest buffer that reads", () => {
    const parsed = read(withPattern("{name} {amount} zł"), [
      "a",
      "Pen 1,00 zł",
    ]);
    expect(parsed.items.map((i) => i.name)).toEqual(["a Pen"]);
  });
});

describe("fees on a stored receipt", () => {
  it("a reading with no fees field is judged as before", () => {
    const parsed = {
      orderId: null,
      total: 100000,
      paid: null,
      payee: null,
      shipping: null,
      discount: null,
      items: [{ name: "Pen", qty: 1, amount: 100000, categoryId: CAT }],
      shippingCategoryId: null,
      discountCategoryId: CAT,
    } satisfies Omit<ParsedReceipt, "complete" | "reason" | "source">;
    expect(completeness(parsed)).toBeNull();
  });
});
