import { EntityManager, In } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import {
  RuleAction,
  SETTLE_LOAN_INSTALLMENT,
  isStructuralAction,
} from "./rule-action.types";
import { RuleTargetAccounts } from "./rule-structure";

/** Every account id a structural action of `actions` names, each once. */
export function structuralTargetIds(
  rules: readonly { readonly actions: readonly RuleAction[] }[],
): string[] {
  const ids = new Set<string>();
  for (const rule of rules) {
    for (const action of rule.actions) {
      if (!isStructuralAction(action)) continue;
      if (action.type === "convert_to_transfer") {
        for (const id of [action.toAccountId, action.fromAccountId]) {
          if (id !== undefined) ids.add(id);
        }
      } else if (action.type === SETTLE_LOAN_INSTALLMENT) {
        ids.add(action.loanAccountId);
      } else {
        for (const part of action.parts) {
          if (part.transferAccountId !== undefined) {
            ids.add(part.transferAccountId);
          }
        }
      }
    }
  }
  return [...ids];
}

/**
 * The owner's open accounts that a structural action of `rules` targets, by id
 * with their currency, type and interest booking mode, for the planner
 * (`RulePlanContext.accounts`): a `settle_loan_installment` naming an account
 * that is not a loan, or a loan whose interest is booked separately, is
 * refused without reading the loan's facts. One query scoped by `userId`,
 * none when no rule has a structural action. A closed account, or one that is
 * not the owner's, is absent, so the planner refuses it as
 * `transfer_account_unavailable`.
 */
export async function loadRuleTargetAccounts(
  m: EntityManager,
  userId: string,
  rules: readonly { readonly actions: readonly RuleAction[] }[],
): Promise<RuleTargetAccounts> {
  const wanted = structuralTargetIds(rules);
  if (wanted.length === 0) return new Map();
  const rows = await m.getRepository(Account).find({
    select: {
      id: true,
      currencyCode: true,
      accountType: true,
      interestBookingMode: true,
    },
    where: { id: In(wanted), userId, isClosed: false },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        currencyCode: row.currencyCode,
        accountType: row.accountType,
        interestBookingMode: row.interestBookingMode,
      },
    ]),
  );
}
