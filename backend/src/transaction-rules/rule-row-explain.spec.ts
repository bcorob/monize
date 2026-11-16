import { RuleTraceChanges, RuleTraceEntry } from "./rule-effects";
import { RuleConditionExplanation } from "./rule-condition.explain";
import {
  EXPLAIN_CHANGES_MAX_DEPTH,
  EXPLAIN_CHANGES_MAX_IDS,
  ExplainedRule,
  explainedIds,
} from "./rule-row-explain";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A trace change as a structural action's plan would write it; not yet in `RuleTraceChanges`. */
const asChanges = (changes: Record<string, unknown>): RuleTraceChanges =>
  changes as unknown as RuleTraceChanges;

function explained(
  changes: RuleTraceChanges | undefined,
  condition: RuleConditionExplanation | null = null,
): ExplainedRule {
  const effects: RuleTraceEntry | null =
    changes === undefined
      ? null
      : {
          ruleId: uuid(900),
          matched: true,
          applied: [],
          skipped: [],
          changes,
          stopped: false,
        };
  return {
    ruleId: uuid(900),
    ruleName: "rule",
    enabled: true,
    position: 0,
    evaluated: condition !== null || effects !== null,
    matched: true,
    condition,
    effects,
    stopped: false,
  };
}

describe("explainedIds", () => {
  const sorted = (ids: readonly string[]): string[] => [...ids].sort();

  it("collects the ids of the ledger fields' before and after sides", () => {
    const ids = explainedIds([
      explained({
        categoryId: { before: uuid(1), after: uuid(2) },
        payeeId: { before: null, after: uuid(3) },
        tagIds: { before: [uuid(4)], after: [uuid(4), uuid(5)] },
      }),
    ]);
    expect(sorted(ids.categoryIds)).toEqual([uuid(1), uuid(2)]);
    expect(ids.payeeIds).toEqual([uuid(3)]);
    expect(sorted(ids.tagIds)).toEqual([uuid(4), uuid(5)]);
    expect(ids.accountIds).toEqual([]);
  });

  it("collects the ids a split plan carries, parts and all", () => {
    const ids = explainedIds([
      explained(
        asChanges({
          structure: {
            kind: "split",
            parts: [
              {
                transferAccountId: uuid(10),
                categoryId: null,
                amount: "-10.0000",
              },
              { categoryId: uuid(11), payeeId: uuid(12), tagIds: [uuid(13)] },
            ],
          },
        }),
      ),
    ]);
    expect(ids.accountIds).toEqual([uuid(10)]);
    expect(ids.categoryIds).toEqual([uuid(11)]);
    expect(ids.payeeIds).toEqual([uuid(12)]);
    expect(ids.tagIds).toEqual([uuid(13)]);
  });

  it("collects the account of a transfer plan and any key ending in AccountId", () => {
    const ids = explainedIds([
      explained(
        asChanges({
          structure: {
            kind: "transfer",
            accountId: uuid(20),
            sourceAccountId: uuid(21),
            fallbackCategoryId: uuid(22),
            defaultPayeeId: uuid(23),
          },
        }),
      ),
    ]);
    expect(sorted(ids.accountIds)).toEqual([uuid(20), uuid(21)]);
    expect(ids.categoryIds).toEqual([uuid(22)]);
    expect(ids.payeeIds).toEqual([uuid(23)]);
  });

  it("includes both sides of a before/after wrapper around a nested id, and a single tagId string", () => {
    const ids = explainedIds([
      explained(
        asChanges({
          accountId: { before: uuid(30), after: uuid(31) },
          tagId: uuid(32),
        }),
      ),
    ]);
    expect(sorted(ids.accountIds)).toEqual([uuid(30), uuid(31)]);
    expect(ids.tagIds).toEqual([uuid(32)]);
  });

  it("ignores strings that are not UUIDs, and ids under keys that name nothing", () => {
    const ids = explainedIds([
      explained(
        asChanges({
          categoryId: { before: "not-a-uuid", after: uuid(40) },
          description: { before: uuid(41), after: "text" },
          structure: { parts: [{ transferAccountId: "deleted item" }] },
          tagIds: { before: ["x"], after: [] },
        }),
      ),
    ]);
    expect(ids).toEqual({
      accountIds: [],
      payeeIds: [],
      categoryIds: [uuid(40)],
      tagIds: [],
    });
  });

  it("ignores non-string values under an id key", () => {
    const ids = explainedIds([
      explained(
        asChanges({
          structure: { accountId: 5, categoryId: true, payeeId: null },
        }),
      ),
    ]);
    expect(ids).toEqual({
      accountIds: [],
      payeeIds: [],
      categoryIds: [],
      tagIds: [],
    });
  });

  it("ignores an id nested deeper than the bound and reads one at the bound", () => {
    const nest = (levels: number, leaf: Record<string, unknown>): unknown => {
      let node: unknown = leaf;
      for (let i = 0; i < levels; i++) node = { next: node };
      return node;
    };
    // `changes` is depth 0; each wrapper is one more container, and the id key's
    // string value sits one level below the object that holds the key.
    const reached = EXPLAIN_CHANGES_MAX_DEPTH - 2;
    const ok = explainedIds([
      explained(asChanges({ n: nest(reached, { accountId: uuid(50) }) })),
    ]);
    expect(ok.accountIds).toEqual([uuid(50)]);

    const tooDeep = explainedIds([
      explained(
        asChanges({
          n: nest(EXPLAIN_CHANGES_MAX_DEPTH + 2, { accountId: uuid(51) }),
        }),
      ),
    ]);
    expect(tooDeep.accountIds).toEqual([]);
  });

  it("stops collecting at the bound on the number of ids", () => {
    const many = Array.from({ length: EXPLAIN_CHANGES_MAX_IDS + 50 }, (_, i) =>
      uuid(1000 + i),
    );
    const ids = explainedIds([
      explained(asChanges({ tagIds: { before: [], after: many } })),
    ]);
    expect(ids.tagIds).toHaveLength(EXPLAIN_CHANGES_MAX_IDS);
  });

  it("reads a rule that has no effects and keeps collecting the condition leaves", () => {
    const condition: RuleConditionExplanation = {
      kind: "all",
      result: true,
      children: [
        {
          kind: "leaf",
          field: "accountId",
          operator: "eq",
          expected: uuid(60),
          actual: uuid(61),
          result: false,
        },
        {
          kind: "leaf",
          field: "tagIds",
          operator: "hasAny",
          expected: [uuid(62)],
          actual: [uuid(63)],
          result: true,
        },
      ],
    };
    const ids = explainedIds([explained(undefined, condition)]);
    expect(sorted(ids.accountIds)).toEqual([uuid(60), uuid(61)]);
    expect(sorted(ids.tagIds)).toEqual([uuid(62), uuid(63)]);
    expect(ids.payeeIds).toEqual([]);
    expect(ids.categoryIds).toEqual([]);
  });

  it("deduplicates an id mentioned by several rules", () => {
    const ids = explainedIds([
      explained(asChanges({ categoryId: { before: null, after: uuid(70) } })),
      explained(asChanges({ categoryId: { before: uuid(70), after: null } })),
    ]);
    expect(ids.categoryIds).toEqual([uuid(70)]);
  });
});
