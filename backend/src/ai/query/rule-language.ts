import { RULE_CONDITION_FIELDS } from "../../transaction-rules/rule-condition.types";
import { MAX_RULE_ACTIONS } from "../../transaction-rules/rule-validation";

/**
 * `ops: field field` for every group of condition fields sharing one operator
 * list, from the table the validator reads. Grouping keeps the list short
 * enough for the description limit clients truncate at.
 */
const RULE_FIELD_OPERATORS = (() => {
  const groups = new Map<string, string[]>();
  for (const [field, spec] of Object.entries(RULE_CONDITION_FIELDS)) {
    const ops = spec.operators.join(",");
    groups.set(ops, [...(groups.get(ops) ?? []), field]);
  }
  return [...groups.entries()]
    .map(([ops, fields]) => `${ops}: ${fields.join(" ")}`)
    .join("; ");
})();

/**
 * How a model writes a rule, contract first: clients truncate a tool
 * description at 2,048 characters, so the exact JSON shape, one complete
 * example, the operators, the action shapes and the glob rules come before
 * anything else, and the per-field detail lives in the `condition` and
 * `actions` field descriptions ({@link RULE_CONDITION_HELP},
 * {@link RULE_ACTIONS_HELP}). One text for both tool surfaces (the assistant's
 * `manage_transaction_rules` and the MCP tool of the same name), so the two
 * cannot describe different languages. `tools-list-budget.spec.ts` holds every
 * MCP description under the limit.
 */
export const RULE_LANGUAGE_GUIDE =
  'Rule JSON: condition is an OBJECT and actions an ARRAY, never strings. Example: condition {"all":[{"field":"description","op":"contains","value":"ASSECO"}]}, actions [{"type":"set_category","categoryName":"Groceries"}]. ' +
  "Groups: all|any (an array), optional not:true, at most 4 deep. Leaf keys exactly field, op, value (none for isEmpty). Ops by field: " +
  RULE_FIELD_OPERATORS +
  ". matches is a glob over the WHOLE text (* wildcard, {name} capture); else it equals the text (eq, or contains). No regex: | \\ and [xy] are literal; for alternatives use an any group. " +
  "actions (1-" +
  MAX_RULE_ACTIONS +
  ', in order) are {type, ...}: set_category(categoryName, onlyIfEmpty?), set_payee(payeeName, onlyIfEmpty?), add_tags|remove_tags(tagNames:[...]), request_ai_review(instruction), set_payee_from_text(template, createIfMissing?, onlyIfEmpty?), set_description(template, mode?: replace|append|prepend, onlyIfEmpty?), convert_to_transfer(see actions), split(payeeName?, parts 2-10: {amount:"{capture}"|"rest", categoryName|transferTo, payeeName?, description?}), settle_loan_installment(loanAccountName, dueDateWindow? {daysBefore,daysAfter}, excess?, shortfall?, interestCategoryName?). ' +
  "activeFrom/activeTo (YYYY-MM-DD, inclusive) bound a rule's dates. " +
  "Test before create: conditionMatchedCount 0 = condition wrong; matchedCount 0 with conditionMatchedCount > 0 = nothing to change.";

/** The `condition` field: what a leaf's value looks like per field. */
export const RULE_CONDITION_HELP =
  "Names for account/payee/category ('Parent: Child')/tag; a list for in/notIn/has*; between [min,max]; amount signed, absAmount unsigned; hasSplits/hasAttachment true|false; type EXPENSE|INCOME|TRANSFER; weekday MON..SUN; dayOfMonth 1-31; date YYYY-MM-DD; status UNRECONCILED|CLEARED|RECONCILED|VOID.";

/** The `actions` field: what the guide leaves out. */
export const RULE_ACTIONS_HELP =
  "Names, never ids. Templates read {name} (capture), {payeeText}, {description}. onlyIfEmpty defaults true (false: set_description). convert_to_transfer(toAccountName|fromAccountName, clearCategory?, payeeName?); transfer/split parts: same currency, amounts add up. settle_loan_installment: no amount.";
