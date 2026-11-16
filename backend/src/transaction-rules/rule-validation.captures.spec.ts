import {
  collectReferencedIds,
  validateRuleDefinition,
} from "./rule-validation";

const U1 = "11111111-1111-4111-8111-111111111111";

const leaf = (field: string, value: unknown, op = "matches") => ({
  field,
  op,
  value,
});
const payee = (template: unknown, extra: object = {}) => ({
  type: "set_payee_from_text",
  template,
  createIfMissing: false,
  onlyIfEmpty: true,
  ...extra,
});
const describeAction = (template: unknown, extra: object = {}) => ({
  type: "set_description",
  template,
  mode: "replace",
  onlyIfEmpty: false,
  ...extra,
});
const check = (condition: unknown, actions: unknown) =>
  validateRuleDefinition({ condition, actions });

const RULE = { all: [leaf("description", "*Odbiorca: {payee} Rachunek*")] };

describe("validateRuleDefinition: captures in a matches leaf", () => {
  it("accepts the design example and the largest legal shapes", () => {
    expect(check(RULE, [payee("{payee}")])).toEqual([]);
    expect(
      check({ all: [leaf("description", "{a}-{b}-{c}-{d}-{e}")] }, [
        payee("{a}"),
      ]),
    ).toEqual([]);
    expect(
      check({ all: [leaf("referenceNumber", `{a${"b".repeat(19)}}`)] }, [
        payee("x"),
      ]),
    ).toEqual([]);
  });

  it("refuses more than 5 captures in one pattern", () => {
    expect(
      check({ all: [leaf("description", "{a}-{b}-{c}-{d}-{e}-{f}")] }, [
        payee("x"),
      ]),
    ).toEqual([{ path: "condition.all[0].value", code: "TOO_MANY_CAPTURES" }]);
  });

  it.each([["{Payee}"], ["{}"], ["{my_name}"], [`{a${"b".repeat(20)}}`]])(
    "refuses %s, which looks like a capture and is not a valid one",
    (pattern) => {
      expect(
        check({ all: [leaf("description", pattern)] }, [payee("x")]),
      ).toEqual([{ path: "condition.all[0].value", code: "INVALID_CAPTURE" }]);
    },
  );

  it("refuses the name description, which the template language owns", () => {
    expect(
      check({ all: [leaf("description", "{description}")] }, [payee("x")]),
    ).toEqual([{ path: "condition.all[0].value", code: "INVALID_CAPTURE" }]);
  });

  it("refuses a name used twice in one pattern or in two leaves of the rule", () => {
    const dup = [{ path: "condition.all[1].value", code: "DUPLICATE_CAPTURE" }];
    expect(
      check(
        { all: [leaf("referenceNumber", "{n}"), leaf("description", "a{n}")] },
        [payee("x")],
      ),
    ).toEqual(dup);
    expect(
      check({ all: [leaf("description", "{n}-{n}")] }, [payee("x")]),
    ).toEqual([{ path: "condition.all[0].value", code: "DUPLICATE_CAPTURE" }]);
    expect(
      check(
        {
          any: [
            { all: [leaf("referenceNumber", "{n}")] },
            { all: [leaf("description", "{n}")] },
          ],
        },
        [payee("x")],
      ),
    ).toEqual([
      { path: "condition.any[1].all[0].value", code: "DUPLICATE_CAPTURE" },
    ]);
  });

  it("reads other braces as plain text", () => {
    expect(
      check({ all: [leaf("description", "*{1} {a b}")] }, [payee("x")]),
    ).toEqual([]);
  });

  it("applies to matches only", () => {
    expect(
      check({ all: [leaf("description", "{Bad}", "contains")] }, [payee("x")]),
    ).toEqual([]);
  });
});

describe("validateRuleDefinition: the text actions", () => {
  it("accepts a template that names a capture some leaf defines, or a built-in", () => {
    expect(
      check(RULE, [
        payee("{payee} ({payeeText})"),
        describeAction("{description} {payee}"),
      ]),
    ).toEqual([]);
  });

  it("refuses a template that names a capture no leaf defines", () => {
    expect(check(RULE, [payee("{nobody}")])).toEqual([
      { path: "actions[0].template", code: "UNKNOWN_CAPTURE" },
    ]);
    expect(check({ all: [] }, [describeAction("x {payee}")])).toEqual([
      { path: "actions[0].template", code: "UNKNOWN_CAPTURE" },
    ]);
  });

  it("finds a capture defined in a leaf after the action list is read (conditions are read first)", () => {
    expect(
      check(
        { any: [leaf("referenceNumber", "{later}"), leaf("description", "*")] },
        [payee("{later}")],
      ),
    ).toEqual([]);
  });

  it("refuses a placeholder shaped like a name that is not one", () => {
    expect(check(RULE, [payee("{Payee}")])).toEqual([
      { path: "actions[0].template", code: "INVALID_CAPTURE" },
    ]);
    expect(check(RULE, [payee("{}")])).toEqual([
      { path: "actions[0].template", code: "INVALID_CAPTURE" },
    ]);
  });

  it("bounds the template: 1..200 for the payee, 1..500 for the description", () => {
    expect(check(RULE, [payee("a".repeat(200))])).toEqual([]);
    expect(check(RULE, [payee("a".repeat(201))])).toEqual([
      { path: "actions[0].template", code: "VALUE_TOO_LONG" },
    ]);
    expect(check(RULE, [describeAction("a".repeat(500))])).toEqual([]);
    expect(check(RULE, [describeAction("a".repeat(501))])).toEqual([
      { path: "actions[0].template", code: "VALUE_TOO_LONG" },
    ]);
    expect(check(RULE, [payee("   ")])).toEqual([
      { path: "actions[0].template", code: "VALUE_EMPTY" },
    ]);
    expect(check(RULE, [describeAction(5)])).toEqual([
      { path: "actions[0].template", code: "VALUE_TYPE" },
    ]);
  });

  it("checks the flags and the mode", () => {
    expect(check(RULE, [payee("x", { createIfMissing: "no" })])).toEqual([
      { path: "actions[0].createIfMissing", code: "VALUE_TYPE" },
    ]);
    expect(check(RULE, [payee("x", { onlyIfEmpty: undefined })])).toEqual([
      { path: "actions[0].onlyIfEmpty", code: "VALUE_TYPE" },
    ]);
    expect(check(RULE, [describeAction("x", { mode: "insert" })])).toEqual([
      { path: "actions[0].mode", code: "INVALID_ENUM" },
    ]);
    expect(check(RULE, [describeAction("x", { mode: 1 })])).toEqual([
      { path: "actions[0].mode", code: "VALUE_TYPE" },
    ]);
    for (const mode of ["replace", "append", "prepend"]) {
      expect(check(RULE, [describeAction("x", { mode })])).toEqual([]);
    }
    expect(check(RULE, [describeAction("x", { onlyIfEmpty: 1 })])).toEqual([
      { path: "actions[0].onlyIfEmpty", code: "VALUE_TYPE" },
    ]);
  });

  it("refuses an unknown key, so nothing else can be smuggled in", () => {
    expect(check(RULE, [payee("x", { amount: 5 })])).toEqual([
      { path: "actions[0].amount", code: "UNKNOWN_KEY" },
    ]);
    expect(check(RULE, [describeAction("x", { accountId: U1 })])).toEqual([
      { path: "actions[0].accountId", code: "UNKNOWN_KEY" },
    ]);
  });

  it("names no id, so a text action adds nothing to the ownership check", () => {
    const ids = collectReferencedIds({
      condition: RULE as never,
      actions: [payee("{payee}"), describeAction("x")] as never,
    });
    expect(ids).toEqual({
      accountIds: [],
      payeeIds: [],
      categoryIds: [],
      tagIds: [],
    });
  });
});
