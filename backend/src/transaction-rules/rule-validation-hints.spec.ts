import {
  RULE_ACTION_TYPES,
  SETTLE_LOAN_INSTALLMENT,
} from "./rule-action.types";
import { RULE_CONDITION_FIELDS } from "./rule-condition.types";
import {
  RULE_ACTION_TOOL_KEYS,
  ruleErrorHint,
  ruleErrorHints,
} from "./rule-validation-hints";
import {
  RULE_VALIDATION_CODES,
  validateRuleDefinition,
} from "./rule-validation";

const definition = (condition: unknown, actions: unknown) => ({
  condition,
  actions,
});
const ACTION = [{ type: "set_category", categoryId: "x", onlyIfEmpty: true }];

describe("ruleErrorHint", () => {
  it("has a hint for every validation code", () => {
    for (const code of RULE_VALIDATION_CODES) {
      expect(ruleErrorHint({ path: "condition", code })).toEqual(
        expect.any(String),
      );
    }
  });

  it("returns null for a code that is not a validation code", () => {
    expect(ruleErrorHint({ path: "x", code: "NAME_NOT_FOUND" as never })).toBe(
      null,
    );
  });

  it("explains INVALID_SHAPE on condition and on actions", () => {
    expect(ruleErrorHint({ path: "condition", code: "INVALID_SHAPE" })).toBe(
      'condition must be a JSON object: {"all":[...]} or {"any":[...]} (optional "not":true), or a leaf {"field","op","value"}, e.g. {"all":[{"field":"description","op":"contains","value":"ASSECO"}]}. Never a string.',
    );
    expect(ruleErrorHint({ path: "actions", code: "INVALID_SHAPE" })).toContain(
      "JSON array of objects",
    );
    expect(
      ruleErrorHint({ path: "actions[0]", code: "INVALID_SHAPE" }),
    ).toContain('"type"');
    expect(
      ruleErrorHint({ path: "condition.all", code: "INVALID_SHAPE" }),
    ).toContain("array of conditions");
  });

  it("names the allowed keys of a leaf for UNKNOWN_KEY", () => {
    const def = definition({ field: "description", operator: "eq" }, ACTION);
    expect(
      ruleErrorHint({ path: "condition.operator", code: "UNKNOWN_KEY" }, def),
    ).toContain('exactly the keys "field", "op" and "value"');
  });

  it("names the allowed keys of a group for UNKNOWN_KEY", () => {
    const def = definition({ all: [], x: 1 }, ACTION);
    expect(
      ruleErrorHint({ path: "condition.x", code: "UNKNOWN_KEY" }, def),
    ).toContain('only "all" or "any"');
  });

  it("names the allowed keys of the action for UNKNOWN_KEY", () => {
    const def = definition({ all: [] }, [{ type: "set_category", value: "x" }]);
    expect(
      ruleErrorHint({ path: "actions[0].value", code: "UNKNOWN_KEY" }, def),
    ).toBe(
      '"value" is not a key of this action; set_category takes only type, categoryName, onlyIfEmpty.',
    );
  });

  it("lists every field for UNKNOWN_FIELD", () => {
    const hint = ruleErrorHint({
      path: "condition.field",
      code: "UNKNOWN_FIELD",
    });
    for (const field of Object.keys(RULE_CONDITION_FIELDS)) {
      expect(hint).toContain(field);
    }
  });

  it("lists the operators of the leaf's field for OPERATOR_NOT_ALLOWED", () => {
    const def = definition(
      { all: [{ field: "amount", op: "contains", value: "x" }] },
      ACTION,
    );
    expect(
      ruleErrorHint(
        { path: "condition.all[0].op", code: "OPERATOR_NOT_ALLOWED" },
        def,
      ),
    ).toBe(
      "For field amount op must be one of: eq, lt, lte, gt, gte, between.",
    );
  });

  it("says which JSON type a value needs for VALUE_TYPE", () => {
    const def = definition(
      { all: [{ field: "amount", op: "between", value: 5 }] },
      ACTION,
    );
    expect(
      ruleErrorHint(
        { path: "condition.all[0].value", code: "VALUE_TYPE" },
        def,
      ),
    ).toContain("[min,max]");
  });

  it("points a regex at an any group and a bare word at eq / contains", () => {
    expect(
      ruleErrorHint({ path: "condition.value", code: "LOOKS_LIKE_REGEX" }),
    ).toContain('{"any":[');
    expect(
      ruleErrorHint({
        path: "condition.value",
        code: "PATTERN_WITHOUT_WILDCARD",
      }),
    ).toContain('"eq" for the whole text');
  });
});

describe("ruleErrorHints", () => {
  it("de-duplicates and keeps order", () => {
    const hints = ruleErrorHints([
      { path: "condition.a.value", code: "LOOKS_LIKE_REGEX" },
      { path: "condition.b.value", code: "LOOKS_LIKE_REGEX" },
      { path: "condition.c.value", code: "PATTERN_WITHOUT_WILDCARD" },
    ]);
    expect(hints).toHaveLength(2);
    expect(hints[0]).toContain("glob, not a regex");
  });

  it("explains what the failed session sent", () => {
    // The model's guesses from the field report, run through the real validator.
    const condition = { operator: "matches", field: "nope" };
    const errors = validateRuleDefinition({
      condition,
      actions: [{ type: "set_category", value: "x" }],
    });
    const hints = ruleErrorHints(errors, {
      condition,
      actions: [{ type: "set_category", value: "x" }],
    });
    expect(errors.map((e) => `${e.path} ${e.code}`)).toEqual([
      "condition.operator UNKNOWN_KEY",
      "condition.field UNKNOWN_FIELD",
      "actions[0].value UNKNOWN_KEY",
      "actions[0].categoryId VALUE_TYPE",
      "actions[0].onlyIfEmpty VALUE_TYPE",
    ]);
    expect(hints.join(" ")).toContain(
      'exactly the keys "field", "op" and "value"',
    );
    expect(hints.join(" ")).toContain("field must be one of:");
    expect(hints.join(" ")).toContain("set_category takes only");
  });
});

describe("RULE_ACTION_TOOL_KEYS", () => {
  it("covers every action type, plus settle_loan_installment, which every save path accepts before it joins the editor's mirrored list", () => {
    expect(Object.keys(RULE_ACTION_TOOL_KEYS).sort()).toEqual(
      [...RULE_ACTION_TYPES, SETTLE_LOAN_INSTALLMENT].sort(),
    );
  });
});
