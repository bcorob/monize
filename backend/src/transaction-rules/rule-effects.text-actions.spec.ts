import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import {
  PayeeResolution,
  PlannableRule,
  RulePlanContext,
  payeeLookupKey,
  planRuleEffects,
} from "./rule-effects";
import { RuleFactsInput, buildRuleFacts } from "./rule-facts";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = uuid(1);
const PAYEE = uuid(2);
const OTHER = uuid(3);

const BANK_TEXT =
  "Przelew. Nazwa odbiorcy: Jan Kowalski Rachunek odbiorcy: 12 3456";
const CONDITION: RuleConditionNode = {
  all: [
    {
      field: "payeeText",
      op: "matches",
      value: "*Nazwa odbiorcy: {payee} Rachunek*",
    },
  ],
};

function facts(over: Partial<RuleFactsInput> = {}) {
  return buildRuleFacts({
    accountId: ACCOUNT,
    currencyCode: "PLN",
    amount: -50,
    isTransfer: false,
    payeeId: null,
    payeeText: BANK_TEXT,
    categoryId: null,
    description: "card payment",
    tagIds: [],
    hasSplits: false,
    ...over,
  });
}

let counter = 0;
function rule(
  actions: RuleAction[],
  over: Partial<PlannableRule> = {},
): PlannableRule {
  counter += 1;
  return {
    id: uuid(100 + counter),
    enabled: true,
    stopProcessing: false,
    condition: CONDITION,
    actions,
    ...over,
  };
}

const fromText = (over: object = {}): RuleAction =>
  ({
    type: "set_payee_from_text",
    template: "{payee}",
    createIfMissing: false,
    onlyIfEmpty: true,
    ...over,
  }) as RuleAction;
const describeAs = (over: object = {}): RuleAction =>
  ({
    type: "set_description",
    template: "{payee}",
    mode: "replace",
    onlyIfEmpty: false,
    ...over,
  }) as RuleAction;

const known = (
  entries: Array<[string, PayeeResolution | null]>,
): RulePlanContext => ({
  payeeResolutions: new Map(
    entries.map(([name, found]) => [payeeLookupKey(name), found]),
  ),
});
const KOWALSKI: PayeeResolution = { payeeId: PAYEE, name: "Jan Kowalski" };

describe("set_payee_from_text", () => {
  it("sets the payee a rendered name resolves to and traces id and name", () => {
    const r = rule([fromText()]);
    const plan = planRuleEffects(
      facts(),
      [r],
      known([["Jan Kowalski", KOWALSKI]]),
    );
    expect(plan.changes).toEqual({
      payeeId: PAYEE,
      payeeName: "Jan Kowalski",
      addTagIds: [],
      removeTagIds: [],
    });
    expect(plan.trace[0].changes).toEqual({
      payeeId: { before: null, after: PAYEE },
      payeeName: { before: null, after: "Jan Kowalski" },
    });
    expect(plan.trace[0].applied).toEqual([{ type: "set_payee_from_text" }]);
    expect(plan.payeeLookups).toBeUndefined();
  });

  it("looks the name up once under any casing", () => {
    const plan = planRuleEffects(
      facts({ payeeText: BANK_TEXT.toUpperCase() }),
      [rule([fromText()])],
    );
    expect(plan.payeeLookups).toEqual(["JAN KOWALSKI"]);
    const again = planRuleEffects(
      facts({ payeeText: BANK_TEXT.toUpperCase() }),
      [rule([fromText()])],
      known([["jan kowalski", KOWALSKI]]),
    );
    expect(again.changes.payeeId).toBe(PAYEE);
  });

  it("waits for a lookup it has not been given: skipped, reported, nothing changed", () => {
    const plan = planRuleEffects(facts(), [rule([fromText()])]);
    expect(plan.payeeLookups).toEqual(["Jan Kowalski"]);
    expect(plan.trace[0].skipped).toEqual([
      { type: "set_payee_from_text", reason: "payee_unresolved" },
    ]);
    expect(plan.changes.payeeId).toBeUndefined();
  });

  it("is skipped as payee_not_found when nobody has the name and createIfMissing is off", () => {
    const plan = planRuleEffects(
      facts(),
      [rule([fromText()])],
      known([["Jan Kowalski", null]]),
    );
    expect(plan.trace[0].skipped).toEqual([
      { type: "set_payee_from_text", reason: "payee_not_found" },
    ]);
    expect(plan.changes.createPayee).toBeUndefined();
    expect(plan.trace[0].changes).toEqual({});
  });

  it("plans a creation with createIfMissing, and says so in the trace", () => {
    const plan = planRuleEffects(
      facts(),
      [rule([fromText({ createIfMissing: true })])],
      known([["Jan Kowalski", null]]),
    );
    expect(plan.changes).toEqual({
      createPayee: "Jan Kowalski",
      payeeName: "Jan Kowalski",
      addTagIds: [],
      removeTagIds: [],
    });
    expect(plan.trace[0].changes).toEqual({
      payeeName: { before: null, after: "Jan Kowalski" },
      payeeCreated: true,
    });
  });

  it("does not create a payee that a later rule replaces", () => {
    const plan = planRuleEffects(
      facts(),
      [
        rule([fromText({ createIfMissing: true })]),
        rule([{ type: "set_payee", payeeId: OTHER, onlyIfEmpty: false }], {
          condition: { all: [] },
        }),
      ],
      known([["Jan Kowalski", null]]),
    );
    expect(plan.changes.createPayee).toBeUndefined();
    expect(plan.changes.payeeId).toBe(OTHER);
    expect(plan.changes.payeeName).toBeUndefined();
  });

  it("onlyIfEmpty leaves an existing payee alone and asks for no lookup", () => {
    const plan = planRuleEffects(facts({ payeeId: OTHER }), [
      rule([fromText()]),
    ]);
    expect(plan.trace[0].skipped).toEqual([
      { type: "set_payee_from_text", reason: "already_set" },
    ]);
    expect(plan.payeeLookups).toBeUndefined();
  });

  it("onlyIfEmpty is off: replaces the payee", () => {
    const plan = planRuleEffects(
      facts({ payeeId: OTHER }),
      [rule([fromText({ onlyIfEmpty: false })])],
      known([["Jan Kowalski", KOWALSKI]]),
    );
    expect(plan.trace[0].changes.payeeId).toEqual({
      before: OTHER,
      after: PAYEE,
    });
  });

  it("onlyIfEmpty counts a payee an earlier rule is about to create as set", () => {
    const plan = planRuleEffects(
      facts(),
      [
        rule([fromText({ createIfMissing: true })]),
        rule([fromText({ template: "Other", createIfMissing: true })], {
          condition: { all: [] },
        }),
      ],
      known([["Jan Kowalski", null]]),
    );
    expect(plan.changes.createPayee).toBe("Jan Kowalski");
    expect(plan.trace[1].skipped[0].reason).toBe("already_set");
  });

  it("no_change when the row already has that payee", () => {
    const plan = planRuleEffects(
      facts({ payeeId: PAYEE }),
      [rule([fromText({ onlyIfEmpty: false })])],
      known([["Jan Kowalski", KOWALSKI]]),
    );
    expect(plan.trace[0].skipped[0].reason).toBe("no_change");
    expect(plan.trace[0].changes).toEqual({});
  });

  it("refuses a name that renders to nothing", () => {
    const plan = planRuleEffects(
      facts({ payeeText: "Nazwa odbiorcy:   Rachunek 1" }),
      [rule([fromText()])],
    );
    expect(plan.trace[0].skipped).toEqual([
      { type: "set_payee_from_text", reason: "empty_render" },
    ]);
    expect(plan.payeeLookups).toBeUndefined();
  });

  it("a later rule creating another name leaves payeeCreated only on the final one", () => {
    const plan = planRuleEffects(
      facts(),
      [
        rule([fromText({ template: "Foo", createIfMissing: true })]),
        rule([
          fromText({
            template: "  bar ",
            createIfMissing: true,
            onlyIfEmpty: false,
          }),
        ]),
      ],
      known([
        ["Foo", null],
        ["bar", null],
      ]),
    );
    expect(plan.changes.createPayee).toBe("bar");
    expect(plan.trace.map((entry) => entry.changes.payeeCreated)).toEqual([
      undefined,
      true,
    ]);
  });

  it("a creation a later rule replaces with an existing payee is not traced as created", () => {
    const plan = planRuleEffects(
      facts(),
      [
        rule([fromText({ createIfMissing: true })]),
        rule([{ type: "set_payee", payeeId: OTHER, onlyIfEmpty: false }]),
      ],
      known([["Jan Kowalski", null]]),
    );
    expect(plan.changes.createPayee).toBeUndefined();
    expect(plan.changes.payeeId).toBe(OTHER);
    expect(plan.trace.some((entry) => entry.changes.payeeCreated)).toBe(false);
  });

  it("refuses on a leg of a cross-owner transfer, before any lookup", () => {
    const plan = planRuleEffects(facts(), [rule([fromText()])], {
      ...known([["Jan Kowalski", KOWALSKI]]),
      crossOwnerTransferLeg: true,
    });
    expect(plan.trace[0].skipped).toEqual([
      { type: "set_payee_from_text", reason: "cross_owner_transfer_leg" },
    ]);
    expect(plan.changes.payeeId).toBeUndefined();
  });

  it("a capture from a branch of any that did not match is empty", () => {
    const r = rule([fromText({ template: "{kept}{gone}" })], {
      condition: {
        any: [
          { field: "description", op: "matches", value: "nomatch {gone}" },
          {
            field: "payeeText",
            op: "matches",
            value: "*odbiorcy: {kept} Rachunek*",
          },
        ],
      },
    });
    const plan = planRuleEffects(facts(), [r]);
    expect(plan.payeeLookups).toEqual(["Jan Kowalski"]);
  });

  it("the template reads {payeeText} and the current {description}", () => {
    const plan = planRuleEffects(facts({ payeeText: "  RAW  " }), [
      rule([fromText({ template: "{payeeText} {description}" })], {
        condition: { all: [] },
      }),
    ]);
    expect(plan.payeeLookups).toEqual(["RAW card payment"]);
  });

  it("a captured value never runs a second template", () => {
    const plan = planRuleEffects(
      facts({ payeeText: "Nazwa odbiorcy: {payeeText} Rachunek" }),
      [rule([fromText()])],
    );
    expect(plan.payeeLookups).toEqual(["{payeeText}"]);
  });

  it("bounds the rendered name to the payee column", () => {
    const plan = planRuleEffects(
      facts({ payeeText: `Nazwa odbiorcy: ${"x".repeat(400)} Rachunek` }),
      [rule([fromText()])],
    );
    expect(plan.payeeLookups?.[0].length).toBeLessThanOrEqual(200);
  });
});

describe("set_description", () => {
  const always = { condition: { all: [] } as RuleConditionNode };

  it("replace writes the rendered text and traces before and after", () => {
    const plan = planRuleEffects(facts(), [rule([describeAs()])]);
    expect(plan.changes.description).toBe("Jan Kowalski");
    expect(plan.trace[0].changes).toEqual({
      description: { before: "card payment", after: "Jan Kowalski" },
    });
    expect(plan.payeeLookups).toBeUndefined();
  });

  it("append and prepend keep the current text, the template carries the separator", () => {
    const append = planRuleEffects(facts(), [
      rule([describeAs({ mode: "append", template: " | {payee}" })]),
    ]);
    expect(append.changes.description).toBe("card payment | Jan Kowalski");
    const prepend = planRuleEffects(facts(), [
      rule([describeAs({ mode: "prepend", template: "{payee}: " })]),
    ]);
    expect(prepend.changes.description).toBe("Jan Kowalski: card payment");
  });

  it("{description} is the current text, after earlier rules", () => {
    const plan = planRuleEffects(facts(), [
      rule([describeAs({ template: "one" })], always),
      rule([describeAs({ template: "[{description}]" })], always),
    ]);
    expect(plan.changes.description).toBe("[one]");
    expect(plan.trace[1].changes.description).toEqual({
      before: "one",
      after: "[one]",
    });
  });

  it("a later rule's condition sees the new description", () => {
    const plan = planRuleEffects(facts(), [
      rule([describeAs({ template: "Allegro order" })], always),
      rule([{ type: "add_tags", tagIds: [OTHER] }], {
        condition: {
          all: [{ field: "description", op: "startsWith", value: "allegro" }],
        },
      }),
    ]);
    expect(plan.changes.addTagIds).toEqual([OTHER]);
  });

  it("onlyIfEmpty writes only into an empty or blank description", () => {
    const kept = planRuleEffects(facts(), [
      rule([describeAs({ onlyIfEmpty: true })]),
    ]);
    expect(kept.trace[0].skipped[0].reason).toBe("already_set");
    for (const description of [null, "", "   "]) {
      const filled = planRuleEffects(facts({ description }), [
        rule([describeAs({ onlyIfEmpty: true })]),
      ]);
      expect(filled.changes.description).toBe("Jan Kowalski");
    }
  });

  it("is refused on a leg of a cross-owner transfer, written on a same-owner one", () => {
    const leg = facts({ isTransfer: true });
    const refused = planRuleEffects(leg, [rule([describeAs()])], {
      crossOwnerTransferLeg: true,
    });
    expect(refused.changes.description).toBeUndefined();
    expect(refused.trace[0].skipped).toEqual([
      { type: "set_description", reason: "cross_owner_transfer_leg" },
    ]);
    const allowed = planRuleEffects(leg, [rule([describeAs()])]);
    expect(allowed.changes.description).toBe("Jan Kowalski");
  });

  it("refuses a blank rendering in replace mode", () => {
    const empty = planRuleEffects(facts({ payeeText: null }), [
      rule([describeAs({ template: "{payeeText}" })], always),
    ]);
    expect(empty.trace[0].skipped).toEqual([
      { type: "set_description", reason: "empty_render" },
    ]);
    expect(empty.changes.description).toBeUndefined();
  });

  it("a blank rendering in append or prepend changes nothing", () => {
    for (const mode of ["append", "prepend"]) {
      const plan = planRuleEffects(facts({ payeeText: null }), [
        rule([describeAs({ mode, template: "{payeeText}" })], always),
      ]);
      expect(plan.changes.description).toBeUndefined();
      expect(plan.trace[0].skipped[0].reason).toBe("empty_render");
    }
  });

  it("no_change when the text is already what the rule writes", () => {
    const plan = planRuleEffects(facts({ description: "same" }), [
      rule([describeAs({ template: "same" })], always),
    ]);
    expect(plan.trace[0].skipped[0].reason).toBe("no_change");
    expect(plan.trace[0].changes).toEqual({});
  });

  it("strips angle brackets and bounds the text to the note length", () => {
    const plan = planRuleEffects(facts(), [
      rule([describeAs({ template: "<b>{payee}</b>" })]),
    ]);
    expect(plan.changes.description).toBe("bJan Kowalski/b");
    const long = planRuleEffects(facts({ description: "a".repeat(740) }), [
      rule([describeAs({ mode: "append", template: "b".repeat(100) })], always),
    ]);
    expect(long.changes.description).toHaveLength(750);
  });
});

describe("the text actions and the rest of the plan", () => {
  it("write nothing but payee, payee name and description", () => {
    const plan = planRuleEffects(
      facts(),
      [rule([fromText(), describeAs()])],
      known([["Jan Kowalski", KOWALSKI]]),
    );
    expect(Object.keys(plan.changes).sort()).toEqual([
      "addTagIds",
      "description",
      "payeeId",
      "payeeName",
      "removeTagIds",
    ]);
    expect(Object.keys(plan.trace[0].changes).sort()).toEqual([
      "description",
      "payeeId",
      "payeeName",
    ]);
  });

  it("captures belong to one rule: another rule cannot use them", () => {
    const first = rule([describeAs()]);
    const second = rule([describeAs({ template: "{payee}" })], {
      condition: { all: [] },
    });
    const plan = planRuleEffects(facts(), [first, second]);
    // The second rule names a capture none of its own leaves defines, so it
    // does not validate and never runs.
    expect(plan.trace[1].skippedRule).toBe("invalid");
    expect(plan.changes.description).toBe("Jan Kowalski");
  });

  it("is deterministic: the same input plans the same", () => {
    const rules = [rule([fromText({ createIfMissing: true }), describeAs()])];
    const context = known([["Jan Kowalski", null]]);
    expect(planRuleEffects(facts(), rules, context)).toEqual(
      planRuleEffects(facts(), rules, context),
    );
  });
});
