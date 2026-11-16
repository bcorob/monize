import { parseReceipt } from "./parse-receipt";
import {
  MAX_LABEL_WITHIN,
  MAX_PARSE_LINES,
  ReceiptFieldEntry,
  ReceiptParserDefinition,
} from "./receipt-parser.types";

/**
 * Priority by array order and labelled fields (design 5.4): the part of the
 * language that lets a parser read "TOTAL" on one line and the amount on the
 * line under it, and prefer one entry to another wherever each sits.
 */

const def = (
  field: "orderId" | "total" | "shipping" | "discount",
  ...entries: ReceiptFieldEntry[]
): ReceiptParserDefinition => ({ version: 2, [field]: entries });

const parse = (d: ReceiptParserDefinition, lines: string[], subject = "") =>
  parseReceipt(d, subject, lines.join("\n"), null);

const total = (entry: ReceiptFieldEntry, lines: string[]) =>
  parse(def("total", entry), lines).total;

describe("labelled fields: the value under a label", () => {
  const label = { label: "RAZEM", value: "{amount} zł" };

  it("reads the amount on the line under the label", () => {
    expect(total(label, ["RAZEM", "62,35 zł", "73,30 zł"])).toBe(623500);
  });

  it("takes the FIRST accepted line after the label, not a later one", () => {
    expect(total(label, ["RAZEM", "1,00 zł", "2,00 zł"])).toBe(10000);
  });

  it("matches the label against the WHOLE line, case-insensitively", () => {
    expect(total({ ...label, label: "razem" }, ["RAZEM", "5,00 zł"])).toBe(
      50000,
    );
    // A line that only STARTS with the label is not the label...
    expect(total(label, ["RAZEM do zapłaty", "5,00 zł"])).toBeNull();
    // ...unless the label says so with a wildcard.
    expect(
      total({ ...label, label: "RAZEM*" }, ["RAZEM do zapłaty", "5,00 zł"]),
    ).toBe(50000);
  });

  it("does not read the label's own line", () => {
    expect(total({ label: "*", value: "{amount} zł" }, ["7,00 zł"])).toBeNull();
  });

  it("counts normalised lines: blank lines do not use up the window", () => {
    const body = "RAZEM\n\n   \n62,35 zł";
    expect(parseReceipt(def("total", label), "", body, null).total).toBe(
      623500,
    );
  });

  it("skips a line the value does not read and keeps looking inside the window", () => {
    expect(total(label, ["RAZEM", "soon", "-5,00 zł", "7,25 zł"])).toBe(72500);
  });

  it("does not take a quantity line for an amount", () => {
    expect(total(label, ["RAZEM", "3 × 1,47 zł"])).toBeNull();
    expect(total(label, ["RAZEM", "10,95 + 5,00 zł"])).toBeNull();
  });

  it("keeps a zero amount (a value, not a missing one)", () => {
    const shipping = parse(
      def("shipping", { label: "Dostawa", value: "{amount} zł" }),
      ["Dostawa", "0,00 zł"],
    ).shipping;
    expect(shipping).toBe(0);
  });

  it("goes on to the next line matching the label when the window held nothing", () => {
    const lines = ["RAZEM", "a", "b", "c", "d", "RAZEM", "9,99 zł"];
    expect(total(label, lines)).toBe(99900);
  });

  it("is null when no label line has a readable value near it", () => {
    expect(total(label, ["RAZEM", "a", "b", "c", "5,00 zł"])).toBeNull();
    expect(total(label, ["nothing", "5,00 zł"])).toBeNull();
  });
});

describe("labelled fields: within", () => {
  const filler = (count: number) =>
    Array.from({ length: count }, (_, i) => `f${i}`);
  const at = (distance: number, within?: number) =>
    total(
      {
        label: "TOTAL",
        value: "{amount} zł",
        ...(within === undefined ? {} : { within }),
      },
      ["TOTAL", ...filler(distance - 1), "5,00 zł"],
    );

  it("defaults to 3 lines: the third is read, the fourth is not", () => {
    expect(at(3)).toBe(50000);
    expect(at(4)).toBeNull();
  });

  it.each([1, 2, 5, MAX_LABEL_WITHIN])(
    "within %i reads exactly that many lines, and not one more",
    (within) => {
      expect(at(within, within)).toBe(50000);
      expect(at(within + 1, within)).toBeNull();
    },
  );

  it("falls back to the default for a within the validator would refuse", () => {
    for (const bad of [0, -1, 1.5, 11, 99, "3" as unknown as number]) {
      expect(at(3, bad)).toBe(50000);
      expect(at(4, bad)).toBeNull();
    }
  });

  it("stops at the end of the email", () => {
    expect(
      total({ label: "TOTAL", value: "{amount} zł", within: 10 }, ["TOTAL"]),
    ).toBeNull();
  });
});

describe("priority by array order", () => {
  it("tries entry 0 over the whole email before entry 1", () => {
    const entries = ["Grand total: {amount}", "Total {amount}"];
    const lines = ["Total 10.00", "Grand total: 20.00"];
    expect(total(entries[0], lines)).toBe(200000);
    expect(parse(def("total", ...entries), lines).total).toBe(200000);
    expect(parse(def("total", entries[1], entries[0]), lines).total).toBe(
      100000,
    );
  });

  it("falls to entry 1 only when entry 0 reads nothing anywhere", () => {
    const d = def("total", "Grand total: {amount}", "Total {amount}");
    expect(parse(d, ["Total 10.00", "Subtotal soon"]).total).toBe(100000);
  });

  it("lets a labelled entry and a line pattern queue up in either order", () => {
    const labelled = { label: "RAZEM", value: "{amount} zł" };
    const lines = ["Total: 4,41 zł", "RAZEM", "62,35 zł"];
    expect(parse(def("total", labelled, "Total: {amount}"), lines).total).toBe(
      623500,
    );
    expect(parse(def("total", "Total: {amount}", labelled), lines).total).toBe(
      44100,
    );
  });

  it("applies to shipping and discount as it does to total", () => {
    const d: ReceiptParserDefinition = {
      version: 2,
      shipping: ["Dostawa {amount}", "Wysyłka {amount}"],
      discount: ["Rabat {amount}", "Zniżka {amount}"],
    };
    const lines = ["Wysyłka 5,00", "Dostawa 8,00", "Zniżka 1,00", "Rabat 2,00"];
    const parsed = parse(d, lines);
    expect(parsed.shipping).toBe(80000);
    expect(parsed.discount).toBe(20000);
  });

  it("is the reason a total under its label is not the first product's amount", () => {
    // The old reading: the first line matching "{amount} zł" anywhere.
    const lines = ["Patchcord", "4,41 zł", "RAZEM", "62,35 zł"];
    expect(parse(def("total", "{amount} zł"), lines).total).toBe(44100);
    expect(
      parse(
        def("total", { label: "RAZEM", value: "{amount} zł" }, "{amount} zł"),
        lines,
      ).total,
    ).toBe(623500);
  });
});

describe("the order id", () => {
  const link = "*/kupione/{orderid}?*";

  it("reads a line pattern from the subject first, then the body", () => {
    const d = def("orderId", "*order #{orderid}");
    expect(parse(d, ["Your order #BODY-1"], "Your order #SUBJ-9").orderId).toBe(
      "SUBJ-9",
    );
    expect(parse(d, ["Your order #BODY-1"], "Receipt").orderId).toBe("BODY-1");
  });

  it("reads the order number out of a link", () => {
    const d = def("orderId", link);
    expect(
      parse(d, ["<https://allegro.pl/moje/kupione/abc-123?ref=mail>"]).orderId,
    ).toBe("abc-123");
  });

  it("reads a labelled order id from the lines under its label", () => {
    const d = def("orderId", {
      label: "Numer zamówienia",
      value: "{orderid}",
      within: 2,
    });
    expect(parse(d, ["Numer zamówienia", "AB-12 (web)"]).orderId).toBe("AB-12");
  });

  it("never reads a labelled entry from the subject", () => {
    const d = def("orderId", { label: "*", value: "{orderid}" });
    expect(parse(d, [], "Order AB-12").orderId).toBeNull();
  });

  it("tries a labelled entry and a line pattern in array order", () => {
    const labelled = { label: "Numer", value: "{orderid}" };
    const lines = ["Numer", "LAB-1", "Order: LINE-2"];
    expect(
      parse(def("orderId", labelled, "Order: {orderid}"), lines).orderId,
    ).toBe("LAB-1");
    expect(
      parse(def("orderId", "Order: {orderid}", labelled), lines).orderId,
    ).toBe("LINE-2");
  });

  it("skips a value with an empty capture", () => {
    const d = def("orderId", { label: "Numer", value: "Nr {orderid}" });
    expect(parse(d, ["Numer", "Nr ", "Nr X-1"]).orderId).toBe("X-1");
  });
});

describe("labelled fields: bounds and hostile definitions", () => {
  it("answers 2000 label lines with no readable value in one pass", () => {
    const lines = Array.from({ length: MAX_PARSE_LINES }, () => "x");
    const started = Date.now();
    const parsed = parse(
      def("total", {
        label: "*",
        value: "{amount} zł",
        within: MAX_LABEL_WITHIN,
      }),
      lines,
    );
    expect(parsed.total).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("ignores an entry that is neither a pattern nor a labelled object", () => {
    const d = {
      version: 2,
      total: [5, null, { label: 1 }, "Total {amount}"],
      orderId: [{ value: "{orderid}" }],
    } as unknown as ReceiptParserDefinition;
    const parsed = parse(d, ["Total 3.00"]);
    expect(parsed.total).toBe(30000);
    expect(parsed.orderId).toBeNull();
  });
});
