import { AccountType } from "../accounts/entities/account.entity";
import { PriorSettlement } from "../loan-installments/loan-settlement.types";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import {
  PlannableRule,
  RulePlanContext,
  planRuleEffects,
} from "./rule-effects";
import { RuleFactsInput, buildRuleFacts } from "./rule-facts";
import {
  INTEREST_CATEGORY,
  LOAN_ACCOUNT,
  LOAN_SCHEDULE,
  SOURCE_ACCOUNT,
  linearLoanAccount,
  linearLoanFacts,
  loanClaim,
  loanFactsByAccount,
  loanFactsEntry,
  settleAction,
} from "./rule-loan-settlement.test-helpers";

/**
 * `settle_loan_installment` in the pure planner
 * (`docs/specs/loan-installment-settlement.md` sections 7 to 11, and section
 * 3.6 of `docs/specs/transaction-rules-structural-actions.md`): the facts
 * lookup, the planned split, every refusal as a skipped action in its order,
 * and what a later rule sees. The figures are spec 9.1's.
 */
const OTHER_CATEGORY = "00000000-0000-4000-8000-0000000000c9";
const TX = "00000000-0000-4000-8000-0000000000f1";

const ACCOUNTS: RulePlanContext["accounts"] = new Map([
  [
    LOAN_ACCOUNT,
    {
      currencyCode: "EUR",
      accountType: AccountType.MORTGAGE,
      interestBookingMode: "AUTO",
    },
  ],
  [SOURCE_ACCOUNT, { currencyCode: "EUR" }],
]);

const ANY: RuleConditionNode = {
  all: [{ field: "payeeText", op: "contains", value: "ING" }],
};

const row = (over: Partial<RuleFactsInput> = {}) =>
  buildRuleFacts({
    accountId: SOURCE_ACCOUNT,
    currencyCode: "EUR",
    amount: -1333.33,
    isTransfer: false,
    payeeId: null,
    payeeText: "ING HYPOTHEKEN",
    categoryId: null,
    description: null,
    tagIds: [],
    hasSplits: false,
    transactionDate: "2024-01-03",
    status: "UNRECONCILED",
    ...over,
  });

const rule = (
  actions: RuleAction[],
  over: Partial<PlannableRule> = {},
): PlannableRule => ({
  id: "r1",
  enabled: true,
  stopProcessing: false,
  condition: ANY,
  actions,
  ...over,
});

const WITH_FACTS: RulePlanContext = {
  accounts: ACCOUNTS,
  loanFacts: loanFactsByAccount(),
};

const plan = (
  input: Partial<RuleFactsInput> = {},
  context: RulePlanContext = WITH_FACTS,
  action: RuleAction = settleAction(),
) => planRuleEffects(row(input), [rule([action])], context);

const skipped = (effects: ReturnType<typeof plan>) =>
  effects.trace.flatMap((t) => t.skipped);

describe("planRuleEffects: settle_loan_installment asks for the loan's facts", () => {
  it("reports one lookup for the row's window and plans nothing until it is answered", () => {
    const effects = plan({}, { accounts: ACCOUNTS, transactionId: TX });
    expect(effects.loanFactsLookups).toEqual([
      {
        loanAccountId: LOAN_ACCOUNT,
        sourceAccountId: SOURCE_ACCOUNT,
        // Row 2024-01-03 with 3 days before and 7 after a slot.
        window: { from: "2023-12-27", to: "2024-01-06" },
        transactionId: TX,
      },
    ]);
    expect(skipped(effects)).toEqual([
      { type: "settle_loan_installment", reason: "loan_facts_unresolved" },
    ]);
    expect(effects.changes.structure).toBeUndefined();
    expect(effects.changes.loanSettlement).toBeUndefined();
  });

  it("asks again when the facts it holds were read over a window that misses the row's", () => {
    const narrow = {
      ...loanFactsEntry(),
      window: { from: "2024-01-01", to: "2024-01-05" },
    };
    const effects = plan(
      {},
      { accounts: ACCOUNTS, loanFacts: loanFactsByAccount(narrow) },
    );
    expect(effects.loanFactsLookups).toHaveLength(1);
  });

  it("asks again when a stored row's id was not among the rows the posted-bill check read", () => {
    const effects = plan({}, { ...WITH_FACTS, transactionId: TX });
    expect(effects.loanFactsLookups?.[0].transactionId).toBe(TX);
    const answered = plan(
      {},
      {
        accounts: ACCOUNTS,
        transactionId: TX,
        loanFacts: loanFactsByAccount(loanFactsEntry(linearLoanFacts(), [TX])),
      },
    );
    expect(answered.loanFactsLookups).toBeUndefined();
    expect(answered.changes.loanSettlement?.dueDate).toBe("2024-01-01");
  });
});

describe("planRuleEffects: settle_loan_installment with the loan's facts", () => {
  it("plans the split of spec 9.1 row L1 and records the settlement beside it", () => {
    const effects = plan({ categoryId: OTHER_CATEGORY });
    const structure = {
      kind: "split",
      parts: [
        {
          amount: -833.33,
          categoryId: null,
          transferAccountId: LOAN_ACCOUNT,
          payeeId: null,
          memo: "Principal",
        },
        {
          amount: -500,
          categoryId: INTEREST_CATEGORY,
          transferAccountId: null,
          payeeId: null,
          memo: "Interest",
        },
      ],
    };
    expect(effects.changes.structure).toEqual(structure);
    // A split has no category of its own.
    expect(effects.changes.categoryId).toBeNull();
    expect(effects.changes.loanSettlement).toMatchObject({
      loanAccountId: LOAN_ACCOUNT,
      scheduledTransactionId: LOAN_SCHEDULE,
      dueDate: "2024-01-01",
      installmentNumber: 1,
      debtBefore: 300000,
      principal: 833.33,
      interest: 500,
      extraPrincipal: 0,
      outcome: "exact",
    });
    expect(effects.loanFactsLookups).toBeUndefined();
    const [entry] = effects.trace;
    expect(entry.applied).toEqual([{ type: "settle_loan_installment" }]);
    expect(entry.changes.structure).toEqual({ before: null, after: structure });
    expect(entry.changes.loanSettlement).toEqual({
      before: null,
      after: {
        loanAccountId: LOAN_ACCOUNT,
        scheduledTransactionId: LOAN_SCHEDULE,
        dueDate: "2024-01-01",
        installmentNumber: 1,
        pricing: expect.objectContaining({
          dueDate: "2024-01-01",
          debtBefore: "300000.0000",
          booked: {
            principal: "833.33",
            interest: "500.00",
            extra: "0.00",
            total: "1333.33",
          },
          lines: { principal: "833.33", interest: "500.00", extra: "0.00" },
          outcome: "exact",
        }),
      },
    });
    // The trace's pricing is the stored record without its version.
    expect(entry.changes.loanSettlement?.after).not.toHaveProperty(
      "pricing.version",
    );
  });

  it("adds the extra-principal line for a row that paid more (spec 9.1 row L3)", () => {
    const effects = plan({ amount: -1533.33 });
    expect(effects.changes.structure).toMatchObject({
      kind: "split",
      parts: [
        { amount: -833.33, transferAccountId: LOAN_ACCOUNT },
        { amount: -500, categoryId: INTEREST_CATEGORY },
        {
          amount: -200,
          transferAccountId: LOAN_ACCOUNT,
          memo: "Extra Principal",
        },
      ],
    });
  });

  it("prices on the debt the settlements planned earlier in the pass leave, and never claims their slot", () => {
    const prior: PriorSettlement = {
      loanAccountId: LOAN_ACCOUNT,
      rowDate: "2024-01-03",
      dueDate: "2024-01-01",
      principal: 833.33,
      extraPrincipal: 0,
    };
    const effects = plan(
      { transactionDate: "2024-02-02" },
      { ...WITH_FACTS, priorSettlements: [prior] },
    );
    // Spec 9.1 row L5: slot 2 after an exact slot 1.
    expect(effects.changes.loanSettlement).toMatchObject({
      dueDate: "2024-02-01",
      debtBefore: 299166.67,
      principal: 833.33,
      interest: 498.61,
    });
    const taken = plan({}, { ...WITH_FACTS, priorSettlements: [prior] });
    expect(skipped(taken)).toEqual([
      {
        type: "settle_loan_installment",
        reason: "occurrence_already_posted",
        detail: { dueDates: ["2024-01-01"] },
      },
    ]);
  });
});

describe("planRuleEffects: settle_loan_installment refusals are skipped actions, in order", () => {
  const reasonOf = (
    input: Partial<RuleFactsInput> = {},
    context: RulePlanContext = WITH_FACTS,
    action: RuleAction = settleAction(),
  ) => {
    const effects = plan(input, context, action);
    expect(effects.changes.structure).toBeUndefined();
    expect(effects.changes.loanSettlement).toBeUndefined();
    return skipped(effects);
  };
  const only = (reason: string, detail?: object) => [
    {
      type: "settle_loan_installment",
      reason,
      ...(detail === undefined ? {} : { detail }),
    },
  ];

  it("1: a row created by an actor who is not the owner", () => {
    expect(
      reasonOf(
        { isTransfer: true },
        { ...WITH_FACTS, structuralNotAllowed: true },
      ),
    ).toEqual(only("structural_not_allowed_for_actor"));
  });

  it("2 to 5: a transfer leg, a split, a void row, a zero amount, each before the next", () => {
    expect(
      reasonOf({ isTransfer: true, hasSplits: true, status: "VOID" }),
    ).toEqual(only("row_is_transfer_leg"));
    expect(reasonOf({ hasSplits: true, status: "VOID" })).toEqual(
      only("row_has_splits"),
    );
    expect(reasonOf({ status: "VOID", amount: 0 })).toEqual(
      only("row_is_void"),
    );
    expect(reasonOf({ amount: 0 })).toEqual(only("zero_amount"));
  });

  it("6 to 8: the row's own account, an account the planner was not given, another currency", () => {
    expect(
      reasonOf({}, WITH_FACTS, settleAction({ loanAccountId: SOURCE_ACCOUNT })),
    ).toEqual(only("transfer_same_account"));
    expect(reasonOf({}, { loanFacts: loanFactsByAccount() })).toEqual(
      only("transfer_account_unavailable"),
    );
    expect(reasonOf({ currencyCode: "PLN" })).toEqual(
      only("transfer_currency_mismatch"),
    );
  });

  it("9: a bill post() created, by the server-set option or by a post claim naming the row", () => {
    expect(
      reasonOf(
        { amount: 1333.33 },
        { ...WITH_FACTS, fromScheduledPosting: true },
      ),
    ).toEqual(only("row_from_scheduled_posting"));
    expect(
      reasonOf(
        {},
        {
          accounts: ACCOUNTS,
          transactionId: TX,
          loanFacts: loanFactsByAccount(
            loanFactsEntry(linearLoanFacts({ postedRowIds: [TX] }), [TX]),
          ),
        },
      ),
    ).toEqual(only("row_from_scheduled_posting"));
  });

  it("10: an income, before anything about the loan", () => {
    const lineOfCredit = new Map([
      [
        LOAN_ACCOUNT,
        { currencyCode: "EUR", accountType: AccountType.LINE_OF_CREDIT },
      ],
    ]);
    expect(reasonOf({ amount: 1333.33 }, { accounts: lineOfCredit })).toEqual(
      only("row_is_income"),
    );
  });

  it("11 and 12: a target that is not a loan, or a loan booking its interest separately, refused without reading the facts", () => {
    const lineOfCredit = plan(
      {},
      {
        accounts: new Map([
          [
            LOAN_ACCOUNT,
            { currencyCode: "EUR", accountType: AccountType.LINE_OF_CREDIT },
          ],
        ]),
      },
    );
    expect(skipped(lineOfCredit)).toEqual(
      only("loan_account_unavailable", { accountType: "LINE_OF_CREDIT" }),
    );
    expect(lineOfCredit.loanFactsLookups).toBeUndefined();

    const separate = plan(
      {},
      {
        accounts: new Map([
          [
            LOAN_ACCOUNT,
            {
              currencyCode: "EUR",
              accountType: AccountType.MORTGAGE,
              interestBookingMode: "SEPARATE",
            },
          ],
        ]),
      },
    );
    expect(skipped(separate)).toEqual(only("loan_interest_booked_separately"));
    expect(separate.loanFactsLookups).toBeUndefined();
  });

  it("11 and 12 from the facts, when the target-account read did not describe the loan", () => {
    const bare = new Map([[LOAN_ACCOUNT, { currencyCode: "EUR" }]]);
    expect(
      reasonOf(
        {},
        {
          accounts: bare,
          loanFacts: loanFactsByAccount(
            loanFactsEntry(
              linearLoanFacts({
                account: linearLoanAccount({ interestBookingMode: "SEPARATE" }),
              }),
            ),
          ),
        },
      ),
    ).toEqual(only("loan_interest_booked_separately"));
    expect(
      reasonOf(
        {},
        {
          accounts: bare,
          loanFacts: loanFactsByAccount(
            loanFactsEntry({ kind: "unavailable", reason: "gone" }),
          ),
        },
      ),
    ).toEqual(only("loan_account_unavailable"));
  });

  it("13 to 19: the loan core's refusals, each naming what is missing or taken", () => {
    expect(
      reasonOf(
        {},
        {
          accounts: ACCOUNTS,
          loanFacts: loanFactsByAccount(
            loanFactsEntry(linearLoanFacts({ schedule: null })),
          ),
        },
      ),
    ).toEqual(only("loan_not_configured", { missing: ["scheduledPayment"] }));
    expect(reasonOf({ transactionDate: "2024-01-20" })).toEqual(
      only("no_installment_in_window", {
        windowFrom: "2024-01-13",
        windowTo: "2024-01-23",
      }),
    );
    expect(
      reasonOf(
        {},
        {
          accounts: ACCOUNTS,
          loanFacts: loanFactsByAccount(
            loanFactsEntry(
              linearLoanFacts({ claims: [loanClaim("2024-01-01")] }),
            ),
          ),
        },
      ),
    ).toEqual(only("occurrence_already_posted", { dueDates: ["2024-01-01"] }));
    // Spec 9.1 row L4 under the default `refuse`.
    expect(reasonOf({ amount: -1300 })).toEqual(
      only("installment_amount_shortfall", {
        dueDate: "2024-01-01",
        expected: 1333.33,
        paid: 1300,
      }),
    );
  });

  it("a row whose date is unknown has no window to match", () => {
    expect(reasonOf({ transactionDate: null })).toEqual(
      only("no_installment_in_window"),
    );
  });
});

describe("planRuleEffects: settle_loan_installment among the other rules (structural spec 3.6)", () => {
  it("a later rule sees the split: its category and structural actions are refused", () => {
    const effects = planRuleEffects(
      row(),
      [
        rule([settleAction()]),
        rule(
          [
            {
              type: "set_category",
              categoryId: OTHER_CATEGORY,
              onlyIfEmpty: false,
            },
          ],
          {
            id: "r2",
          },
        ),
        rule(
          [
            {
              type: "convert_to_transfer",
              toAccountId: LOAN_ACCOUNT,
              clearCategory: true,
            },
          ],
          { id: "r3" },
        ),
      ],
      WITH_FACTS,
    );
    expect(effects.changes.structure?.kind).toBe("split");
    expect(effects.trace[1].skipped).toEqual([
      { type: "set_category", reason: "row_has_splits" },
    ]);
    expect(effects.trace[2].skipped).toEqual([
      { type: "convert_to_transfer", reason: "row_has_splits" },
    ]);
  });

  it("a row an earlier rule split is refused, as for split", () => {
    const effects = planRuleEffects(
      row(),
      [rule([settleAction()]), rule([settleAction()], { id: "r2" })],
      WITH_FACTS,
    );
    expect(effects.trace[1].skipped).toEqual([
      { type: "settle_loan_installment", reason: "row_has_splits" },
    ]);
  });

  it("the active window still wins: a row outside it is never planned or looked up", () => {
    const effects = planRuleEffects(
      row(),
      [rule([settleAction()], { activeFrom: "2024-02-01" })],
      { accounts: ACCOUNTS },
    );
    expect(effects.trace[0].skippedRule).toBe("outside_active_window");
    expect(effects.loanFactsLookups).toBeUndefined();
  });

  it("an actor who is not the owner never causes a facts read", () => {
    const effects = plan(
      {},
      { accounts: ACCOUNTS, structuralNotAllowed: true },
    );
    expect(skipped(effects)).toEqual([
      {
        type: "settle_loan_installment",
        reason: "structural_not_allowed_for_actor",
      },
    ]);
    expect(effects.loanFactsLookups).toBeUndefined();
  });
});
