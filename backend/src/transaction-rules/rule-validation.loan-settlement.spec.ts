import { RuleAction } from "./rule-action.types";
import { referenceErrors, withActionDefaults } from "./rule-references";
import { validateRuleDefinition } from "./rule-validation";
import { MAX_LOAN_SETTLEMENT_WINDOW_DAYS } from "./transaction-rules.limits";

/**
 * `settle_loan_installment` validation
 * (`docs/specs/loan-installment-settlement.md` section 5.1): exact keys,
 * UUIDs, the window's integer range, the two policies, the defaults written
 * on save, and the structural-action rules of
 * `docs/specs/transaction-rules-structural-actions.md` section 3.6.
 */
const LOAN = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const COND = {
  all: [{ field: "payeeText", op: "matches", value: "*{principal} *" }],
};

const SETTLE = {
  type: "settle_loan_installment",
  loanAccountId: LOAN,
  dueDateWindow: { daysBefore: 3, daysAfter: 7 },
  excess: "extra_principal",
  shortfall: "refuse",
};

const check = (...actions: unknown[]) =>
  validateRuleDefinition({ condition: COND, actions }, { authoring: true });

const settle = (over: Record<string, unknown> = {}) => ({ ...SETTLE, ...over });

describe("validateRuleDefinition: settle_loan_installment", () => {
  it("accepts the full shape, with and without an interest category", () => {
    expect(check(settle())).toEqual([]);
    expect(check(settle({ interestCategoryId: CAT }))).toEqual([]);
    expect(
      check(
        settle({
          excess: "refuse",
          shortfall: "interest_first",
          dueDateWindow: { daysBefore: 0, daysAfter: 0 },
        }),
      ),
    ).toEqual([]);
  });

  it("writes every default on save, so a stored rule never relies on one", () => {
    const [stored] = withActionDefaults([
      { type: "settle_loan_installment", loanAccountId: LOAN },
    ]) as Array<Record<string, unknown>>;
    expect(stored).toEqual(SETTLE);
    expect(check(stored)).toEqual([]);
    // A value the caller set is kept.
    const [kept] = withActionDefaults([
      settle({
        excess: "refuse",
        dueDateWindow: { daysBefore: 1, daysAfter: 2 },
      }),
    ]) as Array<Record<string, unknown>>;
    expect(kept).toMatchObject({
      excess: "refuse",
      shortfall: "refuse",
      dueDateWindow: { daysBefore: 1, daysAfter: 2 },
    });
  });

  it("refuses an unknown key, at the action and in the window", () => {
    expect(check(settle({ amount: 100 }))).toEqual([
      { path: "actions[0].amount", code: "UNKNOWN_KEY" },
    ]);
    expect(
      check(
        settle({ dueDateWindow: { daysBefore: 3, daysAfter: 7, days: 1 } }),
      ),
    ).toEqual([{ path: "actions[0].dueDateWindow.days", code: "UNKNOWN_KEY" }]);
  });

  it("needs the loan account as a UUID; the interest category is optional but a UUID", () => {
    const { loanAccountId: _loan, ...withoutLoan } = SETTLE;
    expect(check(withoutLoan)).toEqual([
      { path: "actions[0].loanAccountId", code: "VALUE_REQUIRED" },
    ]);
    expect(check(settle({ loanAccountId: "loan" }))).toEqual([
      { path: "actions[0].loanAccountId", code: "INVALID_UUID" },
    ]);
    expect(check(settle({ loanAccountId: 7 }))).toEqual([
      { path: "actions[0].loanAccountId", code: "VALUE_TYPE" },
    ]);
    expect(check(settle({ interestCategoryId: "interest" }))).toEqual([
      { path: "actions[0].interestCategoryId", code: "INVALID_UUID" },
    ]);
  });

  it(`takes whole days 0..${MAX_LOAN_SETTLEMENT_WINDOW_DAYS} on each side of the window`, () => {
    const window = (daysBefore: unknown, daysAfter: unknown) =>
      check(settle({ dueDateWindow: { daysBefore, daysAfter } }));
    expect(
      window(MAX_LOAN_SETTLEMENT_WINDOW_DAYS, MAX_LOAN_SETTLEMENT_WINDOW_DAYS),
    ).toEqual([]);
    for (const bad of [-1, MAX_LOAN_SETTLEMENT_WINDOW_DAYS + 1, 1.5, NaN]) {
      expect(window(bad, 7)).toEqual([
        {
          path: "actions[0].dueDateWindow.daysBefore",
          code: "VALUE_OUT_OF_RANGE",
        },
      ]);
      expect(window(3, bad)).toEqual([
        {
          path: "actions[0].dueDateWindow.daysAfter",
          code: "VALUE_OUT_OF_RANGE",
        },
      ]);
    }
    expect(window("3", undefined)).toEqual([
      { path: "actions[0].dueDateWindow.daysBefore", code: "VALUE_TYPE" },
      { path: "actions[0].dueDateWindow.daysAfter", code: "VALUE_TYPE" },
    ]);
    for (const shape of [null, [3, 7], "3/7"]) {
      expect(check(settle({ dueDateWindow: shape }))).toEqual([
        { path: "actions[0].dueDateWindow", code: "INVALID_SHAPE" },
      ]);
    }
  });

  it("takes the policies from their lists", () => {
    expect(check(settle({ excess: "interest_first" }))).toEqual([
      { path: "actions[0].excess", code: "INVALID_ENUM" },
    ]);
    expect(check(settle({ shortfall: "extra_principal" }))).toEqual([
      { path: "actions[0].shortfall", code: "INVALID_ENUM" },
    ]);
    expect(check(settle({ excess: true, shortfall: null }))).toEqual([
      { path: "actions[0].excess", code: "VALUE_TYPE" },
      { path: "actions[0].shortfall", code: "VALUE_TYPE" },
    ]);
  });

  it("is a structural action: one per rule (DUPLICATE_ACTION beside a split or a conversion)", () => {
    const split = {
      type: "split",
      parts: [
        { amount: "{principal}", transferAccountId: LOAN },
        { amount: "rest", categoryId: CAT },
      ],
    };
    expect(check(split, settle())).toEqual([
      { path: "actions[1]", code: "DUPLICATE_ACTION" },
    ]);
    expect(check(settle(), split)).toEqual([
      { path: "actions[1]", code: "DUPLICATE_ACTION" },
    ]);
    expect(
      check(settle(), {
        type: "convert_to_transfer",
        toAccountId: OTHER,
        clearCategory: true,
      }),
    ).toEqual([{ path: "actions[1]", code: "DUPLICATE_ACTION" }]);
    expect(check(settle(), settle())).toEqual([
      { path: "actions[1]", code: "DUPLICATE_ACTION" },
    ]);
  });

  it("conflicts with set_category (CONFLICTING_ACTIONS on the settlement), and sits beside the text and tag actions", () => {
    expect(
      check(
        { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
        settle(),
      ),
    ).toEqual([{ path: "actions[1]", code: "CONFLICTING_ACTIONS" }]);
    expect(
      check(
        settle(),
        { type: "add_tags", tagIds: [OTHER] },
        {
          type: "set_description",
          template: "Hypotheek",
          mode: "replace",
          onlyIfEmpty: false,
        },
      ),
    ).toEqual([]);
  });
});

describe("referenceErrors: settle_loan_installment", () => {
  const definition = (over: Record<string, unknown> = {}) => ({
    condition: COND as never,
    actions: [settle(over) as unknown as RuleAction],
  });
  const none = { accountIds: [], payeeIds: [], categoryIds: [], tagIds: [] };

  it("points at the action when the loan account or the interest category is not the owner's", () => {
    expect(
      referenceErrors(definition(), { ...none, accountIds: [LOAN] }),
    ).toEqual([{ path: "actions[0]", code: "REFERENCE_NOT_FOUND" }]);
    expect(
      referenceErrors(definition({ interestCategoryId: CAT }), {
        ...none,
        categoryIds: [CAT],
      }),
    ).toEqual([{ path: "actions[0]", code: "REFERENCE_NOT_FOUND" }]);
    expect(
      referenceErrors(definition({ interestCategoryId: CAT }), none),
    ).toEqual([]);
  });
});
