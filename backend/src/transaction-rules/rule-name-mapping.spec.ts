import { RuleDefinitionLabels } from "./rule-labels";
import {
  NameLookup,
  collectNamedReferences,
  idsToNames,
  namesToIds,
} from "./rule-name-mapping";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { MAX_RULE_CONDITION_NODES } from "./rule-validation";

const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
const PAYEE = "b0000000-0000-4000-8000-000000000002";
const CATEGORY = "c0000000-0000-4000-8000-000000000003";
const TAG = "d0000000-0000-4000-8000-000000000004";

const IDS: Record<string, string> = {
  Checking: ACCOUNT,
  Netflix: PAYEE,
  "Bills: Streaming": CATEGORY,
  Subscriptions: TAG,
};

const lookup: NameLookup = (_kind, name) =>
  IDS[name]
    ? { id: IDS[name] }
    : name === "Cell Phone"
      ? { failure: "NAME_AMBIGUOUS", suggestions: ["Bills: Cell Phone"] }
      : { failure: "NAME_NOT_FOUND" };

const LABELS: RuleDefinitionLabels = {
  accounts: { [ACCOUNT]: "Checking" },
  payees: { [PAYEE]: "Netflix" },
  categories: { [CATEGORY]: "Bills: Streaming" },
  tags: { [TAG]: "Subscriptions" },
};

const namedCondition = {
  all: [
    { field: "accountId", op: "eq", value: "Checking" },
    {
      any: [
        { field: "payeeId", op: "in", value: ["Netflix"] },
        { field: "description", op: "contains", value: "Netflix" },
      ],
    },
    { field: "tagIds", op: "hasAny", value: ["Subscriptions"] },
    { field: "amount", op: "lt", value: 0 },
  ],
};

const namedActions = [
  { type: "set_category", categoryName: "Bills: Streaming" },
  { type: "set_payee", payeeName: "Netflix", onlyIfEmpty: false },
  { type: "add_tags", tagNames: ["Subscriptions"] },
  { type: "request_ai_review", instruction: "check the receipt" },
];

describe("rule name mapping", () => {
  it("collects each distinct name once, per kind", () => {
    const refs = collectNamedReferences(namedCondition, [
      ...namedActions,
      { type: "add_tags", tagNames: ["Subscriptions", "Other"] },
    ]);
    expect(refs).toEqual({
      accounts: ["Checking"],
      payees: ["Netflix"],
      categories: ["Bills: Streaming"],
      tags: ["Subscriptions", "Other"],
    });
  });

  it("does not take the value of a text or money leaf for a name", () => {
    const refs = collectNamedReferences(
      { field: "description", op: "eq", value: "Checking" },
      [],
    );
    expect(refs.accounts).toEqual([]);
  });

  it("replaces names with ids in a condition and in actions", () => {
    const mapped = namesToIds(namedCondition, namedActions, lookup);
    expect(mapped.errors).toEqual([]);
    expect(mapped.condition).toEqual({
      all: [
        { field: "accountId", op: "eq", value: ACCOUNT },
        {
          any: [
            { field: "payeeId", op: "in", value: [PAYEE] },
            { field: "description", op: "contains", value: "Netflix" },
          ],
        },
        { field: "tagIds", op: "hasAny", value: [TAG] },
        { field: "amount", op: "lt", value: 0 },
      ],
    });
    expect(mapped.actions).toEqual([
      { type: "set_category", categoryId: CATEGORY },
      { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: false },
      { type: "add_tags", tagIds: [TAG] },
      { type: "request_ai_review", instruction: "check the receipt" },
    ]);
  });

  it("reports a name that did not resolve at its path, with the kind and suggestions", () => {
    const mapped = namesToIds(
      { all: [{ field: "payeeId", op: "in", value: ["Netflix", "Nope"] }] },
      [
        { type: "set_category", categoryName: "Cell Phone" },
        { type: "add_tags", tagNames: ["Missing"] },
      ],
      lookup,
    );
    expect(mapped.errors).toEqual([
      {
        path: "condition.all[0].value[1]",
        code: "NAME_NOT_FOUND",
        name: "Nope",
        kind: "payees",
      },
      {
        path: "actions[0].categoryName",
        code: "NAME_AMBIGUOUS",
        name: "Cell Phone",
        kind: "categories",
        suggestions: ["Bills: Cell Phone"],
      },
      {
        path: "actions[1].tagNames[0]",
        code: "NAME_NOT_FOUND",
        name: "Missing",
        kind: "tags",
      },
    ]);
  });

  it("leaves a shape it cannot read for the validator", () => {
    const mapped = namesToIds(
      "nonsense",
      [null, { type: "unknown" }, { type: "set_category" }],
      lookup,
    );
    expect(mapped.errors).toEqual([]);
    expect(mapped.condition).toBe("nonsense");
    expect(mapped.actions).toEqual([
      null,
      { type: "unknown" },
      { type: "set_category" },
    ]);
  });

  it("does not follow a tree past the validator's node limit", () => {
    const leaf = { field: "accountId", op: "eq", value: "Checking" };
    const wide = { all: Array.from({ length: 500 }, () => leaf) };
    const refs = collectNamedReferences(wide, []);
    expect(refs.accounts).toEqual(["Checking"]);
    const mapped = namesToIds(wide, [], lookup);
    const converted = (mapped.condition as { all: { value: string }[] }).all;
    expect(converted.filter((l) => l.value === ACCOUNT).length).toBe(
      MAX_RULE_CONDITION_NODES - 1,
    );
    expect(converted.filter((l) => l.value === "Checking").length).toBe(
      500 - (MAX_RULE_CONDITION_NODES - 1),
    );
  });

  it("round-trips a stored definition through names and back", () => {
    const stored = namesToIds(namedCondition, namedActions, lookup);
    const definition = {
      condition: stored.condition as RuleConditionNode,
      actions: stored.actions as RuleAction[],
    };
    const named = idsToNames(definition, LABELS);
    expect(named.condition).toEqual(namedCondition);
    expect(named.actions).toEqual(namedActions);
    const again = namesToIds(named.condition, named.actions, lookup);
    expect(again.errors).toEqual([]);
    expect(again.condition).toEqual(definition.condition);
    expect(again.actions).toEqual(definition.actions);
  });

  it("keeps an id that has no label instead of hiding that something is there", () => {
    const named = idsToNames(
      {
        condition: { field: "payeeId", op: "eq", value: PAYEE },
        actions: [{ type: "add_tags", tagIds: [TAG] }],
      },
      { accounts: {}, payees: {}, categories: {}, tags: {} },
    );
    expect(named.condition).toEqual({
      field: "payeeId",
      op: "eq",
      value: PAYEE,
    });
    expect(named.actions).toEqual([{ type: "add_tags", tagNames: [TAG] }]);
  });
});
