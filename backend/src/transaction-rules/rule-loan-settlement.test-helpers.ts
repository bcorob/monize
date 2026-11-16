import { Account, AccountType } from "../accounts/entities/account.entity";
import {
  LoanOccurrenceClaim,
  LoanSettlementFacts,
} from "../loan-installments/loan-settlement-facts";
import { occurrenceSlotsInRange } from "../loan-installments/occurrence-slots";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { SettleLoanInstallmentAction } from "./rule-action.types";
import { RuleLoanFacts } from "./rule-loan-settlement";

/**
 * Fixtures for `settle_loan_installment` in the rules engine, copied from
 * `docs/specs/loan-installment-settlement.md` section 9.1: a LINEAR EUR
 * 300,000 mortgage over 360 months at 2 %, first slot 2024-01-01, so slot 1
 * books 833.33 principal and 500.00 interest. The facts are the shape
 * `loadLoanSettlementFacts` returns; the pricing is the loan core's.
 */
export const SETTLE_USER = "user-1";
export const SOURCE_ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
export const LOAN_ACCOUNT = "00000000-0000-4000-8000-0000000000a2";
export const LOAN_SCHEDULE = "00000000-0000-4000-8000-0000000000e1";
export const INTEREST_CATEGORY = "00000000-0000-4000-8000-0000000000c1";

export const settleAction = (
  over: Partial<SettleLoanInstallmentAction> = {},
): SettleLoanInstallmentAction => ({
  type: "settle_loan_installment",
  loanAccountId: LOAN_ACCOUNT,
  dueDateWindow: { daysBefore: 3, daysAfter: 7 },
  excess: "extra_principal",
  shortfall: "refuse",
  ...over,
});

export const linearLoanAccount = (over: Partial<Account> = {}): Account =>
  ({
    id: LOAN_ACCOUNT,
    userId: SETTLE_USER,
    accountType: AccountType.MORTGAGE,
    name: "Hypotheek",
    currencyCode: "EUR",
    isClosed: false,
    interestBookingMode: "AUTO",
    mortgageType: "LINEAR",
    prepaymentMode: null,
    interestRate: 2,
    paymentAmount: null,
    extraPaymentAmount: null,
    paymentFrequency: "MONTHLY",
    paymentStartDate: "2024-01-01",
    amortizationMonths: 360,
    originalPrincipal: 300000,
    openingBalance: -300000,
    currentBalance: -300000,
    interestCategoryId: INTEREST_CATEGORY,
    scheduledTransactionId: LOAN_SCHEDULE,
    ...over,
  }) as unknown as Account;

export interface LoanFactsFixture {
  readonly account?: Account;
  /** Null: the loan has no scheduled payment. */
  readonly schedule?: Partial<ScheduledTransaction> | null;
  readonly claims?: readonly LoanOccurrenceClaim[];
  readonly postedRowIds?: readonly string[];
}

/** The facts the loader reads for the loan, with the slots of 2023-11-01..2024-12-31 at the opening debt. */
export function linearLoanFacts(
  fixture: LoanFactsFixture = {},
): LoanSettlementFacts {
  const account = fixture.account ?? linearLoanAccount();
  if (fixture.schedule === null) {
    return {
      kind: "facts",
      loanAccount: account,
      schedule: null,
      splits: [],
      rateChanges: [],
      slots: [],
      claims: [],
      postedRowIds: new Set(fixture.postedRowIds ?? []),
      debtByDueDate: new Map(),
    };
  }
  const schedule = {
    id: LOAN_SCHEDULE,
    userId: SETTLE_USER,
    accountId: SOURCE_ACCOUNT,
    name: "Hypotheek",
    amount: -1333.3333,
    currencyCode: "EUR",
    frequency: "MONTHLY",
    startDate: "2024-01-01",
    nextDueDate: "2024-01-01",
    endDate: null,
    occurrencesRemaining: null,
    isActive: true,
    isSplit: true,
    ...fixture.schedule,
  } as unknown as ScheduledTransaction;
  const splits = [
    {
      id: "split-principal",
      scheduledTransactionId: LOAN_SCHEDULE,
      transferAccountId: LOAN_ACCOUNT,
      categoryId: null,
      amount: -833.3333,
      memo: "Principal",
    },
    {
      id: "split-interest",
      scheduledTransactionId: LOAN_SCHEDULE,
      transferAccountId: null,
      categoryId: INTEREST_CATEGORY,
      amount: -500,
      memo: "Interest",
    },
  ] as unknown as ScheduledTransactionSplit[];
  const slots = occurrenceSlotsInRange(schedule, {
    from: "2023-11-01",
    to: "2024-12-31",
  });
  return {
    kind: "facts",
    loanAccount: account,
    schedule,
    splits,
    rateChanges: [],
    slots,
    claims: fixture.claims ?? [],
    postedRowIds: new Set(fixture.postedRowIds ?? []),
    debtByDueDate: new Map(slots.map((slot) => [slot.date, 300000])),
  };
}

/** A loan-facts entry as the applier keeps it, read over the fixture's whole calendar. */
export const loanFactsEntry = (
  facts: RuleLoanFacts["facts"] = linearLoanFacts(),
  rowIds: readonly string[] = [],
): RuleLoanFacts => ({
  window: { from: "2023-11-01", to: "2024-12-31" },
  rowIds: new Set(rowIds),
  facts,
});

export const loanFactsByAccount = (
  entry: RuleLoanFacts = loanFactsEntry(),
): ReadonlyMap<string, RuleLoanFacts> => new Map([[LOAN_ACCOUNT, entry]]);

/** A `post` claim (or a rule's) on the loan's schedule. */
export const loanClaim = (
  originalDueDate: string,
  over: Partial<LoanOccurrenceClaim> = {},
): LoanOccurrenceClaim => ({
  id: `claim-${originalDueDate}`,
  originalDueDate,
  source: "post",
  transactionId: null,
  ...over,
});
