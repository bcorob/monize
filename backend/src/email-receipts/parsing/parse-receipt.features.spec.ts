import {
  completeness,
  parseReceipt,
  parseReceiptTraced,
  readLineGuards,
} from "./parse-receipt";
import { matchReceiptPattern } from "./receipt-glob";
import {
  MAX_TRACE_LINE_LENGTH,
  type ParsedReceipt,
  type ReceiptParserDefinition,
} from "./receipt-parser.types";

/**
 * The language's later additions, one section each: `paid` and the arithmetic,
 * `items.single`, `joinWrapped`, the literal asterisk and the trimming of
 * values, the `payee` field and `categoryRules[].field`, the line guards, step
 * alternatives, and the trace.
 */

const CAT = "33333333-3333-4333-8333-333333333333";
const CAT_A = "11111111-1111-4111-8111-111111111111";
const CAT_B = "22222222-2222-4222-8222-222222222222";

const read = (def: ReceiptParserDefinition, lines: string[], subject = "") =>
  parseReceipt(def, subject, lines.join("\n"), null);

const base = (over: Partial<ReceiptParserDefinition> = {}) =>
  ({ version: 2, defaultCategoryId: CAT, ...over }) as ReceiptParserDefinition;

const item = (amount: number, categoryId: string | null = CAT) => ({
  name: "Pen",
  qty: 1,
  amount,
  categoryId,
});

const receipt = (
  over: Partial<Omit<ParsedReceipt, "complete" | "reason" | "source">>,
): Omit<ParsedReceipt, "complete" | "reason" | "source"> => ({
  orderId: null,
  total: null,
  paid: null,
  payee: null,
  shipping: null,
  discount: null,
  items: [item(100000)],
  shippingCategoryId: null,
  discountCategoryId: CAT,
  ...over,
});

describe("completeness: total, paid and the arithmetic", () => {
  // gross = items + shipping; net = gross - discount (absent = 0).
  it.each([
    ["neither total nor paid", { total: null, paid: null }, "no_total"],
    ["total = gross = net", { total: 100000 }, null],
    ["paid = net (no total)", { paid: 100000 }, null],
    ["total and paid both equal", { total: 100000, paid: 100000 }, null],
    ["total is neither gross nor net", { total: 90000 }, "items_unbalanced"],
    ["paid is not net", { paid: 90000 }, "items_unbalanced"],
    [
      "paid wrong though total is right",
      { total: 100000, paid: 90000 },
      "items_unbalanced",
    ],
    [
      "total wrong though paid is right",
      { total: 90000, paid: 100000 },
      "items_unbalanced",
    ],
  ])("%s", (_label, over, reason) => {
    expect(completeness(receipt(over))).toBe(reason);
  });

  it.each([
    [
      "total = gross, paid = net (a promotion)",
      { total: 100000, paid: 70000 },
      null,
    ],
    ["total = net, no paid", { total: 70000 }, null],
    ["total = gross, no paid", { total: 100000 }, null],
    ["paid = net only", { paid: 70000 }, null],
    ["paid = gross is not net", { paid: 100000 }, "items_unbalanced"],
    ["total is neither", { total: 80000 }, "items_unbalanced"],
  ])("with a discount of 3.00 on 10.00: %s", (_label, over, reason) => {
    expect(completeness(receipt({ ...over, discount: 30000 }))).toBe(reason);
  });

  it("counts shipping into gross and so into both readings", () => {
    const base = { shipping: 20000, shippingCategoryId: CAT, discount: 10000 };
    // gross 12.00, net 11.00
    expect(completeness(receipt({ ...base, total: 120000 }))).toBeNull();
    expect(completeness(receipt({ ...base, total: 110000 }))).toBeNull();
    expect(completeness(receipt({ ...base, paid: 110000 }))).toBeNull();
    expect(completeness(receipt({ ...base, paid: 120000 }))).toBe(
      "items_unbalanced",
    );
  });

  it("refuses a discount larger than gross (a negative net)", () => {
    expect(completeness(receipt({ total: 100000, discount: 500000 }))).toBe(
      "items_unbalanced",
    );
  });

  it("answers item_amount_missing for an unresolved item, after no_total", () => {
    expect(completeness(receipt({ total: 100000 }), true)).toBe(
      "item_amount_missing",
    );
    expect(completeness(receipt({}), true)).toBe("no_total");
  });

  it("reads a stored receipt without paid as having none", () => {
    const stored = receipt({ total: 100000 }) as Record<string, unknown>;
    delete stored.paid;
    expect(
      completeness(stored as unknown as ReturnType<typeof receipt>),
    ).toBeNull();
  });
});

describe("the paid field", () => {
  const def = base({
    total: ["Razem {amount}"],
    paid: ["Zapłacono {amount}"],
    discount: ["Rabat {amount}"],
    items: {
      patterns: ["{name} {amount}"],
      startAfter: "Items",
      stopAt: "Razem",
    },
  });
  const lines = [
    "Items",
    "Pen 10.00",
    "Razem 10.00",
    "Rabat 3.00",
    "Zapłacono 7.00",
  ];

  it("reads paid like total, and completeness uses both", () => {
    const parsed = read(def, lines);
    expect(parsed).toMatchObject({
      total: 100000,
      paid: 70000,
      discount: 30000,
    });
    expect(parsed.complete).toBe(true);
  });

  it("is complete from paid alone", () => {
    const parsed = read({ ...def, total: undefined }, [
      "Items",
      "Pen 7.00",
      "Razem",
      "Zapłacono 7.00",
    ]);
    expect(parsed).toMatchObject({ total: null, paid: 70000, complete: true });
  });

  it("takes its entries in array order and reads labelled entries", () => {
    const labelled = base({
      paid: [
        { label: "Zapłacono", value: "{amount}", within: 1 },
        "Razem {amount}",
      ],
      items: { patterns: ["{name} {amount}"] },
    });
    expect(read(labelled, ["Zapłacono", "7.00", "Razem 9.00"]).paid).toBe(
      70000,
    );
  });
});

describe("items.single", () => {
  const def = (extra: Partial<ReceiptParserDefinition> = {}) =>
    base({
      total: ["Kwota {amount}"],
      items: { single: { name: "Opis: {name}" } },
      ...extra,
    });

  it("reads one item: the first accepted line's name, quantity 1, the total as its amount", () => {
    const parsed = read(def(), ["Opis: Pen", "Opis: Second", "Kwota 12.50"]);
    expect(parsed.items).toEqual([
      { name: "Pen", qty: 1, amount: 125000, categoryId: CAT },
    ]);
    expect(parsed.complete).toBe(true);
  });

  it("takes the paid amount when there is no total", () => {
    const parsed = read(def({ total: undefined, paid: ["Kwota {amount}"] }), [
      "Opis: Pen",
      "Kwota 12.50",
    ]);
    expect(parsed.items[0].amount).toBe(125000);
    expect(parsed.complete).toBe(true);
  });

  it("with a discount the item carries the total (the gross)", () => {
    const parsed = read(
      def({
        total: ["Cena {amount}"],
        paid: ["Kwota {amount}"],
        discount: ["Rabat {amount}"],
      }),
      ["Opis: Pen", "Cena 10.00", "Rabat 3.00", "Kwota 7.00"],
    );
    expect(parsed.items[0].amount).toBe(100000);
    expect(parsed.complete).toBe(true);
  });

  it("is no item when the email states neither total nor paid", () => {
    const parsed = read(def(), ["Opis: Pen"]);
    expect(parsed.items).toEqual([]);
    expect(parsed.reason).toBe("no_total");
  });

  it("is no item when no line gives a name", () => {
    expect(read(def(), ["Kwota 12.50"]).items).toEqual([]);
  });

  it("reads only inside startAfter and stopAt", () => {
    const parsed = read(
      def({
        items: {
          startAfter: "Szczegóły",
          stopAt: "Kwota",
          single: { name: "Opis: {name}" },
        },
      }),
      [
        "Opis: Before",
        "Szczegóły",
        "Opis: Inside",
        "Kwota 12.50",
        "Opis: After",
      ],
    );
    expect(parsed.items.map((i) => i.name)).toEqual(["Inside"]);
  });

  it("skips a line whose name is empty", () => {
    const parsed = read(def(), ["Opis:", "Opis: Pen", "Kwota 1.00"]);
    expect(parsed.items.map((i) => i.name)).toEqual(["Pen"]);
  });
});

describe("items.joinWrapped", () => {
  const def = (join = true) =>
    base({
      items: { patterns: ["{name} {amount} zł"], joinWrapped: join },
    });
  const names = (lines: string[], join = true) =>
    read(def(join), lines).items.map((i) => i.name);

  it("puts the lines no pattern reads in front of the next line, joined by a space", () => {
    expect(
      names(["Hot Package 5 (Last", "War:Survival Game) 24,99 zł"]),
    ).toEqual(["Hot Package 5 (Last War:Survival Game)"]);
  });

  it("holds at most three lines: the oldest is dropped", () => {
    const parsed = names(["one", "two", "three", "four", "five 1,00 zł"]);
    expect(parsed).toEqual(["two three four five"]);
  });

  it("holds exactly three lines without dropping any", () => {
    expect(names(["one", "two", "three", "four 1,00 zł"])).toEqual([
      "one two three four",
    ]);
  });

  it("clears the held lines when an item is emitted", () => {
    expect(names(["a", "Pen 1,00 zł", "b", "Ink 2,00 zł"])).toEqual([
      "a Pen",
      "b Ink",
    ]);
    expect(names(["Pen 1,00 zł", "Ink 2,00 zł"])).toEqual(["Pen", "Ink"]);
  });

  it("does not join without the flag", () => {
    expect(
      names(["Hot Package 5 (Last", "War:Survival Game) 24,99 zł"], false),
    ).toEqual(["War:Survival Game)"]);
  });

  it("traces every joined line", () => {
    const { trace } = parseReceiptTraced(
      def(),
      "",
      ["header", "Hot (Last", "War) 24,99 zł"].join("\n"),
      null,
    );
    expect(trace.items[0].lines.map((l) => l.line)).toEqual([1, 2, 3]);
  });
});

describe("the literal asterisk and the trimming of values", () => {
  const any = () => true;

  it("treats {*} and \\* in a pattern as a literal *", () => {
    expect(matchReceiptPattern("a{*}b", "a*b", any)).toEqual({});
    expect(matchReceiptPattern("a\\*b", "a*b", any)).toEqual({});
    expect(matchReceiptPattern("a{*}b", "axb", any)).toBeNull();
    expect(matchReceiptPattern("a\\*b", "axb", any)).toBeNull();
    // A plain * stays a wildcard, and it matches a literal * too.
    expect(matchReceiptPattern("a*b", "axxb", any)).toEqual({});
    expect(matchReceiptPattern("a*b", "a*b", any)).toEqual({});
  });

  it("reads a value between literal asterisks without them", () => {
    expect(
      matchReceiptPattern("Opis: {*}{name}{*}", "Opis: *Pen*", any),
    ).toEqual({
      name: "Pen",
    });
    expect(
      matchReceiptPattern("Opis: {*}{name}{*}", "Opis: Pen", any),
    ).toBeNull();
  });

  it("trims every captured value of whitespace, * and _", () => {
    expect(
      matchReceiptPattern("Kwota: {amount}", "Kwota: *149,41 PLN*", any),
    ).toEqual({
      amount: "149,41 PLN",
    });
    expect(matchReceiptPattern("N: {orderid}", "N: _*A-1*_ ", any)).toEqual({
      orderid: "A-1",
    });
    expect(matchReceiptPattern("N: {orderid}", "N: * _ *", any)).toEqual({
      orderid: "",
    });
  });

  it("keeps an asterisk or underscore inside a value", () => {
    expect(matchReceiptPattern("N: {name}", "N: *a*b_c*", any)).toEqual({
      name: "a*b_c",
    });
  });

  it("hands the trimmed value to accept", () => {
    const seen: string[] = [];
    matchReceiptPattern("Kwota: {amount}", "Kwota: *5*", (captures) => {
      seen.push(captures.amount);
      return true;
    });
    expect(seen).toEqual(["5"]);
  });

  it("applies to a label glob as to any pattern", () => {
    const parsed = read(
      base({
        total: [{ label: "{*}Razem{*}", value: "{amount}", within: 1 }],
        items: { patterns: ["{name} {amount}"] },
      }),
      ["*Razem*", "*9,00*"],
    );
    expect(parsed.total).toBe(90000);
  });
});

describe("the payee field and categoryRules[].field", () => {
  const def = (rules: ReceiptParserDefinition["categoryRules"]) =>
    base({
      total: ["Kwota {amount}"],
      payee: [{ label: "Sprzedawca", value: "{payee}", within: 1 }],
      items: { patterns: ["{name} {amount}"] },
      categoryRules: rules,
    });
  const lines = [
    "Kabel 4.00",
    "Sprzedawca",
    "*Sklep OLX*",
    "Kwota 4.00",
    "Promocja letnia",
  ];

  it("reads the merchant, trimmed, and null when there is none", () => {
    expect(read(def(undefined), lines).payee).toBe("Sklep OLX");
    expect(read(def(undefined), ["Kabel 4.00", "Kwota 4.00"]).payee).toBeNull();
  });

  it("takes the first rule that covers the item, in order", () => {
    const rules = [
      { match: "*kabel*", categoryId: CAT_A },
      { match: "*OLX*", field: "payee" as const, categoryId: CAT_B },
    ];
    expect(read(def(rules), lines).items[0].categoryId).toBe(CAT_A);
    expect(read(def([...rules].reverse()), lines).items[0].categoryId).toBe(
      CAT_B,
    );
  });

  it("matches a payee rule against the parsed payee for every item", () => {
    const parsed = read(
      base({
        payee: ["Sprzedawca: {payee}"],
        items: { patterns: ["{name} {amount}"] },
        categoryRules: [{ match: "sklep*", field: "payee", categoryId: CAT_B }],
      }),
      ["Pen 1.00", "Ink 2.00", "Sprzedawca: Sklep X"],
    );
    expect(parsed.items.map((i) => i.categoryId)).toEqual([CAT_B, CAT_B]);
  });

  it("never matches a payee rule when no payee was read", () => {
    const parsed = read(
      base({
        items: { patterns: ["{name} {amount}"] },
        categoryRules: [{ match: "*", field: "payee", categoryId: CAT_B }],
      }),
      ["Pen 1.00"],
    );
    expect(parsed.items[0].categoryId).toBe(CAT);
  });

  it("matches a line rule against any line of the email, for every item", () => {
    const rules = [
      { match: "promocja*", field: "line" as const, categoryId: CAT_B },
    ];
    expect(read(def(rules), lines).items[0].categoryId).toBe(CAT_B);
    expect(
      read(def(rules), ["Kabel 4.00", "Kwota 4.00"]).items[0].categoryId,
    ).toBe(CAT);
  });

  it("treats an absent or item field as the item's name", () => {
    const parsed = read(
      def([{ match: "kabel", field: "item", categoryId: CAT_A }]),
      lines,
    );
    expect(parsed.items[0].categoryId).toBe(CAT_A);
  });
});

describe("requireLine, skipIfLine and waitIfLine", () => {
  const def = (extra: Partial<ReceiptParserDefinition>) =>
    base({ total: ["Kwota {amount}"], ...extra });
  const lines = ["Faktura PayU", "Status: oczekuje", "Kwota 1.00"];

  it("applies without a requireLine, and with one only when a line matches", () => {
    expect(readLineGuards(def({}), lines).applies).toBe(true);
    expect(
      readLineGuards(def({ requireLine: ["*PayU*"] }), lines).applies,
    ).toBe(true);
    expect(
      readLineGuards(def({ requireLine: ["*Allegro*"] }), lines).applies,
    ).toBe(false);
    expect(
      readLineGuards(def({ requireLine: ["*Allegro*", "*PayU*"] }), lines),
    ).toMatchObject({
      applies: true,
      requireLine: {
        entry: 1,
        pattern: "*PayU*",
        line: { line: 1, text: "Faktura PayU" },
      },
    });
  });

  it("names the line that skips or holds an email", () => {
    const guards = readLineGuards(
      def({
        skipIfLine: ["*zwrot*", "Status: oczek*"],
        waitIfLine: ["*oczekuje*"],
      }),
      lines,
    );
    expect(guards.skipIfLine).toMatchObject({ entry: 1, line: { line: 2 } });
    expect(guards.waitIfLine).toMatchObject({ entry: 0, line: { line: 2 } });
  });

  it.each([
    ["read", {}, "read"],
    ["not_applicable", { requireLine: ["*nope*"] }, "not_applicable"],
    ["skip_line", { skipIfLine: ["*oczekuje*"] }, "skip_line"],
    ["wait_line", { waitIfLine: ["*oczekuje*"] }, "wait_line"],
    [
      "skip beats wait",
      { skipIfLine: ["*oczekuje*"], waitIfLine: ["*oczekuje*"] },
      "skip_line",
    ],
    [
      "not applicable beats both",
      { requireLine: ["*nope*"], skipIfLine: ["*oczekuje*"] },
      "not_applicable",
    ],
  ])("the outcome is %s", (_label, extra, outcome) => {
    expect(
      parseReceiptTraced(
        def({ ...extra, items: { patterns: ["{name} {amount}"] } }),
        "",
        lines.join("\n"),
        null,
      ).outcome,
    ).toBe(outcome);
  });
});

describe("record steps with alternative globs", () => {
  const def = base({
    total: ["Suma {amount}"],
    items: {
      record: [
        { line: ["[image: {name}]", "{name}"] },
        { line: "Ilość: {qty}" },
      ],
    },
  });

  it("tries the alternatives in order and takes the first that reads", () => {
    expect(
      read(def, ["[image: Kabel]", "Ilość: 2", "Suma 4,00"]).items[0].name,
    ).toBe("Kabel");
    expect(read(def, ["Kabel", "Ilość: 2", "Suma 4,00"]).items[0].name).toBe(
      "Kabel",
    );
  });

  it("reads the first alternative that matches even when a later one would read more", () => {
    expect(
      read(def, ["[image: Kabel]", "Ilość: 2", "Suma 4,00"]).items[0].name,
    ).not.toContain("image");
  });

  it("traces the alternative that read", () => {
    const { trace } = parseReceiptTraced(
      def,
      "",
      ["Kabel", "Ilość: 2", "Suma 4,00"].join("\n"),
      null,
    );
    expect(trace.items[0].patterns).toEqual(["{name}", "Ilość: {qty}"]);
  });
});

describe("an item without its own amount", () => {
  const def = (extra: Partial<ReceiptParserDefinition> = {}) =>
    base({
      total: ["Suma {amount}"],
      items: { record: [{ line: "{name}" }, { line: "Ilość: {qty}" }] },
      ...extra,
    });

  it("takes the total when it is the only item", () => {
    const parsed = read(def(), ["Kabel", "Ilość: 3", "Suma 9,00"]);
    expect(parsed.items).toEqual([
      { name: "Kabel", qty: 3, amount: 90000, categoryId: CAT },
    ]);
    expect(parsed.complete).toBe(true);
  });

  it("takes the paid amount when there is no total", () => {
    const parsed = read(def({ total: undefined, paid: ["Suma {amount}"] }), [
      "Kabel",
      "Ilość: 3",
      "Suma 9,00",
    ]);
    expect(parsed.items[0].amount).toBe(90000);
  });

  it("is item_amount_missing with two such items, and they are not listed", () => {
    const parsed = read(def(), [
      "Kabel",
      "Ilość: 3",
      "Ink",
      "Ilość: 1",
      "Suma 9,00",
    ]);
    expect(parsed.items).toEqual([]);
    expect(parsed.complete).toBe(false);
    expect(parsed.reason).toBe("item_amount_missing");
  });

  it("is item_amount_missing when one such item sits beside one with an amount", () => {
    const mixed = base({
      total: ["Suma {amount}"],
      items: {
        record: [{ line: "{name}" }, { line: "{amount} zł", optional: true }],
      },
    });
    const parsed = read(mixed, ["Kabel", "5,00 zł", "Ink", "Suma 5,00"]);
    expect(parsed.reason).toBe("item_amount_missing");
  });

  it("is no_total, not item_amount_missing, when the email states no total at all", () => {
    expect(read(def({ total: undefined }), ["Kabel", "Ilość: 3"]).reason).toBe(
      "no_total",
    );
  });
});

describe("the trace", () => {
  const def = base({
    orderId: ["*zamówienie {orderid}*"],
    total: [{ label: "RAZEM", value: "{amount} zł", within: 2 }],
    shipping: ["Dostawa: {amount} zł"],
    items: {
      patterns: ["{name} {amount} zł"],
      startAfter: "Pozycje",
      stopAt: "Dostawa:",
    },
  });
  const lines = [
    "Pozycje",
    "Pen 5,00 zł",
    "Ink 6,00 zł",
    "Dostawa: 1,00 zł",
    "RAZEM",
    "x",
    "12,00 zł",
  ];

  it("says which entry and which line read each value", () => {
    const { trace, parsed } = parseReceiptTraced(
      def,
      "Twoje zamówienie A-100",
      lines.join("\n"),
      null,
    );
    expect(parsed.total).toBe(120000);
    expect(trace.orderId).toEqual({
      entry: 0,
      pattern: "*zamówienie {orderid}*",
      line: { line: 0, text: "Twoje zamówienie A-100" },
    });
    expect(trace.shipping).toEqual({
      entry: 0,
      pattern: "Dostawa: {amount} zł",
      line: { line: 4, text: "Dostawa: 1,00 zł" },
    });
  });

  it("gives a labelled hit both its label line and its value line", () => {
    const { trace } = parseReceiptTraced(def, "", lines.join("\n"), null);
    expect(trace.total).toEqual({
      entry: 0,
      pattern: "{amount} zł",
      label: "RAZEM",
      labelLine: { line: 5, text: "RAZEM" },
      line: { line: 7, text: "12,00 zł" },
    });
  });

  it("names the entry index that matched when an earlier one found nothing", () => {
    const second = base({
      total: ["Nope {amount}", "Suma {amount}"],
      items: { patterns: ["{name} {amount}"] },
    });
    const { trace } = parseReceiptTraced(second, "", "Suma 3,00", null);
    expect(trace.total?.entry).toBe(1);
    expect(trace.total?.pattern).toBe("Suma {amount}");
  });

  it("traces each item with its pattern and line", () => {
    const { trace } = parseReceiptTraced(def, "", lines.join("\n"), null);
    expect(trace.items).toEqual([
      {
        mode: "patterns",
        patterns: ["{name} {amount} zł"],
        lines: [{ line: 2, text: "Pen 5,00 zł" }],
      },
      {
        mode: "patterns",
        patterns: ["{name} {amount} zł"],
        lines: [{ line: 3, text: "Ink 6,00 zł" }],
      },
    ]);
  });

  it("is null for every field that read nothing, and has an entry for each field", () => {
    const { trace } = parseReceiptTraced(base({}), "", "nothing", null);
    expect(trace).toEqual({
      orderId: null,
      reference: null,
      total: null,
      paid: null,
      shipping: null,
      discount: null,
      payee: null,
      requireLine: null,
      skipIfLine: null,
      waitIfLine: null,
      items: [],
    });
  });

  it("cuts a traced line to 200 characters", () => {
    const long = `Suma ${"9".repeat(300)}`;
    const { trace } = parseReceiptTraced(
      base({ orderId: ["Suma {orderid}"] }),
      "",
      long,
      null,
    );
    expect(trace.orderId?.line.text).toHaveLength(MAX_TRACE_LINE_LENGTH);
    expect(trace.orderId?.line.text.startsWith("Suma 99")).toBe(true);
  });

  it("traces a guard and a single item", () => {
    const { trace } = parseReceiptTraced(
      base({
        requireLine: ["*PayU*"],
        skipIfLine: ["*zwrot*"],
        total: ["Kwota {amount}"],
        items: { single: { name: "Opis: {name}" } },
      }),
      "",
      ["PayU", "Opis: Pen", "Kwota 1,00"].join("\n"),
      null,
    );
    expect(trace.requireLine).toEqual({
      entry: 0,
      pattern: "*PayU*",
      line: { line: 1, text: "PayU" },
    });
    expect(trace.skipIfLine).toBeNull();
    expect(trace.items).toEqual([
      {
        mode: "single",
        patterns: ["Opis: {name}"],
        lines: [{ line: 2, text: "Opis: Pen" }],
      },
    ]);
  });
});

describe("the outcome of a profile that discards its emails", () => {
  const body = "Order total: 5.00";

  it.each([
    ["ignore", "discard_ignore"],
    ["delete", "discard_delete"],
  ] as const)(
    "is %s -> %s, ahead of the skip and wait guards",
    (discard, outcome) => {
      const traced = parseReceiptTraced(
        { version: 2, discard, skipIfLine: ["*"], waitIfLine: ["*"] },
        "",
        body,
        null,
      );
      expect(traced.outcome).toBe(outcome);
    },
  );

  it("is still not_applicable when the profile's requireLine is not met", () => {
    const traced = parseReceiptTraced(
      { version: 2, discard: "delete", requireLine: ["Never here"] },
      "",
      body,
      null,
    );
    expect(traced.outcome).toBe("not_applicable");
  });
});
