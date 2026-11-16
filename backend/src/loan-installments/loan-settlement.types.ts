import { MortgageType, PrepaymentMode } from "../accounts/mortgage-type.util";
import { currencyMinorUnitDecimals } from "../common/currency-minor-unit.util";

/**
 * The shapes the settlement of an imported bank debit against a scheduled loan
 * installment is planned and recorded in (`docs/specs/loan-installment-settlement.md`,
 * sections 5, 8, 10 and 11). Pure data: the planner (`plan-loan-settlement.ts`)
 * produces them, the rules engine (B4, B5 of
 * `docs/specs/loan-installment-settlement.md`) carries them to
 * the trace, the fingerprint and the claim's `pricing` column.
 *
 * Nothing here imports a service: this module is part of the neutral loan core
 * (`loan-core-imports.guard.spec.ts`).
 */

/**
 * The tolerance within which the interest line absorbs the difference between
 * what the bank debited and what the engine priced, in minor units of the
 * account's currency (0.05 EUR, 5 JPY, 0.005 KWD). Spec section 8 says why
 * five: it covers two independent roundings of one installment and sits far
 * below any real payment change.
 */
export const LOAN_SETTLEMENT_TOLERANCE_MINOR_UNITS = 5;

/** What a row that paid more than the priced installment becomes (spec decision 2). */
export type LoanSettlementExcessPolicy = "extra_principal" | "refuse";

/** What a row that paid less than the base installment becomes (spec decision 2). */
export type LoanSettlementShortfallPolicy = "refuse" | "interest_first";

export interface LoanSettlementPolicy {
  readonly excess: LoanSettlementExcessPolicy;
  readonly shortfall: LoanSettlementShortfallPolicy;
}

/** `[t - daysAfter, t + daysBefore]` around a row dated `t`, inclusive (spec section 2). */
export interface LoanSettlementWindow {
  readonly daysBefore: number;
  readonly daysAfter: number;
}

/**
 * The fields of a stored `settle_loan_installment` action the planner reads
 * (spec section 5.1). Defaults are written on save (decision 19), so every
 * field is present here; the rules engine's own action type (B4) extends this
 * with `type`.
 */
export interface LoanSettlementAction extends LoanSettlementPolicy {
  readonly loanAccountId: string;
  readonly dueDateWindow: LoanSettlementWindow;
  /** The interest line's category; absent means the loan's `interest_category_id`. */
  readonly interestCategoryId?: string | null;
}

/**
 * How the installment was priced: the mortgage type for a `MORTGAGE`
 * (`mortgageTypeOf(account)`, which fixes both the compounding and the
 * amortization method) and `LOAN` for a `LOAN` account (an annuity at the
 * nominal rate).
 */
export type LoanSettlementMethod = MortgageType | "LOAN";

/** Which row of the amount-policy table (spec section 8) decided the lines. */
export type LoanSettlementOutcome =
  "exact" | "tolerance" | "extra_principal" | "extra_shed" | "interest_first";

/** The three parts of an installment and their sum, at one precision. */
export interface LoanSettlementParts {
  readonly principal: number;
  readonly interest: number;
  readonly extra: number;
  readonly total: number;
}

/**
 * A planned settlement: the slot, what the installment was priced on, what it
 * came to and which lines the split carries. Every money figure is a number
 * at the precision its comment states; `pricingColumn` turns it into the
 * stored record (spec section 5.3), where money is a string.
 */
export interface LoanSettlementPlan {
  readonly loanAccountId: string;
  readonly scheduledTransactionId: string;
  /** The matched slot, `YYYY-MM-DD`: the claim key (`original_due_date`). */
  readonly dueDate: string;
  /** The slot's ordinal on the loan's calendar (the first slot = 1). */
  readonly installmentNumber: number;
  readonly method: LoanSettlementMethod;
  /** Only a `LINEAR` mortgage has one; null for every other method. */
  readonly prepaymentMode: PrepaymentMode | null;
  readonly currencyCode: string;
  /** `datedLoanDebt` at the slot, 4dp. */
  readonly debtLedger: number;
  /** The principal and extra principal of the settlements planned earlier in the pass and dated on or before the slot, 4dp. */
  readonly foldedPrincipal: number;
  /** `debtLedger - foldedPrincipal`, the debt the installment was priced on, 4dp. */
  readonly debtBefore: number;
  /** The annual rate in percent that applies at the slot. */
  readonly annualRate: number;
  /** The per-period rate the interest was multiplied by. */
  readonly periodicRate: number;
  /** The installment at storage precision (4dp), before booking. */
  readonly priced: LoanSettlementParts;
  /** The installment as the bank books it, in the currency's unit: `P`, `I`, `E`, `T`. */
  readonly booked: LoanSettlementParts;
  /** `abs(row.amount)`, 4dp. */
  readonly paid: number;
  /** `paid - booked.total`, 4dp. */
  readonly difference: number;
  readonly outcome: LoanSettlementOutcome;
  /** The written principal line, in the currency's unit (unsigned). */
  readonly principal: number;
  /** The written interest line, in the currency's unit (unsigned). */
  readonly interest: number;
  /** The written extra-principal line, in the currency's unit (unsigned); 0 when there is none. */
  readonly extraPrincipal: number;
  /** The signed amount the interest line absorbed under the tolerance (rows 2 and 7 of the table); 0 otherwise. */
  readonly toleranceApplied: number;
  readonly policy: LoanSettlementPolicy;
  /** True when the slot is the schedule's `next_due_date`, so the write advances the cursor (spec section 12.3). */
  readonly advancesCursor: boolean;
}

/**
 * A settlement planned earlier in the same pass and not yet written (spec
 * section 7.2). The fold subtracts its principal from the ledger debt of every
 * later row on the same loan whose slot is on or after `rowDate`, and treats
 * its `dueDate` as claimed.
 */
export interface PriorSettlement {
  readonly loanAccountId: string;
  /** The prior row's date: its counterpart leg is dated here. */
  readonly rowDate: string;
  /** The slot the prior settlement claims. */
  readonly dueDate: string;
  /** The written principal line, in the currency's unit. */
  readonly principal: number;
  /** The written extra-principal line, in the currency's unit. */
  readonly extraPrincipal: number;
}

/** The static or dated input a refusal names as missing (spec section 10). */
export type LoanSettlementMissingInput =
  | "scheduledPayment"
  | "managedTemplate"
  | "scheduleCalendar"
  | "interestCategory"
  | "amortizationMonths"
  | "paymentStartDate"
  | "paymentFrequency"
  | "originalPrincipal"
  | "rate"
  | "payment";

/**
 * Why the planner refused, in the order the reasons are checked (spec section
 * 11). The first three are shared structural refusals the planner can decide
 * from its own inputs (the rules engine also checks them, with the ones it
 * alone can see, before calling the planner); the rest are the settlement's.
 */
export type LoanSettlementRefusalReason =
  | "zero_amount"
  | "transfer_same_account"
  | "transfer_currency_mismatch"
  | "row_from_scheduled_posting"
  | "row_is_income"
  | "loan_account_unavailable"
  | "loan_interest_booked_separately"
  | "loan_not_configured"
  | "no_installment_in_window"
  | "occurrence_already_posted"
  | "loan_debt_retired"
  | "installment_amount_excess"
  | "installment_amount_shortfall";

/** What a refusal names, so the reader knows what to set or which slot is taken (spec decision 18). */
export interface LoanSettlementRefusalDetail {
  readonly accountType?: string;
  readonly missing?: readonly LoanSettlementMissingInput[];
  readonly dueDate?: string;
  readonly windowFrom?: string;
  readonly windowTo?: string;
  /** The slots in the window, every one claimed or planned earlier in the pass. */
  readonly dueDates?: readonly string[];
  /** The priced total `T`, in the currency's unit. */
  readonly expected?: number;
  readonly paid?: number;
  readonly debtBefore?: number;
}

export interface LoanSettlementRefusal {
  readonly ok: false;
  readonly reason: LoanSettlementRefusalReason;
  readonly detail?: LoanSettlementRefusalDetail;
}

/**
 * One line of the split a settlement plans. Structurally the rules engine's
 * `SplitStructurePart` (`backend/src/transaction-rules/rule-structure.ts`),
 * restated here because the core may not import the engine; `amount` is
 * signed like the row, 4dp.
 */
export interface LoanSettlementSplitPart {
  readonly amount: number;
  readonly categoryId: string | null;
  readonly transferAccountId: string | null;
  readonly payeeId: string | null;
  readonly memo: string | null;
}

/** The split structure a settlement plans, assignable to the engine's `SplitStructurePlan`. */
export interface LoanSettlementSplitPlan {
  readonly kind: "split";
  readonly parts: readonly LoanSettlementSplitPart[];
}

/** The memos the settlement writes: the ones `LoanPaymentSetupService` writes and `identifyLoanTemplate` reads lines by (spec decision 15). */
export const LOAN_SETTLEMENT_MEMOS = Object.freeze({
  principal: "Principal",
  interest: "Interest",
  extraPrincipal: "Extra Principal",
});

/**
 * The stored `pricing` record (spec section 5.3). Money is a string so JSON
 * never rounds it: the ledger and priced figures at 4dp, the booked, paid and
 * written figures at the currency's unit. `periodicRate` is the double the
 * interest was multiplied by.
 */
export interface LoanSettlementPricingRecord {
  readonly version: 1;
  readonly dueDate: string;
  readonly installmentNumber: number;
  readonly method: LoanSettlementMethod;
  readonly prepaymentMode: PrepaymentMode | null;
  readonly currencyCode: string;
  readonly debtLedger: string;
  readonly foldedPrincipal: string;
  readonly debtBefore: string;
  readonly annualRate: string;
  readonly periodicRate: number;
  readonly priced: {
    readonly principal: string;
    readonly interest: string;
    readonly extra: string;
    readonly total: string;
  };
  readonly booked: {
    readonly principal: string;
    readonly interest: string;
    readonly extra: string;
    readonly total: string;
  };
  readonly paid: string;
  readonly difference: string;
  readonly outcome: LoanSettlementOutcome;
  readonly lines: {
    readonly principal: string;
    readonly interest: string;
    readonly extra: string;
  };
}

const STORAGE_DECIMALS = 4;

/**
 * The `pricing` JSON a claim stores for a settlement: the plan minus its
 * `policy` and `advancesCursor` (those describe the action and the write, not
 * the price), in the canonical key order of spec section 5.3, every money
 * figure a fixed-decimal string: the ledger and priced figures at storage
 * precision, the booked, paid and written figures at the currency's minor
 * unit (`currencyMinorUnitDecimals` of `plan.currencyCode`).
 */
export function pricingColumn(
  plan: LoanSettlementPlan,
): LoanSettlementPricingRecord {
  const decimals = currencyMinorUnitDecimals(plan.currencyCode);
  const storage = (value: number) => value.toFixed(STORAGE_DECIMALS);
  const unit = (value: number) => value.toFixed(decimals);
  return {
    version: 1,
    dueDate: plan.dueDate,
    installmentNumber: plan.installmentNumber,
    method: plan.method,
    prepaymentMode: plan.prepaymentMode,
    currencyCode: plan.currencyCode,
    debtLedger: storage(plan.debtLedger),
    foldedPrincipal: storage(plan.foldedPrincipal),
    debtBefore: storage(plan.debtBefore),
    annualRate: String(plan.annualRate),
    periodicRate: plan.periodicRate,
    priced: {
      principal: storage(plan.priced.principal),
      interest: storage(plan.priced.interest),
      extra: storage(plan.priced.extra),
      total: storage(plan.priced.total),
    },
    booked: {
      principal: unit(plan.booked.principal),
      interest: unit(plan.booked.interest),
      extra: unit(plan.booked.extra),
      total: unit(plan.booked.total),
    },
    paid: unit(plan.paid),
    difference: unit(plan.difference),
    outcome: plan.outcome,
    lines: {
      principal: unit(plan.principal),
      interest: unit(plan.interest),
      extra: unit(plan.extraPrincipal),
    },
  };
}
