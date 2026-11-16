import {
  RULE_DESCRIPTION_MAX_LENGTH,
  RULE_PAYEE_NAME_MAX_LENGTH,
  composeDescription,
  parseTemplate,
  renderPayeeName,
  renderRuleTemplate,
} from "./rule-template";

const values = (over: object = {}) => ({
  captures: Object.assign(Object.create(null), { payee: "Jan Kowalski" }),
  payeeText: "  RAW TEXT ",
  description: "old note",
  ...over,
});

describe("parseTemplate", () => {
  it("splits text and placeholders", () => {
    expect(
      parseTemplate("a {payee} b {payeeText}{description}").tokens,
    ).toEqual([
      { kind: "text", text: "a " },
      { kind: "ref", name: "payee" },
      { kind: "text", text: " b " },
      { kind: "ref", name: "payeeText" },
      { kind: "ref", name: "description" },
    ]);
  });

  it("reports a placeholder-shaped group that is not one, and leaves other braces alone", () => {
    expect(parseTemplate("{Payee} {} {1} {a b} {").malformed).toEqual([
      "Payee",
      "",
    ]);
  });
});

describe("renderRuleTemplate", () => {
  it("renders captures, the trimmed payee text and the current description", () => {
    expect(
      renderRuleTemplate("{payee} / {payeeText} / {description}", values()),
    ).toBe("Jan Kowalski / RAW TEXT / old note");
  });

  it("renders an unknown or empty placeholder as nothing", () => {
    expect(
      renderRuleTemplate(
        "[{nobody}][{payeeText}][{description}]",
        values({ payeeText: null, description: null }),
      ),
    ).toBe("[][][]");
  });

  it("never expands a substituted value again", () => {
    expect(
      renderRuleTemplate(
        "{payee}",
        values({ captures: { payee: "{payeeText}" } }),
      ),
    ).toBe("{payeeText}");
  });

  it("is plain text: no expression, no escape", () => {
    expect(
      renderRuleTemplate("{payee.length} {{payee}} ${payee}", values()),
    ).toBe("{payee.length} {Jan Kowalski} $Jan Kowalski");
  });

  it("does not read a prototype property as a capture", () => {
    expect(
      renderRuleTemplate("[{constructor}]", { ...values(), captures: {} }),
    ).toBe("[]");
  });

  it("strips angle brackets, also from captured values", () => {
    expect(
      renderRuleTemplate(
        "<b>{payee}</b>",
        values({ captures: { payee: "<script>x" } }),
      ),
    ).toBe("bscriptx/b");
  });
});

describe("renderPayeeName", () => {
  it("folds whitespace and trims", () => {
    expect(renderPayeeName("  {payee}\n\t  ({payeeText})  ", values())).toBe(
      "Jan Kowalski (RAW TEXT)",
    );
  });

  it("is empty when nothing is left", () => {
    expect(renderPayeeName("{nobody}  ", values())).toBe("");
  });

  it("is bounded to the payee name column", () => {
    const out = renderPayeeName("x".repeat(400), values());
    expect(out).toHaveLength(RULE_PAYEE_NAME_MAX_LENGTH);
  });
});

describe("composeDescription", () => {
  it("replace writes the rendered text, trimmed", () => {
    expect(composeDescription("old", "  new ", "replace")).toBe("new");
    expect(composeDescription(null, "new", "replace")).toBe("new");
  });

  it("append and prepend join without adding a separator", () => {
    expect(composeDescription("old", " more", "append")).toBe("old more");
    expect(composeDescription("old", "more ", "prepend")).toBe("more old");
    expect(composeDescription(null, "x", "append")).toBe("x");
    expect(composeDescription("old", "x", "append")).toBe("oldx");
  });

  it("a blank rendering is a refusal in replace mode and no change otherwise", () => {
    expect(composeDescription("old", "   ", "replace")).toBeNull();
    expect(composeDescription("old", "", "append")).toBe("old");
    expect(composeDescription(null, "", "prepend")).toBe("");
  });

  it("is bounded to the note length", () => {
    expect(
      composeDescription("a".repeat(700), "b".repeat(200), "append"),
    ).toHaveLength(RULE_DESCRIPTION_MAX_LENGTH);
    expect(composeDescription("a", "b".repeat(2000), "replace")).toHaveLength(
      RULE_DESCRIPTION_MAX_LENGTH,
    );
  });
});
