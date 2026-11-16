import {
  RULE_ACTION_TYPES,
  SETTLE_LOAN_INSTALLMENT,
} from "../../transaction-rules/rule-action.types";
import {
  RULE_ACTIONS_HELP,
  RULE_CONDITION_HELP,
  RULE_LANGUAGE_GUIDE,
} from "./rule-language";

/**
 * The rule language a model is told is one text for both tool surfaces, inside
 * the byte budget (`tools-list-budget.spec.ts`), so a new action must appear
 * in it by name, with the shape it is written in.
 */
describe("the rule language text", () => {
  const all = `${RULE_LANGUAGE_GUIDE} ${RULE_ACTIONS_HELP}`;

  it("names every action type", () => {
    for (const type of RULE_ACTION_TYPES) expect(all).toContain(type);
    expect(all).toContain(SETTLE_LOAN_INSTALLMENT);
  });

  it("names the settle_loan_installment shape in the name form, never with ids", () => {
    expect(all).toContain("loanAccountName");
    expect(all).toContain("interestCategoryName");
    expect(all).not.toContain("loanAccountId");
    expect(all).not.toContain("interestCategoryId");
  });

  it("writes the structural actions in the name form, never with ids", () => {
    expect(all).toContain("toAccountName|fromAccountName");
    expect(all).toContain("transferTo");
    expect(all).toContain('amount:"{capture}"|"rest"');
    expect(all).not.toContain("transferAccountId");
  });

  it("says that the accounts share a currency and the parts add up", () => {
    expect(RULE_ACTIONS_HELP).toContain("same currency");
    expect(RULE_ACTIONS_HELP).toContain("amounts add up");
  });

  it("keeps the per-field help short enough to scan", () => {
    expect(RULE_ACTIONS_HELP.length).toBeLessThanOrEqual(300);
    expect(RULE_CONDITION_HELP.length).toBeLessThanOrEqual(300);
  });
});
