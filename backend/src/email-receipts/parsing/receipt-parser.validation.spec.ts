import {
  collectParserCategoryIds,
  validateReceiptParserDefinition,
} from "./receipt-parser.validation";
import {
  MAX_CATEGORY_RULES,
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_LINES,
  MAX_PATTERNS_PER_FIELD,
  MAX_SECTION_MARKER_LENGTH,
} from "./receipt-parser.types";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

const valid = (): Record<string, unknown> => ({
  version: 2,
  orderId: ["*order #{orderid}", "Order number: {orderid}"],
  total: ["Order total: {amount}", "*Grand total*{amount}"],
  shipping: ["Shipping: {amount}"],
  discount: ["Discount: {amount}"],
  items: {
    startAfter: "Items in your order",
    stopAt: "Subtotal",
    patterns: ["{qty} x {name} ${amount}", "{name} @{price}"],
  },
  categoryRules: [
    { match: "*cable*", categoryId: UUID_A },
    { match: "*book*", categoryId: UUID_B },
  ],
  defaultCategoryId: UUID_C,
  shippingCategoryId: UUID_A,
});

const errorsOf = (input: unknown) => {
  const result = validateReceiptParserDefinition(input);
  if (result.ok) throw new Error("expected a refusal");
  return result.errors;
};

const codesAt = (input: unknown, path: string): string[] =>
  errorsOf(input)
    .filter((error) => error.path === path)
    .map((error) => error.code);

describe("validateReceiptParserDefinition: accepted definitions", () => {
  it("accepts the design's example shape and returns it unchanged", () => {
    const input = valid();
    const result = validateReceiptParserDefinition(input);
    expect(result).toEqual({ ok: true, definition: input });
  });

  it("accepts the smallest definition", () => {
    expect(validateReceiptParserDefinition({ version: 2 })).toEqual({
      ok: true,
      definition: { version: 2 },
    });
  });

  it("accepts an empty pattern list for an optional field", () => {
    const result = validateReceiptParserDefinition({ version: 2, total: [] });
    expect(result).toEqual({ ok: true, definition: { version: 2, total: [] } });
  });

  it("returns a fresh object holding only validated data", () => {
    const input = valid();
    const result = validateReceiptParserDefinition(input);
    if (!result.ok) throw new Error("expected acceptance");
    (input.total as string[]).push("{amount}");
    (input.items as { patterns: string[] }).patterns.length = 0;
    expect(result.definition.total).toHaveLength(2);
    expect(
      (result.definition.items as { patterns: string[] }).patterns,
    ).toHaveLength(2);
    expect(result.definition).not.toBe(input);
  });

  it("accepts an upper-case UUID", () => {
    const result = validateReceiptParserDefinition({
      version: 2,
      defaultCategoryId: UUID_A.toUpperCase(),
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["price with qty", "{qty} x {name} @{price}"],
    ["price alone", "{name} @{price}"],
    ["amount alone", "{name} ${amount}"],
    ["amount with qty", "{name} x{qty} = {amount}"],
  ])("accepts an item pattern with %s", (_label, pattern) => {
    const result = validateReceiptParserDefinition({
      version: 2,
      items: { patterns: [pattern] },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts duplicate category rule patterns", () => {
    const result = validateReceiptParserDefinition({
      version: 2,
      categoryRules: [
        { match: "*cable*", categoryId: UUID_A },
        { match: "*cable*", categoryId: UUID_B },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts the bounds exactly", () => {
    const tenPatterns = Array.from(
      { length: MAX_PATTERNS_PER_FIELD },
      (_, i) => `T${i} {amount}`,
    );
    const longPattern = `{amount}${"x".repeat(MAX_PATTERN_LENGTH - 8)}`;
    const rules = Array.from({ length: MAX_CATEGORY_RULES }, (_, i) => ({
      match: `*r${i}*`,
      categoryId: UUID_A,
    }));
    const result = validateReceiptParserDefinition({
      version: 2,
      total: tenPatterns,
      shipping: [longPattern],
      items: {
        startAfter: "s".repeat(MAX_SECTION_MARKER_LENGTH),
        stopAt: "e".repeat(MAX_SECTION_MARKER_LENGTH),
        patterns: ["{name} {amount}"],
      },
      categoryRules: rules,
    });
    expect(longPattern).toHaveLength(MAX_PATTERN_LENGTH);
    expect(result.ok).toBe(true);
  });
});

describe("validateReceiptParserDefinition: never throws", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["a string", "{}"],
    ["a number", 1],
    ["a boolean", true],
  ])("refuses %s as not_object", (_label, input) => {
    expect(errorsOf(input)).toEqual([{ path: "", code: "not_object" }]);
  });

  it("survives hostile nesting and prototype keys", () => {
    const hostile = JSON.parse(
      '{"version":2,"__proto__":{"x":1},"constructor":{"a":1},"items":{"patterns":[{"a":1}]}}',
    );
    expect(() => validateReceiptParserDefinition(hostile)).not.toThrow();
    const codes = errorsOf(hostile).map((error) => error.code);
    expect(codes).toContain("unknown_key");
    expect(codes).toContain("invalid_type");
  });
});

describe("validateReceiptParserDefinition: keys and version", () => {
  it("refuses an unknown key at the top level", () => {
    expect(errorsOf({ ...valid(), extra: 1 })).toEqual([
      { path: "extra", code: "unknown_key" },
    ]);
  });

  it("refuses an unknown key under items", () => {
    const input = valid();
    (input.items as Record<string, unknown>).extra = "x";
    expect(errorsOf(input)).toEqual([
      { path: "items.extra", code: "unknown_key" },
    ]);
  });

  it("refuses an unknown key in a category rule", () => {
    const input = valid();
    (input.categoryRules as Record<string, unknown>[])[1].note = "x";
    expect(errorsOf(input)).toEqual([
      { path: "categoryRules[1].note", code: "unknown_key" },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["1 (the retired version)", 1],
    ["3", 3],
    ["0", 0],
    ["a string", "2"],
    ["null", null],
  ])("refuses version %s", (_label, version) => {
    const input = { ...valid(), version };
    expect(codesAt(input, "version")).toEqual(["unsupported_version"]);
  });
});

describe("validateReceiptParserDefinition: types", () => {
  it.each([
    ["orderId is a string", { orderId: "Order {orderid}" }, "orderId"],
    ["orderId holds a number", { orderId: [1] }, "orderId[0]"],
    ["total is an object", { total: {} }, "total"],
    ["shipping holds null", { shipping: [null] }, "shipping[0]"],
    ["discount is null", { discount: null }, "discount"],
    ["items is a string", { items: "x" }, "items"],
    ["items is an array", { items: [] }, "items"],
    [
      "items.patterns is a string",
      { items: { patterns: "x" } },
      "items.patterns",
    ],
    [
      "startAfter is a number",
      { items: { startAfter: 5, patterns: ["{name} {amount}"] } },
      "items.startAfter",
    ],
    [
      "stopAt is null",
      { items: { stopAt: null, patterns: ["{name} {amount}"] } },
      "items.stopAt",
    ],
    ["categoryRules is an object", { categoryRules: {} }, "categoryRules"],
    ["a category rule is a number", { categoryRules: [5] }, "categoryRules[0]"],
    [
      "a rule match is a number",
      { categoryRules: [{ match: 5, categoryId: UUID_A }] },
      "categoryRules[0].match",
    ],
    [
      "defaultCategoryId is a number",
      { defaultCategoryId: 5 },
      "defaultCategoryId",
    ],
    [
      "shippingCategoryId is null",
      { shippingCategoryId: null },
      "shippingCategoryId",
    ],
  ])("refuses when %s", (_label, patch, path) => {
    expect(codesAt({ version: 2, ...patch }, path)).toEqual(["invalid_type"]);
  });
});

describe("validateReceiptParserDefinition: bounds", () => {
  const tooMany = Array.from(
    { length: MAX_PATTERNS_PER_FIELD + 1 },
    (_, i) => `T${i} {amount}`,
  );

  it.each([["total"], ["shipping"], ["discount"]])(
    "refuses more than 10 patterns in %s",
    (field) => {
      expect(codesAt({ version: 2, [field]: tooMany }, field)).toEqual([
        "too_many",
      ]);
    },
  );

  it("refuses more than 10 orderId and item patterns", () => {
    const orderIds = tooMany.map((p) => p.replace("{amount}", "{orderid}"));
    expect(codesAt({ version: 2, orderId: orderIds }, "orderId")).toEqual([
      "too_many",
    ]);
    const items = tooMany.map((p) => p.replace("{amount}", "{name} {amount}"));
    expect(
      codesAt({ version: 2, items: { patterns: items } }, "items.patterns"),
    ).toEqual(["too_many"]);
  });

  it("refuses an empty items.patterns", () => {
    expect(
      codesAt({ version: 2, items: { patterns: [] } }, "items.patterns"),
    ).toEqual(["empty"]);
  });

  it("refuses a pattern of 201 characters", () => {
    const pattern = `{amount}${"x".repeat(MAX_PATTERN_LENGTH - 7)}`;
    expect(pattern).toHaveLength(MAX_PATTERN_LENGTH + 1);
    expect(codesAt({ version: 2, total: [pattern] }, "total[0]")).toEqual([
      "too_long",
    ]);
  });

  it("refuses an empty or blank pattern", () => {
    expect(codesAt({ version: 2, total: [""] }, "total[0]")).toEqual(["empty"]);
    expect(codesAt({ version: 2, total: ["   "] }, "total[0]")).toEqual([
      "empty",
    ]);
  });

  it("refuses a pattern holding a control character", () => {
    expect(
      codesAt({ version: 2, total: ["Total\n{amount}"] }, "total[0]"),
    ).toEqual(["control_character"]);
    expect(
      codesAt({ version: 2, total: ["Total\x7f{amount}"] }, "total[0]"),
    ).toEqual(["control_character"]);
  });

  it("refuses 51 category rules", () => {
    const rules = Array.from({ length: MAX_CATEGORY_RULES + 1 }, (_, i) => ({
      match: `*r${i}*`,
      categoryId: UUID_A,
    }));
    expect(
      codesAt({ version: 2, categoryRules: rules }, "categoryRules"),
    ).toEqual(["too_many"]);
  });

  it("refuses a section marker of 101 characters, or an empty one", () => {
    const items = (marker: string) => ({
      version: 2,
      items: { startAfter: marker, patterns: ["{name} {amount}"] },
    });
    expect(
      codesAt(
        items("s".repeat(MAX_SECTION_MARKER_LENGTH + 1)),
        "items.startAfter",
      ),
    ).toEqual(["too_long"]);
    expect(codesAt(items("  "), "items.startAfter")).toEqual(["empty"]);
    const stop = {
      version: 2,
      items: { stopAt: "", patterns: ["{name} {amount}"] },
    };
    expect(codesAt(stop, "items.stopAt")).toEqual(["empty"]);
  });

  it("reports at most 50 errors however bad the input", () => {
    const rules = Array.from({ length: MAX_CATEGORY_RULES }, () => ({
      match: "{x}",
      categoryId: "nope",
    }));
    expect(errorsOf({ version: 2, categoryRules: rules })).toHaveLength(50);
  });
});

describe("validateReceiptParserDefinition: captures", () => {
  it("refuses a malformed capture", () => {
    expect(
      codesAt({ version: 2, total: ["Total {Amount}"] }, "total[0]"),
    ).toEqual(expect.arrayContaining(["malformed_capture", "capture_missing"]));
  });

  it("refuses more than five captures in a pattern", () => {
    const pattern = "{name} {amount} {price} {qty} {orderid} {other}";
    const codes = codesAt(
      { version: 2, items: { patterns: [pattern] } },
      "items.patterns[0]",
    );
    expect(codes).toContain("too_many_captures");
    expect(codes).toContain("capture_not_allowed");
  });

  it("refuses a capture name twice in one pattern", () => {
    expect(
      codesAt({ version: 2, total: ["{amount} of {amount}"] }, "total[0]"),
    ).toEqual(["duplicate_capture"]);
  });

  it("refuses a capture name the field does not take", () => {
    expect(
      codesAt({ version: 2, total: ["{name} {amount}"] }, "total[0]"),
    ).toEqual(["capture_not_allowed"]);
    expect(
      codesAt({ version: 2, shipping: ["{qty} {amount}"] }, "shipping[0]"),
    ).toEqual(["capture_not_allowed"]);
    expect(
      codesAt({ version: 2, discount: ["{orderid} {amount}"] }, "discount[0]"),
    ).toEqual(["capture_not_allowed"]);
    expect(
      codesAt({ version: 2, orderId: ["{amount}"] }, "orderId[0]"),
    ).toEqual(["capture_not_allowed", "capture_missing"]);
    expect(
      codesAt(
        { version: 2, items: { patterns: ["{name} {amount} {payee}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_not_allowed"]);
  });

  it("refuses a pattern without the capture its field needs", () => {
    expect(codesAt({ version: 2, total: ["Total"] }, "total[0]")).toEqual([
      "capture_missing",
    ]);
    expect(codesAt({ version: 2, orderId: ["Order"] }, "orderId[0]")).toEqual([
      "capture_missing",
    ]);
  });

  it("refuses an item pattern without a name", () => {
    expect(
      codesAt(
        { version: 2, items: { patterns: ["{amount}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_missing"]);
  });

  it("refuses an item pattern with neither amount nor price", () => {
    expect(
      codesAt(
        { version: 2, items: { patterns: ["{qty} {name}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_missing"]);
    expect(
      codesAt(
        { version: 2, items: { patterns: ["{name}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_missing"]);
  });

  it("refuses an item pattern with both amount and price", () => {
    expect(
      codesAt(
        { version: 2, items: { patterns: ["{name} {amount} {price}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_conflict"]);
  });

  it("refuses a capture in a category rule's match", () => {
    expect(
      codesAt(
        {
          version: 2,
          categoryRules: [{ match: "{name}", categoryId: UUID_A }],
        },
        "categoryRules[0].match",
      ),
    ).toEqual(["capture_not_allowed"]);
  });

  it("reports the path of the pattern that is wrong", () => {
    const input = valid();
    (input.items as { patterns: string[] }).patterns[1] = "{name}";
    expect(errorsOf(input)).toEqual([
      { path: "items.patterns[1]", code: "capture_missing" },
    ]);
  });
});

describe("validateReceiptParserDefinition: category ids", () => {
  it.each([
    ["not-a-uuid"],
    [""],
    ["11111111-1111-4111-8111-11111111111"],
    ["11111111111141118111111111111111"],
    ["11111111-1111-4111-8111-11111111111g"],
  ])("refuses %j as a category id", (id) => {
    expect(
      codesAt({ version: 2, defaultCategoryId: id }, "defaultCategoryId"),
    ).toEqual(["invalid_uuid"]);
    expect(
      codesAt({ version: 2, shippingCategoryId: id }, "shippingCategoryId"),
    ).toEqual(["invalid_uuid"]);
    expect(
      codesAt(
        { version: 2, categoryRules: [{ match: "*a*", categoryId: id }] },
        "categoryRules[0].categoryId",
      ),
    ).toEqual(["invalid_uuid"]);
  });

  it("reports a missing rule field as a type error", () => {
    expect(errorsOf({ version: 2, categoryRules: [{}] })).toEqual([
      { path: "categoryRules[0].match", code: "invalid_type" },
      { path: "categoryRules[0].categoryId", code: "invalid_type" },
    ]);
  });
});

describe("collectParserCategoryIds", () => {
  it("lists each id once: rules, then the default, then shipping", () => {
    const result = validateReceiptParserDefinition({
      version: 2,
      categoryRules: [
        { match: "*a*", categoryId: UUID_B },
        { match: "*b*", categoryId: UUID_A },
        { match: "*c*", categoryId: UUID_B },
      ],
      defaultCategoryId: UUID_A,
      shippingCategoryId: UUID_C,
    });
    if (!result.ok) throw new Error("expected acceptance");
    expect(collectParserCategoryIds(result.definition)).toEqual([
      UUID_B,
      UUID_A,
      UUID_C,
    ]);
  });

  it("is empty for a definition without categories", () => {
    expect(collectParserCategoryIds({ version: 2 })).toEqual([]);
  });

  it("lists the default alone", () => {
    expect(
      collectParserCategoryIds({ version: 2, defaultCategoryId: UUID_A }),
    ).toEqual([UUID_A]);
  });
});

describe("validateReceiptParserDefinition: labelled fields", () => {
  const labelled = (patch: Record<string, unknown> = {}) => ({
    label: "RAZEM",
    value: "{amount} zł",
    ...patch,
  });
  const withTotal = (entry: unknown) => ({ version: 2, total: [entry] });

  it("accepts a labelled entry beside a line pattern, in any field", () => {
    const input = {
      version: 2,
      orderId: [{ label: "Numer", value: "{orderid}" }, "*#{orderid}"],
      total: [labelled({ within: 3 }), "Total {amount}"],
      shipping: [labelled({ within: 1 })],
      discount: [labelled({ within: 10 })],
    };
    expect(validateReceiptParserDefinition(input)).toEqual({
      ok: true,
      definition: input,
    });
  });

  it("returns a fresh labelled object without a within it was not given", () => {
    const entry = labelled();
    const result = validateReceiptParserDefinition(withTotal(entry));
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.definition.total?.[0]).toEqual(entry);
    expect(result.definition.total?.[0]).not.toBe(entry);
  });

  it.each([
    ["zero", 0],
    ["eleven", 11],
    ["negative", -2],
  ])("refuses a within of %s as out_of_range", (_label, within) => {
    expect(codesAt(withTotal(labelled({ within })), "total[0].within")).toEqual(
      ["out_of_range"],
    );
  });

  it.each([
    ["a fraction", 1.5],
    ["a string", "3"],
    ["null", null],
  ])("refuses a within that is %s as invalid_type", (_label, within) => {
    expect(codesAt(withTotal(labelled({ within })), "total[0].within")).toEqual(
      ["invalid_type"],
    );
  });

  it("refuses an unknown key of a labelled entry", () => {
    expect(
      codesAt(withTotal(labelled({ extra: 1 })), "total[0].extra"),
    ).toEqual(["unknown_key"]);
  });

  it("needs both a label and a value", () => {
    expect(codesAt(withTotal({ value: "{amount}" }), "total[0].label")).toEqual(
      ["invalid_type"],
    );
    expect(codesAt(withTotal({ label: "X" }), "total[0].value")).toEqual([
      "invalid_type",
    ]);
  });

  it("refuses a capture in the label", () => {
    expect(
      codesAt(withTotal(labelled({ label: "{amount}" })), "total[0].label"),
    ).toEqual(["capture_not_allowed"]);
  });

  it("holds the value to the field's captures", () => {
    expect(
      codesAt(withTotal(labelled({ value: "no capture" })), "total[0].value"),
    ).toEqual(["capture_missing"]);
    expect(
      codesAt(withTotal(labelled({ value: "{name}" })), "total[0].value"),
    ).toContain("capture_not_allowed");
    expect(
      codesAt(
        { version: 2, orderId: [{ label: "N", value: "{amount}" }] },
        "orderId[0].value",
      ),
    ).toContain("capture_not_allowed");
  });

  it("bounds the label and the value like a pattern", () => {
    expect(
      codesAt(
        withTotal(labelled({ label: "x".repeat(MAX_PATTERN_LENGTH + 1) })),
        "total[0].label",
      ),
    ).toEqual(["too_long"]);
    expect(
      codesAt(
        withTotal(
          labelled({ value: `{amount}${"x".repeat(MAX_PATTERN_LENGTH)}` }),
        ),
        "total[0].value",
      ),
    ).toEqual(["too_long"]);
    expect(
      codesAt(withTotal(labelled({ label: " " })), "total[0].label"),
    ).toEqual(["empty"]);
    expect(
      codesAt(withTotal(labelled({ label: "a\nb" })), "total[0].label"),
    ).toEqual(["control_character"]);
  });

  it("counts a labelled entry toward the ten per field", () => {
    const many = Array.from({ length: MAX_PATTERNS_PER_FIELD + 1 }, () =>
      labelled(),
    );
    expect(codesAt({ version: 2, total: many }, "total")).toEqual(["too_many"]);
  });

  it("refuses an object entry in the item pattern list", () => {
    expect(
      codesAt(
        { version: 2, items: { patterns: [labelled()] } },
        "items.patterns[0]",
      ),
    ).toEqual(["invalid_type"]);
  });
});

describe("validateReceiptParserDefinition: block items", () => {
  const record = (
    steps: unknown[] = [
      { line: "{name}" },
      { line: "{amount} zł" },
      { line: "{qty} × {price} zł", optional: true },
    ],
  ) => steps;
  const block = (items: Record<string, unknown>) => ({ version: 2, items });

  it("accepts the Allegro block, and returns it unchanged", () => {
    const input = block({
      startAfter: "od ",
      stopAt: "Metoda dostawy",
      skipLines: ["<*>", "(*)"],
      record: record(),
    });
    expect(validateReceiptParserDefinition(input)).toEqual({
      ok: true,
      definition: input,
    });
  });

  it("accepts the bounds exactly: 6 steps and 10 skipLines", () => {
    const six = [
      { line: "{name}" },
      { line: "a" },
      { line: "b" },
      { line: "c" },
      { line: "d" },
      { line: "{amount}" },
    ];
    const ten = Array.from({ length: 10 }, (_, i) => `skip ${i}`);
    expect(
      validateReceiptParserDefinition(block({ skipLines: ten, record: six }))
        .ok,
    ).toBe(true);
  });

  it("accepts an empty skipLines", () => {
    expect(
      validateReceiptParserDefinition(
        block({ skipLines: [], record: record() }),
      ).ok,
    ).toBe(true);
  });

  it("needs exactly one of patterns and record", () => {
    expect(
      codesAt(
        block({ patterns: ["{name} {amount}"], record: record() }),
        "items",
      ),
    ).toEqual(["items_patterns_and_record"]);
    expect(codesAt(block({}), "items")).toEqual(["items_shape_missing"]);
    expect(codesAt(block({ startAfter: "x" }), "items")).toEqual([
      "items_shape_missing",
    ]);
  });

  it("refuses skipLines beside patterns", () => {
    expect(
      codesAt(
        block({ patterns: ["{name} {amount}"], skipLines: ["x"] }),
        "items.skipLines",
      ),
    ).toEqual(["skip_lines_need_record"]);
  });

  it("holds skipLines to 0..10 capture-free globs", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `skip ${i}`);
    expect(
      codesAt(
        block({ skipLines: eleven, record: record() }),
        "items.skipLines",
      ),
    ).toEqual(["too_many"]);
    expect(
      codesAt(block({ skipLines: "x", record: record() }), "items.skipLines"),
    ).toEqual(["invalid_type"]);
    expect(
      codesAt(
        block({ skipLines: ["{name}"], record: record() }),
        "items.skipLines[0]",
      ),
    ).toEqual(["capture_not_allowed"]);
    expect(
      codesAt(
        block({ skipLines: [5], record: record() }),
        "items.skipLines[0]",
      ),
    ).toEqual(["invalid_type"]);
  });

  it("holds the record to 1..6 steps", () => {
    expect(codesAt(block({ record: [] }), "items.record")).toEqual(["empty"]);
    const seven = Array.from({ length: 7 }, () => ({ line: "x" }));
    expect(codesAt(block({ record: seven }), "items.record")).toEqual([
      "too_many",
    ]);
    expect(codesAt(block({ record: "x" }), "items.record")).toEqual([
      "invalid_type",
    ]);
  });

  it("checks each step's shape", () => {
    expect(codesAt(block({ record: ["x"] }), "items.record[0]")).toEqual([
      "invalid_type",
    ]);
    expect(
      codesAt(
        block({ record: record([{ line: "{name}", extra: 1 }]) }),
        "items.record[0].extra",
      ),
    ).toEqual(["unknown_key"]);
    expect(
      codesAt(
        block({ record: [{ line: "{name} {amount}", optional: "yes" }] }),
        "items.record[0].optional",
      ),
    ).toEqual(["invalid_type"]);
    expect(
      codesAt(block({ record: [{ optional: true }] }), "items.record[0].line"),
    ).toEqual(["invalid_type"]);
  });

  it("allows only the item captures in a step", () => {
    expect(
      codesAt(
        block({ record: [{ line: "{orderid}" }] }),
        "items.record[0].line",
      ),
    ).toEqual(["capture_not_allowed"]);
  });

  it("refuses a capture name used by two steps", () => {
    expect(
      codesAt(
        block({
          record: [{ line: "{name} {amount}" }, { line: "{name}" }],
        }),
        "items.record[1].line",
      ),
    ).toEqual(["duplicate_capture"]);
  });

  it("refuses amount and price in one step", () => {
    expect(
      codesAt(
        block({ record: [{ line: "{name}" }, { line: "{amount} {price}" }] }),
        "items.record[1].line",
      ),
    ).toEqual(["capture_conflict"]);
  });

  it("allows amount and price in different steps (the amount is the line total)", () => {
    expect(
      validateReceiptParserDefinition(block({ record: record() })).ok,
    ).toBe(true);
  });

  it("needs a name somewhere in the record, and no amount: the only item takes the total", () => {
    expect(
      codesAt(block({ record: [{ line: "{amount}" }] }), "items.record"),
    ).toEqual(["record_name_missing"]);
    expect(
      codesAt(
        block({ record: [{ line: "x" }, { line: "y" }] }),
        "items.record",
      ),
    ).toEqual(["record_name_missing"]);
    expect(
      validateReceiptParserDefinition(
        block({ record: [{ line: "{name}" }, { line: "Ilość: {qty}" }] }),
      ).ok,
    ).toBe(true);
  });

  it("checks the markers of the block shape too", () => {
    expect(
      codesAt(block({ startAfter: 5, record: record() }), "items.startAfter"),
    ).toEqual(["invalid_type"]);
  });

  it("never throws on hostile input", () => {
    for (const items of [null, 5, [], { record: null }, { record: [null] }]) {
      expect(() =>
        validateReceiptParserDefinition({ version: 2, items }),
      ).not.toThrow();
    }
  });
});

describe("validateReceiptParserDefinition: paid, payee and the line guards", () => {
  it("accepts paid and payee with the same entry shapes as total", () => {
    const input = {
      version: 2,
      paid: [
        { label: "Zapłacono", value: "{amount} zł", within: 2 },
        "Razem: {amount} zł",
      ],
      payee: [{ label: "Sprzedawca", value: "{payee}" }, "Sklep: {payee}"],
    };
    expect(validateReceiptParserDefinition(input)).toEqual({
      ok: true,
      definition: input,
    });
  });

  it("holds paid to {amount} and payee to {payee}", () => {
    expect(codesAt({ version: 2, paid: ["no capture"] }, "paid[0]")).toEqual([
      "capture_missing",
    ]);
    expect(codesAt({ version: 2, payee: ["{amount}"] }, "payee[0]")).toEqual(
      expect.arrayContaining(["capture_not_allowed", "capture_missing"]),
    );
    expect(
      codesAt({ version: 2, payee: ["{payee} {payee}"] }, "payee[0]"),
    ).toContain("duplicate_capture");
  });

  it("bounds paid and payee to ten entries", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `P${i} {amount}`);
    expect(codesAt({ version: 2, paid: eleven }, "paid")).toEqual(["too_many"]);
  });

  it.each(["requireLine", "skipIfLine", "waitIfLine"])(
    "accepts 0 to 10 capture-free globs in %s",
    (field) => {
      const ten = Array.from({ length: 10 }, (_, i) => `*line ${i}*`);
      expect(
        validateReceiptParserDefinition({ version: 2, [field]: ten }).ok,
      ).toBe(true);
      expect(
        validateReceiptParserDefinition({ version: 2, [field]: [] }).ok,
      ).toBe(true);
      expect(codesAt({ version: 2, [field]: [...ten, "x"] }, field)).toEqual([
        "too_many",
      ]);
      expect(codesAt({ version: 2, [field]: "x" }, field)).toEqual([
        "invalid_type",
      ]);
      expect(
        codesAt({ version: 2, [field]: ["{name}"] }, `${field}[0]`),
      ).toEqual(["capture_not_allowed"]);
      expect(codesAt({ version: 2, [field]: [5] }, `${field}[0]`)).toEqual([
        "invalid_type",
      ]);
      expect(codesAt({ version: 2, [field]: [" "] }, `${field}[0]`)).toEqual([
        "empty",
      ]);
    },
  );

  it("accepts the literal asterisk forms in a pattern", () => {
    const input = {
      version: 2,
      total: ["Kwota: {*}{amount} PLN{*}"],
      orderId: ["Numer: \\*{orderid}\\*"],
    };
    expect(validateReceiptParserDefinition(input).ok).toBe(true);
  });
});

describe("validateReceiptParserDefinition: single, joinWrapped, alternatives and category rule fields", () => {
  const items = (value: Record<string, unknown>) => ({
    version: 2,
    items: value,
  });

  it("accepts items.single with its markers", () => {
    const input = items({
      startAfter: "Opis",
      stopAt: "Kwota",
      single: { name: "Opis: {name}" },
    });
    expect(validateReceiptParserDefinition(input)).toEqual({
      ok: true,
      definition: input,
    });
  });

  it("holds single to one {name} glob, and no skipLines", () => {
    expect(
      codesAt(items({ single: { name: "no capture" } }), "items.single.name"),
    ).toEqual(["capture_missing"]);
    expect(
      codesAt(items({ single: { name: "{amount}" } }), "items.single.name"),
    ).toEqual(
      expect.arrayContaining(["capture_not_allowed", "capture_missing"]),
    );
    expect(
      codesAt(
        items({ single: { name: "{name}", extra: 1 } }),
        "items.single.extra",
      ),
    ).toEqual(["unknown_key"]);
    expect(codesAt(items({ single: "x" }), "items.single")).toEqual([
      "invalid_type",
    ]);
    expect(
      codesAt(
        items({ single: { name: "{name}" }, skipLines: ["x"] }),
        "items.skipLines",
      ),
    ).toEqual(["skip_lines_need_record"]);
  });

  it("refuses single together with patterns or record", () => {
    expect(
      codesAt(
        items({ single: { name: "{name}" }, patterns: ["{name} {amount}"] }),
        "items",
      ),
    ).toEqual(["items_single_conflict"]);
    expect(
      codesAt(
        items({ single: { name: "{name}" }, record: [{ line: "{name}" }] }),
        "items",
      ),
    ).toEqual(["items_single_conflict"]);
    expect(codesAt(items({}), "items")).toEqual(["items_shape_missing"]);
  });

  it("accepts joinWrapped with patterns only", () => {
    expect(
      validateReceiptParserDefinition(
        items({ patterns: ["{name} {amount}"], joinWrapped: true }),
      ).ok,
    ).toBe(true);
    expect(
      codesAt(
        items({ record: [{ line: "{name}" }], joinWrapped: true }),
        "items.joinWrapped",
      ),
    ).toEqual(["join_wrapped_needs_patterns"]);
    expect(
      codesAt(
        items({ single: { name: "{name}" }, joinWrapped: true }),
        "items.joinWrapped",
      ),
    ).toEqual(["join_wrapped_needs_patterns"]);
    expect(
      codesAt(
        items({ patterns: ["{name} {amount}"], joinWrapped: "yes" }),
        "items.joinWrapped",
      ),
    ).toEqual(["invalid_type"]);
  });

  it("accepts 1 to 5 alternative globs for a record step", () => {
    const input = items({
      record: [
        { line: ["[image: {name}]", "{name}"] },
        { line: "Ilość: {qty}", optional: true },
      ],
    });
    expect(validateReceiptParserDefinition(input)).toEqual({
      ok: true,
      definition: input,
    });
    const five = Array.from({ length: 5 }, (_, i) => `a${i} {name}`);
    expect(
      validateReceiptParserDefinition(items({ record: [{ line: five }] })).ok,
    ).toBe(true);
  });

  it("bounds and checks the alternatives", () => {
    const six = Array.from({ length: 6 }, (_, i) => `a${i} {name}`);
    expect(
      codesAt(items({ record: [{ line: six }] }), "items.record[0].line"),
    ).toEqual(["too_many"]);
    expect(
      codesAt(items({ record: [{ line: [] }] }), "items.record[0].line"),
    ).toEqual(["empty"]);
    expect(
      codesAt(
        items({ record: [{ line: ["{name}", "{orderid}"] }] }),
        "items.record[0].line[1]",
      ),
    ).toEqual(["capture_not_allowed"]);
    expect(
      codesAt(
        items({ record: [{ line: ["{name}", 5] }] }),
        "items.record[0].line[1]",
      ),
    ).toEqual(["invalid_type"]);
    expect(
      codesAt(
        items({ record: [{ line: ["{amount} {price}"] }, { line: "{name}" }] }),
        "items.record[0].line[0]",
      ),
    ).toEqual(["capture_conflict"]);
  });

  it("lets the alternatives of one step share a capture name but not another step", () => {
    expect(
      codesAt(
        items({
          record: [
            { line: ["[image: {name}]", "{name}"] },
            { line: "{name} x" },
          ],
        }),
        "items.record[1].line",
      ),
    ).toEqual(["duplicate_capture"]);
  });

  it("accepts category rule fields item, payee and line", () => {
    const input = {
      version: 2,
      categoryRules: [
        { match: "*a*", categoryId: UUID_A },
        { match: "*b*", categoryId: UUID_A, field: "item" },
        { match: "*c*", categoryId: UUID_B, field: "payee" },
        { match: "*d*", categoryId: UUID_B, field: "line" },
      ],
    };
    expect(validateReceiptParserDefinition(input)).toEqual({
      ok: true,
      definition: input,
    });
  });

  it("refuses another field value, and a field that is not text", () => {
    const rule = (field: unknown) => ({
      version: 2,
      categoryRules: [{ match: "*a*", categoryId: UUID_A, field }],
    });
    expect(codesAt(rule("subject"), "categoryRules[0].field")).toEqual([
      "invalid_value",
    ]);
    expect(codesAt(rule(5), "categoryRules[0].field")).toEqual([
      "invalid_type",
    ]);
  });
});

describe("validateReceiptParserDefinition: the lines source", () => {
  it("accepts text and html, and keeps what was written", () => {
    for (const source of ["text", "html"]) {
      const input = { version: 2, source, total: ["Total: {amount}"] };
      expect(validateReceiptParserDefinition(input)).toEqual({
        ok: true,
        definition: input,
      });
    }
  });

  it("does not require it: a definition without one reads the text", () => {
    const result = validateReceiptParserDefinition({ version: 2 });
    expect(result).toEqual({ ok: true, definition: { version: 2 } });
  });

  it("refuses anything else as invalid_value, whatever its type", () => {
    for (const source of ["pdf", "HTML", "", " text", 5, null, true, [], {}]) {
      expect(codesAt({ version: 2, source }, "source")).toEqual([
        "invalid_value",
      ]);
    }
  });
});

describe("validateReceiptParserDefinition: multi-line patterns", () => {
  it("accepts parts joined by \\n wherever the email's lines are read", () => {
    const input = {
      version: 2,
      total: ["Receipt from *\\n{amount}\\nPaid"],
      orderId: [{ label: "Order\\nNumber", value: "{orderid}\\n*" }],
      items: { patterns: ["{name}\\n{amount}"] },
      requireLine: ["Receipt\\n*"],
      categoryRules: [{ match: "Gift\\n*", categoryId: UUID_A, field: "line" }],
    };
    expect(validateReceiptParserDefinition(input)).toEqual({
      ok: true,
      definition: input,
    });
  });

  it("accepts up to MAX_PATTERN_LINES parts and refuses one more", () => {
    const parts = (n: number) =>
      [...Array(n - 1).fill("*"), "{amount}"].join("\\n");
    expect(
      validateReceiptParserDefinition({
        version: 2,
        total: [parts(MAX_PATTERN_LINES)],
      }).ok,
    ).toBe(true);
    expect(
      codesAt(
        { version: 2, total: [parts(MAX_PATTERN_LINES + 1)] },
        "total[0]",
      ),
    ).toEqual(["too_many_lines"]);
  });

  it("refuses an empty part: it could only match an empty line", () => {
    for (const pattern of [
      "Total\\n\\n{amount}",
      "{amount}\\n",
      "\\n{amount}",
    ]) {
      expect(codesAt({ version: 2, total: [pattern] }, "total[0]")).toEqual([
        "empty",
      ]);
    }
  });

  it("checks captures over every part together", () => {
    expect(
      codesAt({ version: 2, total: ["{amount}\\n{amount}"] }, "total[0]"),
    ).toEqual(["duplicate_capture"]);
    expect(codesAt({ version: 2, total: ["Total\\n*"] }, "total[0]")).toEqual([
      "capture_missing",
    ]);
    expect(
      codesAt({ version: 2, total: ["{amount}\\n{name}"] }, "total[0]"),
    ).toEqual(["capture_not_allowed"]);
    // A capture cut by a line break is two halves of literal text, not a capture.
    expect(
      codesAt({ version: 2, total: ["Total {amo\\nunt}"] }, "total[0]"),
    ).toEqual(["capture_missing"]);
  });

  it("refuses a multi-line category rule over an item name or the payee", () => {
    for (const field of [undefined, "item", "payee"]) {
      const rule = { match: "Gift\\n*", categoryId: UUID_A, field };
      expect(
        codesAt(
          { version: 2, categoryRules: [rule] },
          "categoryRules[0].match",
        ),
      ).toEqual(["line_break_not_allowed"]);
    }
  });
});

describe("validateReceiptParserDefinition: discard", () => {
  it.each(["ignore", "delete"])(
    "accepts %s, alone or beside anything else",
    (discard) => {
      for (const input of [
        { version: 2, discard },
        { ...valid(), discard },
      ]) {
        expect(validateReceiptParserDefinition(input)).toEqual({
          ok: true,
          definition: input,
        });
      }
    },
  );

  it("is compatible with a trade section", () => {
    expect(
      codesAt({ version: 2, discard: "ignore", trade: {} }, "discard"),
    ).toEqual([]);
  });

  it("refuses anything else as invalid_value, whatever its type", () => {
    for (const discard of ["archive", "IGNORE", "", true, 1, null, [], {}]) {
      expect(codesAt({ version: 2, discard }, "discard")).toEqual([
        "invalid_value",
      ]);
    }
  });
});
