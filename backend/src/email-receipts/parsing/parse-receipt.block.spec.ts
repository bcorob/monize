import { parseReceipt } from "./parse-receipt";
import {
  MAX_ITEMS,
  ReceiptBlockItemsDefinition,
  ReceiptParserDefinition,
} from "./receipt-parser.types";

/**
 * Block items (design 5.4): a `record` of line patterns read from a cursor,
 * one item per match, for emails that put a product's name, amount and
 * quantity on separate lines.
 */

const CAT = "33333333-3333-4333-8333-333333333333";
const CAT_CABLE = "11111111-1111-4111-8111-111111111111";

const NAME = { line: "{name}" };
const AMOUNT = { line: "{amount} zł" };
const QTY_OPTIONAL = { line: "{qty} × {price} zł", optional: true };

const block = (
  items: Partial<ReceiptBlockItemsDefinition> & {
    record: ReceiptBlockItemsDefinition["record"];
  },
  extra: Partial<ReceiptParserDefinition> = {},
): ReceiptParserDefinition => ({
  version: 2,
  items,
  defaultCategoryId: CAT,
  ...extra,
});

const items = (def: ReceiptParserDefinition, lines: string[]) =>
  parseReceipt(def, "", lines.join("\n"), null).items;

const brief = (def: ReceiptParserDefinition, lines: string[]) =>
  items(def, lines).map(({ name, qty, amount }) => [name, qty, amount]);

describe("block items: the record", () => {
  const def = block({ record: [NAME, AMOUNT, QTY_OPTIONAL] });

  it("reads one item from a name line and an amount line", () => {
    expect(items(def, ["Pen", "2,50 zł"])).toEqual([
      { name: "Pen", qty: 1, amount: 25000, categoryId: CAT },
    ]);
  });

  it("reads the optional step when it is there: amount stays the line total", () => {
    expect(items(def, ["Pen", "7,50 zł", "3 × 2,50 zł"])).toEqual([
      { name: "Pen", qty: 3, amount: 75000, categoryId: CAT },
    ]);
  });

  it("moves past the optional line when present and reads the next product from the line after", () => {
    expect(
      brief(def, ["Pen", "7,50 zł", "3 × 2,50 zł", "Ink", "1,00 zł"]),
    ).toEqual([
      ["Pen", 3, 75000],
      ["Ink", 1, 10000],
    ]);
  });

  it("does not take the next product's name for the optional step when it is absent", () => {
    expect(brief(def, ["Pen", "2,50 zł", "Ink", "1,00 zł"])).toEqual([
      ["Pen", 1, 25000],
      ["Ink", 1, 10000],
    ]);
  });

  it("lets an optional step sit in the middle of the record", () => {
    const middle = block({
      record: [NAME, { line: "SKU {qty}", optional: true }, AMOUNT],
    });
    expect(brief(middle, ["Pen", "SKU 4", "2,00 zł"])).toEqual([
      ["Pen", 4, 20000],
    ]);
    expect(brief(middle, ["Pen", "2,00 zł"])).toEqual([["Pen", 1, 20000]]);
  });

  it("prices by unit price times quantity when there is no amount capture", () => {
    const priced = block({
      record: [NAME, { line: "{qty} × {price} zł" }],
    });
    expect(brief(priced, ["Pen", "3 × 0,10 zł"])).toEqual([["Pen", 3, 3000]]);
  });

  it("takes the amount capture over price times quantity", () => {
    // 4,41 is what was charged, whatever 3 × 1,47 would round to.
    expect(brief(def, ["Pen", "4,40 zł", "3 × 1,47 zł"])).toEqual([
      ["Pen", 3, 44000],
    ]);
  });

  it("lets a step without captures consume a line", () => {
    const withTag = block({
      record: [{ line: "Pozycja" }, NAME, AMOUNT],
    });
    expect(brief(withTag, ["Pozycja", "Pen", "2,00 zł"])).toEqual([
      ["Pen", 1, 20000],
    ]);
  });

  it("fails a record when a required step does not match, and reads nothing", () => {
    expect(items(def, ["Pen", "no amount here"])).toEqual([]);
    expect(items(def, ["Pen"])).toEqual([]);
    expect(items(def, [])).toEqual([]);
  });

  it("refuses a step whose values do not read", () => {
    expect(items(def, ["Pen", "soon zł"])).toEqual([]);
    expect(items(def, ["Pen", "-5,00 zł"])).toEqual([]);
    const badQty = block({ record: [NAME, { line: "{qty} × {price} zł" }] });
    expect(items(badQty, ["Pen", "many × 1,00 zł"])).toEqual([]);
    expect(items(badQty, ["Pen", "0 × 1,00 zł"])).toEqual([]);
    const emptyName = block({ record: [{ line: "Nazwa: {name}" }, AMOUNT] });
    expect(items(emptyName, ["Nazwa:", "1,00 zł"])).toEqual([]);
  });

  it("does not take a quantity line for an amount", () => {
    // Version-1 grammar would read "3 × 1,47 zł" as 31,47.
    expect(items(def, ["Pen", "3 × 1,47 zł"])).toEqual([]);
    expect(items(def, ["Pen", "10,95 + 5,00 zł"])).toEqual([]);
  });

  it("refuses a product whose price times quantity is not a safe integer", () => {
    const priced = block({ record: [NAME, { line: "{qty} × {price} zł" }] });
    expect(items(priced, ["Gold", "9999 × 500000000000 zł"])).toEqual([]);
  });

  it("categorises by rule, then default, then the payee's default", () => {
    const rules = block(
      { record: [NAME, AMOUNT] },
      {
        categoryRules: [{ match: "*cable*", categoryId: CAT_CABLE }],
        defaultCategoryId: undefined,
      },
    );
    const parsed = parseReceipt(
      rules,
      "",
      ["USB cable", "1,00 zł", "Mug", "2,00 zł"].join("\n"),
      "payee-default",
    );
    expect(parsed.items.map((item) => item.categoryId)).toEqual([
      CAT_CABLE,
      "payee-default",
    ]);
  });

  it("keeps at most 100 items", () => {
    const lines = Array.from({ length: MAX_ITEMS + 20 }, (_, i) => [
      `Item${i}`,
      "1,00 zł",
    ]).flat();
    const read = items(def, lines);
    expect(read).toHaveLength(MAX_ITEMS);
    expect(read[MAX_ITEMS - 1].name).toBe(`Item${MAX_ITEMS - 1}`);
  });
});

describe("block items: the cursor resynchronises after a failed record", () => {
  const def = block({ record: [NAME, AMOUNT] });

  it("moves one line, so a product after junk is still found", () => {
    expect(
      brief(def, ["Header", "Pen", "2,00 zł", "orphan", "Ink", "3,00 zł"]),
    ).toEqual([
      ["Pen", 1, 20000],
      ["Ink", 1, 30000],
    ]);
  });

  it("finds the product that starts inside what the failed record had consumed", () => {
    // "A" cannot pair with "B"; "B" pairs with its amount.
    expect(brief(def, ["A", "B", "1,00 zł"])).toEqual([["B", 1, 10000]]);
  });

  it("does not read an orphan amount line as the start of a product", () => {
    expect(brief(def, ["4,41 zł", "Pen", "2,00 zł"])).toEqual([
      ["Pen", 1, 20000],
    ]);
  });
});

describe("block items: skipLines and the section", () => {
  const skip = ["<*>", "(*)"];
  const def = block({ skipLines: skip, record: [NAME, AMOUNT, QTY_OPTIONAL] });

  it("drops matching lines before the cursor walks", () => {
    expect(
      brief(def, [
        "Pen",
        "<https://example.test/a>",
        "(123)",
        "<https://example.test/a>",
        "2,00 zł",
      ]),
    ).toEqual([["Pen", 1, 20000]]);
  });

  it("matches a skip glob against the whole line, case-insensitively", () => {
    const upper = block({ skipLines: ["PROMO"], record: [NAME, AMOUNT] });
    expect(brief(upper, ["Pen", "promo", "2,00 zł"])).toEqual([
      ["Pen", 1, 20000],
    ]);
    // "PROMO" is not "PROMO 10%": that line stays, and is read as the name.
    expect(brief(upper, ["Pen", "PROMO 10%", "2,00 zł"])).toEqual([
      ["PROMO 10%", 1, 20000],
    ]);
  });

  it("reads only between startAfter and stopAt", () => {
    const bounded = block({
      startAfter: "od ",
      stopAt: "Metoda dostawy",
      skipLines: skip,
      record: [NAME, AMOUNT],
    });
    expect(
      brief(bounded, [
        "Header",
        "9,99 zł",
        "od sklep",
        "Pen",
        "2,00 zł",
        "Metoda dostawy",
        "Box",
        "1,00 zł",
      ]),
    ).toEqual([["Pen", 1, 20000]]);
  });

  it("reads nothing when startAfter never appears", () => {
    const bounded = block({ startAfter: "od ", record: [NAME, AMOUNT] });
    expect(items(bounded, ["Pen", "2,00 zł"])).toEqual([]);
  });

  it("reads the whole email without markers", () => {
    expect(
      brief(block({ record: [NAME, AMOUNT] }), ["Pen", "2,00 zł"]),
    ).toEqual([["Pen", 1, 20000]]);
  });
});
