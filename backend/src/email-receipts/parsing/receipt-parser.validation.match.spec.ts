import { validateReceiptParserDefinition } from "./receipt-parser.validation";

/**
 * The keys a profile gained for matching, tagging and the AI's categories
 * (design 5.5 and 5.6): `reference`, `match`, `tag`, `aiCategories`. Every code is
 * reported at the path of the problem.
 */

const errorsOf = (input: unknown) => {
  const result = validateReceiptParserDefinition(input);
  if (result.ok) throw new Error("expected a refusal");
  return result.errors;
};
const codesAt = (input: unknown, path: string): string[] =>
  errorsOf(input)
    .filter((error) => error.path === path)
    .map((error) => error.code);
const def = (extra: Record<string, unknown>) => ({ version: 2, ...extra });

describe("reference", () => {
  it("accepts entries with the {reference} capture, patterns and labelled", () => {
    const input = def({
      reference: [
        "Payment id: {reference}",
        { label: "Numer transakcji", value: "{reference}", within: 2 },
      ],
    });
    expect(validateReceiptParserDefinition(input)).toEqual({
      ok: true,
      definition: input,
    });
  });

  it("needs the {reference} capture and no other", () => {
    expect(
      codesAt(def({ reference: ["Payment id: *"] }), "reference[0]"),
    ).toEqual(["capture_missing"]);
    expect(
      codesAt(def({ reference: ["Id {orderid}"] }), "reference[0]"),
    ).toEqual(
      expect.arrayContaining(["capture_not_allowed", "capture_missing"]),
    );
  });

  it("is bounded like the other fields", () => {
    const many = Array.from({ length: 11 }, (_, i) => `R${i} {reference}`);
    expect(codesAt(def({ reference: many }), "reference")).toEqual([
      "too_many",
    ]);
    expect(codesAt(def({ reference: "Id {reference}" }), "reference")).toEqual([
      "invalid_type",
    ]);
  });
});

describe("match", () => {
  const ok = (match: unknown, extra: Record<string, unknown> = {}) =>
    validateReceiptParserDefinition(def({ match, ...extra }));

  it("accepts every key", () => {
    const match = {
      by: ["reference", "orderId", "amount_payee", "amount_date"],
      referenceIn: ["description", "payee", "referenceNumber"],
      daysBefore: 60,
      daysAfter: 90,
      amountTolerance: "5.00",
    };
    expect(ok(match, { reference: ["Id {reference}"] })).toEqual({
      ok: true,
      definition: def({ match, reference: ["Id {reference}"] }),
    });
  });

  it("accepts an empty section and the bounds' lower edge", () => {
    expect(ok({}).ok).toBe(true);
    expect(
      ok({ daysBefore: 0, daysAfter: 0, amountTolerance: "0.00" }).ok,
    ).toBe(true);
  });

  it("refuses a section that is not an object, and unknown keys", () => {
    expect(codesAt(def({ match: [] }), "match")).toEqual(["invalid_type"]);
    expect(codesAt(def({ match: "by" }), "match")).toEqual(["invalid_type"]);
    expect(codesAt(def({ match: { within: 3 } }), "match.within")).toEqual([
      "unknown_key",
    ]);
  });

  describe("by", () => {
    it("is a non-empty list of the four strategies, each once", () => {
      expect(codesAt(def({ match: { by: "orderId" } }), "match.by")).toEqual([
        "invalid_type",
      ]);
      expect(codesAt(def({ match: { by: [] } }), "match.by")).toEqual([
        "empty",
      ]);
      expect(
        codesAt(
          def({
            match: {
              by: [
                "orderId",
                "amount_payee",
                "amount_date",
                "reference",
                "orderId",
              ],
            },
          }),
          "match.by",
        ),
      ).toEqual(["too_many"]);
      expect(
        codesAt(def({ match: { by: ["orderId", "orderId"] } }), "match.by[1]"),
      ).toEqual(["duplicate_entry"]);
      expect(
        codesAt(def({ match: { by: ["amount_only"] } }), "match.by[0]"),
      ).toEqual(["invalid_value"]);
      expect(codesAt(def({ match: { by: [3] } }), "match.by[0]")).toEqual([
        "invalid_type",
      ]);
    });

    it("needs a reference field when it names `reference`", () => {
      expect(
        codesAt(def({ match: { by: ["reference"] } }), "match.by"),
      ).toEqual(["reference_field_missing"]);
      expect(
        codesAt(
          def({ match: { by: ["reference"] }, reference: [] }),
          "match.by",
        ),
      ).toEqual(["reference_field_missing"]);
      expect(
        ok({ by: ["reference"] }, { reference: ["Id {reference}"] }).ok,
      ).toBe(true);
    });
  });

  describe("referenceIn", () => {
    it("is a non-empty list of the three fields, each once", () => {
      expect(
        codesAt(def({ match: { referenceIn: [] } }), "match.referenceIn"),
      ).toEqual(["empty"]);
      expect(
        codesAt(
          def({ match: { referenceIn: ["payee", "payee"] } }),
          "match.referenceIn[1]",
        ),
      ).toEqual(["duplicate_entry"]);
      expect(
        codesAt(
          def({ match: { referenceIn: ["memo"] } }),
          "match.referenceIn[0]",
        ),
      ).toEqual(["invalid_value"]);
      expect(
        codesAt(def({ match: { referenceIn: "payee" } }), "match.referenceIn"),
      ).toEqual(["invalid_type"]);
    });
  });

  describe("daysBefore and daysAfter", () => {
    it.each([
      ["daysBefore", 61],
      ["daysBefore", -1],
      ["daysAfter", 91],
      ["daysAfter", -1],
    ])("refuses %s %d as out of range", (key, value) => {
      expect(codesAt(def({ match: { [key]: value } }), `match.${key}`)).toEqual(
        ["out_of_range"],
      );
    });

    it.each([1.5, "3", null, NaN])("refuses %j as the wrong type", (value) => {
      expect(
        codesAt(def({ match: { daysBefore: value } }), "match.daysBefore"),
      ).toEqual(["invalid_type"]);
    });
  });

  describe("amountTolerance", () => {
    it.each(["0", "0.5", "1.25", "5", "5.00", "0.0001"])(
      "accepts %j",
      (value) => {
        expect(ok({ amountTolerance: value }).ok).toBe(true);
      },
    );

    it("refuses an amount above 5.00 as out of range", () => {
      expect(
        codesAt(
          def({ match: { amountTolerance: "5.01" } }),
          "match.amountTolerance",
        ),
      ).toEqual(["out_of_range"]);
      expect(
        codesAt(
          def({ match: { amountTolerance: "100" } }),
          "match.amountTolerance",
        ),
      ).toEqual(["out_of_range"]);
    });

    it.each(["", "-1", "1,5", ".5", "1e1", "abc", "1.00001", " 1"])(
      "refuses %j as not a decimal amount",
      (value) => {
        expect(
          codesAt(
            def({ match: { amountTolerance: value } }),
            "match.amountTolerance",
          ),
        ).toEqual(["invalid_value"]);
      },
    );

    it("refuses a number: money is a string", () => {
      expect(
        codesAt(
          def({ match: { amountTolerance: 0.5 } }),
          "match.amountTolerance",
        ),
      ).toEqual(["invalid_type"]);
    });
  });
});

describe("tag", () => {
  it("accepts a tag and stores it trimmed", () => {
    expect(
      validateReceiptParserDefinition(def({ tag: "  Allegro  " })),
    ).toEqual({
      ok: true,
      definition: def({ tag: "Allegro" }),
    });
    expect(
      validateReceiptParserDefinition(def({ tag: "x".repeat(50) })).ok,
    ).toBe(true);
  });

  it("refuses a non-string, a blank, an over-long one and a control character", () => {
    expect(codesAt(def({ tag: 3 }), "tag")).toEqual(["invalid_type"]);
    expect(codesAt(def({ tag: "   " }), "tag")).toEqual(["empty"]);
    expect(codesAt(def({ tag: "" }), "tag")).toEqual(["empty"]);
    expect(codesAt(def({ tag: "x".repeat(51) }), "tag")).toEqual(["too_long"]);
    expect(codesAt(def({ tag: "a\nb" }), "tag")).toEqual(["control_character"]);
    expect(codesAt(def({ tag: "a\u0000b" }), "tag")).toEqual([
      "control_character",
    ]);
  });
});

describe("aiCategories", () => {
  it("accepts a boolean", () => {
    expect(
      validateReceiptParserDefinition(def({ aiCategories: true })).ok,
    ).toBe(true);
    expect(
      validateReceiptParserDefinition(def({ aiCategories: false })).ok,
    ).toBe(true);
  });

  it("refuses anything else", () => {
    expect(codesAt(def({ aiCategories: "yes" }), "aiCategories")).toEqual([
      "invalid_type",
    ]);
    expect(codesAt(def({ aiCategories: 1 }), "aiCategories")).toEqual([
      "invalid_type",
    ]);
  });
});
