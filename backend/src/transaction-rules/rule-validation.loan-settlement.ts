import { UUID_REGEX } from "../common/query-param-utils";
import {
  LOAN_SETTLEMENT_EXCESS_POLICIES,
  LOAN_SETTLEMENT_SHORTFALL_POLICIES,
} from "./rule-action.types";
import type { RuleValidationCode } from "./rule-validation";
import { MAX_LOAN_SETTLEMENT_WINDOW_DAYS } from "./transaction-rules.limits";
import { isRecord } from "../common/helpers/is-record";

type Sink = (path: string, code: RuleValidationCode) => void;

const SETTLE_KEYS = [
  "type",
  "loanAccountId",
  "dueDateWindow",
  "excess",
  "shortfall",
  "interestCategoryId",
] as const;
const WINDOW_KEYS = ["daysBefore", "daysAfter"] as const;

const hasKey = (o: Record<string, unknown>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

function checkKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  push: Sink,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) push(`${path}.${key}`, "UNKNOWN_KEY");
  }
}

/** A UUID string: `VALUE_TYPE` for a non-string, `INVALID_UUID` for any other string. */
function uuid(value: unknown, path: string, push: Sink): void {
  if (typeof value !== "string") push(path, "VALUE_TYPE");
  else if (!UUID_REGEX.test(value)) push(path, "INVALID_UUID");
}

/** A string from `values`: `VALUE_TYPE` for anything else, `INVALID_ENUM` for an unknown string. */
function oneOf(
  value: unknown,
  values: readonly string[],
  path: string,
  push: Sink,
): void {
  if (typeof value !== "string") push(path, "VALUE_TYPE");
  else if (!values.includes(value)) push(path, "INVALID_ENUM");
}

/**
 * `settle_loan_installment` (`docs/specs/loan-installment-settlement.md`
 * section 5.1): exactly its keys, the loan account a UUID, the window two
 * integers in `0..MAX_LOAN_SETTLEMENT_WINDOW_DAYS`, the two policies from
 * their lists and an optional interest category. The defaults are filled
 * before the validator runs (`withActionDefaults`), so a stored rule carries
 * every one of them (decision 19). Only codes the validator already has are
 * used: the frontend mirrors that list.
 */
export function validateSettleLoanInstallment(
  action: Record<string, unknown>,
  path: string,
  push: Sink,
): void {
  checkKeys(action, SETTLE_KEYS, path, push);
  if (hasKey(action, "loanAccountId")) {
    uuid(action.loanAccountId, `${path}.loanAccountId`, push);
  } else {
    push(`${path}.loanAccountId`, "VALUE_REQUIRED");
  }
  if (hasKey(action, "interestCategoryId")) {
    uuid(action.interestCategoryId, `${path}.interestCategoryId`, push);
  }
  const windowPath = `${path}.dueDateWindow`;
  const window = action.dueDateWindow;
  if (!isRecord(window)) {
    push(windowPath, "INVALID_SHAPE");
  } else {
    checkKeys(window, WINDOW_KEYS, windowPath, push);
    for (const key of WINDOW_KEYS) {
      const days = window[key];
      if (typeof days !== "number") {
        push(`${windowPath}.${key}`, "VALUE_TYPE");
      } else if (
        !Number.isInteger(days) ||
        days < 0 ||
        days > MAX_LOAN_SETTLEMENT_WINDOW_DAYS
      ) {
        push(`${windowPath}.${key}`, "VALUE_OUT_OF_RANGE");
      }
    }
  }
  oneOf(action.excess, LOAN_SETTLEMENT_EXCESS_POLICIES, `${path}.excess`, push);
  oneOf(
    action.shortfall,
    LOAN_SETTLEMENT_SHORTFALL_POLICIES,
    `${path}.shortfall`,
    push,
  );
}
