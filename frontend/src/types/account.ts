export type AccountType =
  | 'CHEQUING'
  | 'SAVINGS'
  | 'CREDIT_CARD'
  | 'LOAN'
  | 'MORTGAGE'
  | 'INVESTMENT'
  | 'CASH'
  | 'LINE_OF_CREDIT'
  | 'ASSET'
  | 'OTHER';

export type AccountSubType = 'INVESTMENT_CASH' | 'INVESTMENT_BROKERAGE' | null;

/**
 * Account types whose balances represent money owed rather than money held.
 * A negative balance on these is the normal, expected state -- not something
 * to flag as an anomaly.
 */
export const LIABILITY_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'CREDIT_CARD',
  'LOAN',
  'MORTGAGE',
  'LINE_OF_CREDIT',
]);

/** True when the account type is a liability (credit card, loan, mortgage, line of credit). */
export function isLiabilityAccountType(type: AccountType | undefined | null): boolean {
  return type != null && LIABILITY_ACCOUNT_TYPES.has(type);
}

/** How a loan/mortgage's interest is recorded, for rate detection. */
export type InterestBookingMode = 'AUTO' | 'SPLIT' | 'SEPARATE';
export const INTEREST_BOOKING_MODES: InterestBookingMode[] = ['AUTO', 'SPLIT', 'SEPARATE'];

/**
 * Payment frequencies a loan account can carry, mirroring the backend's
 * `PAYMENT_FREQUENCIES`.
 *
 * `SEMIMONTHLY` (no underscore) is here because the loan-payment setup dialog
 * offers it and the backend writes it to `accounts.payment_frequency` -- the
 * mortgage enum's `SEMI_MONTHLY` is the other spelling of the same cadence, and
 * both reach this field.
 *
 * Declared as a runtime list with the type derived from it, so `AccountForm`'s
 * Zod enum can be built from the same values instead of a third copy. That
 * matters more than tidiness here: `optionalEnum` maps an unlisted value to
 * `undefined`, so a list missing SEMIMONTHLY would silently ERASE the frequency
 * of any loan the setup dialog created, the first time somebody edited it.
 * `frontend/src/lib/loan-frequency.guard.test.ts` holds the lists against the
 * label catalog.
 */
export const PAYMENT_FREQUENCIES = [
  'WEEKLY',
  'BIWEEKLY',
  'SEMIMONTHLY',
  'MONTHLY',
  'QUARTERLY',
  'YEARLY',
] as const;

export type PaymentFrequency = (typeof PAYMENT_FREQUENCIES)[number];

export const MORTGAGE_PAYMENT_FREQUENCIES = [
  'MONTHLY',
  'SEMI_MONTHLY',
  'BIWEEKLY',
  'ACCELERATED_BIWEEKLY',
  'WEEKLY',
  'ACCELERATED_WEEKLY',
] as const;

export type MortgagePaymentFrequency =
  (typeof MORTGAGE_PAYMENT_FREQUENCIES)[number];

/**
 * The mortgage-domain spelling of a payment frequency, or `null` when the
 * mortgage helpers cannot express it -- the browser-side twin of the backend's
 * `toMortgagePaymentFrequency` (`backend/src/accounts/payment-frequency.util.ts`).
 *
 * Quarterly and yearly return `null`: a mortgage in this model has no such
 * cadence, and the server refuses one with a 400 rather than splitting the
 * payment at a confidently wrong rate. The setup dialog exists on this side of
 * that refusal, so it must not OFFER a cadence the server will reject -- it
 * offered quarterly and yearly to Canadian mortgages and turned a working flow
 * into a hard failure the user could not read off the form.
 *
 * `loan-frequency.guard.test.ts` reads the backend switch and fails when the two
 * disagree, so this is a copy the machine checks rather than one it trusts.
 */
export function toMortgagePaymentFrequency(
  frequency: string,
): MortgagePaymentFrequency | null {
  if ((MORTGAGE_PAYMENT_FREQUENCIES as readonly string[]).includes(frequency)) {
    return frequency as MortgagePaymentFrequency;
  }
  return frequency === 'SEMIMONTHLY' ? 'SEMI_MONTHLY' : null;
}

export interface Account {
  id: string;
  userId: string;
  accountType: AccountType;
  accountSubType: AccountSubType;
  linkedAccountId: string | null;
  name: string;
  description: string | null;
  currencyCode: string;
  accountNumber: string | null;
  institution: string | null;
  institutionId: string | null;
  openingBalance: number;
  currentBalance: number;
  creditLimit: number | null;
  interestRate: number | null;
  isClosed: boolean;
  closedDate: string | null;
  isFavourite: boolean;
  favouriteSortOrder: number;
  excludeFromNetWorth: boolean;
  // Credit card statement fields
  statementDueDay: number | null;
  statementSettlementDay: number | null;
  // Loan-specific fields. Mortgages persist their (possibly accelerated or
  // semi-monthly) cadence in this same column, so the stored value may be a
  // MortgagePaymentFrequency, not only a loan PaymentFrequency.
  paymentAmount: number | null;
  paymentFrequency: PaymentFrequency | MortgagePaymentFrequency | null;
  paymentStartDate: string | null;
  sourceAccountId: string | null;
  principalCategoryId: string | null;
  interestCategoryId: string | null;
  // How interest is recorded, for rate detection: AUTO | SPLIT | SEPARATE.
  // Always set by the backend (defaults to AUTO); optional here so fixtures and
  // non-loan accounts need not specify it.
  interestBookingMode?: InterestBookingMode;
  // Category tagging standalone overpayments (extra principal) so the loan
  // schedule can flag them as 100% principal.
  overpaymentCategoryId: string | null;
  // Memo text marking a payment as a standalone overpayment (case-insensitive
  // substring match); usable with or instead of the overpayment category.
  overpaymentMemo: string | null;
  // Payee whose payments count as standalone overpayments (extra principal),
  // usable with or instead of the overpayment category / memo.
  overpaymentPayeeId: string | null;
  // Foreign-transaction fee: the bank's FX conversion fee (percent) booked as an
  // percentage folded into the converted amount on foreign-entered transactions.
  fxFeePercent: number | null;
  scheduledTransactionId: string | null;
  // Asset-specific fields
  assetCategoryId: string | null;
  dateAcquired: string | null;
  // Links an asset/other account to its financing loan/mortgage (equity view)
  linkedLoanAccountId: string | null;
  // Mortgage-specific fields
  isCanadianMortgage: boolean;
  isVariableRate: boolean;
  termMonths: number | null;
  termEndDate: string | null;
  amortizationMonths: number | null;
  originalPrincipal: number | null;
  canDelete?: boolean;
  futureTransactionsSum?: number;
  // ── Joint accounts ──
  // Present on rows shared TO the current user (grantee view): the account
  // belongs to another user but appears natively in this user's lists.
  isJoint?: boolean;
  // Display label of the sharing owner ("shared by X"), grantee view only.
  ownerLabel?: string;
  // The grantee's effective write permissions: the owner's grant flags masked
  // by the backend's account-type policy. Absent on own accounts.
  jointPermissions?: {
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
  };
  // Present on the OWNER's rows that are jointly shared: how many users the
  // account is shared with (absent, not 0, when unshared).
  jointGranteeCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountData {
  accountType: AccountType;
  name: string;
  description?: string;
  currencyCode: string;
  accountNumber?: string;
  institution?: string;
  institutionId?: string | null;
  openingBalance?: number;
  creditLimit?: number;
  interestRate?: number;
  isFavourite?: boolean;
  excludeFromNetWorth?: boolean;
  createInvestmentPair?: boolean;
  // Credit card statement fields
  statementDueDay?: number;
  statementSettlementDay?: number;
  // Loan-specific fields
  paymentAmount?: number;
  paymentFrequency?: PaymentFrequency;
  paymentStartDate?: string;
  sourceAccountId?: string;
  principalCategoryId?: string;
  interestCategoryId?: string | null;
  interestBookingMode?: InterestBookingMode;
  overpaymentCategoryId?: string | null;
  overpaymentMemo?: string | null;
  overpaymentPayeeId?: string | null;
  // Foreign-transaction fee percentage (null clears).
  fxFeePercent?: number | null;
  // Asset-specific fields
  assetCategoryId?: string;
  dateAcquired?: string;
  linkedLoanAccountId?: string | null;
  // Mortgage-specific fields
  isCanadianMortgage?: boolean;
  isVariableRate?: boolean;
  termMonths?: number;
  amortizationMonths?: number;
  mortgagePaymentFrequency?: MortgagePaymentFrequency;
}

export interface InvestmentAccountPair {
  cashAccount: Account;
  brokerageAccount: Account;
}

export interface UpdateAccountData extends Partial<CreateAccountData> {}

export interface AccountSummary {
  totalAccounts: number;
  totalBalance: number;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}

/**
 * An account the real user can use as the other side of a cross-owner
 * transfer: own context lists accounts shared to them (with per-op grant
 * flags), acting context lists their own accounts. Carries no balances.
 */
export interface TransferCandidate {
  id: string;
  name: string;
  currencyCode: string;
  accountType: AccountType;
  accountSubType: AccountSubType | null;
  isClosed: boolean;
  ownerLabel: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

// Loan amortization types
export interface LoanPreviewData {
  loanAmount: number;
  interestRate: number;
  paymentAmount: number;
  paymentFrequency: PaymentFrequency;
  paymentStartDate: string;
}

export interface AmortizationPreview {
  principalPayment: number;
  interestPayment: number;
  remainingBalance: number;
  totalPayments: number;
  endDate: string;
}

// Mortgage amortization types
export interface MortgagePreviewData {
  mortgageAmount: number;
  interestRate: number;
  amortizationMonths: number;
  paymentFrequency: MortgagePaymentFrequency;
  paymentStartDate: string;
  isCanadian: boolean;
  isVariableRate: boolean;
}

export interface MortgageAmortizationPreview {
  paymentAmount: number;
  principalPayment: number;
  interestPayment: number;
  totalPayments: number;
  /**
   * The last payment: the residual payoff, not another full installment. Only an
   * accelerated schedule (or a rounding remainder) makes it differ from
   * `paymentAmount`, so the preview shows it only when it does. -1 when the
   * payment never amortizes. Absent during a rolling deploy of an older API.
   *
   * Deliberately not `finalPaymentAmount`: `LoanScheduleResult` already uses
   * that name for the ending regular *installment*, and both are loan-domain
   * numbers of the same type reachable from the same component tree.
   */
  residualPayoffAmount?: number;
  /** Date of the final payment (the first payment date is payment 1) */
  endDate: string;
  totalInterest: number;
  effectiveAnnualRate: number;
}

export interface UpdateMortgageRateData {
  newRate: number;
  newPaymentAmount?: number;
  effectiveDate: string;
}

export interface UpdateMortgageRateResponse {
  newRate: number;
  paymentAmount: number;
  principalPayment: number;
  interestPayment: number;
  effectiveDate: string;
}

// Loan payment detection types
export interface DetectedLoanPayment {
  paymentAmount: number;
  paymentFrequency: string;
  confidence: number;
  sourceAccountId: string | null;
  sourceAccountName: string | null;
  interestCategoryId: string | null;
  interestCategoryName: string | null;
  principalCategoryId: string | null;
  estimatedInterestRate: number | null;
  suggestedNextDueDate: string;
  firstPaymentDate: string;
  lastPaymentDate: string;
  paymentCount: number;
  currentBalance: number;
  isMortgage: boolean;
  averageExtraPrincipal: number;
  extraPrincipalCount: number;
  lastPrincipalAmount: number | null;
  lastInterestAmount: number | null;
}

export interface SetupLoanPaymentsData {
  paymentAmount: number;
  paymentFrequency: string;
  sourceAccountId: string;
  nextDueDate: string;
  interestRate?: number;
  interestCategoryId?: string;
  payeeId?: string;
  payeeName?: string;
  autoPost?: boolean;
  isCanadianMortgage?: boolean;
  isVariableRate?: boolean;
  amortizationMonths?: number;
  termMonths?: number;
  extraPrincipal?: number;
  detectedInterestAmount?: number;
}

export interface SetupLoanPaymentsResponse {
  scheduledTransactionId: string;
  accountId: string;
  paymentAmount: number;
  /** First installment after clamping against the outstanding balance. */
  firstInstallmentAmount: number;
  paymentFrequency: string;
  nextDueDate: string;
}

/**
 * One account's worth at the end of a single day, from
 * `GET /accounts/balances-as-of`. `docs/specs/account-balances-as-of.md` is
 * canonical; the short version is that `balance` is a ledger sum the server
 * always knows, and `marketValue` is a *total* -- null unless every position was
 * both priced and converted.
 */
export interface AccountBalanceAsOf {
  accountId: string;
  currencyCode: string;
  balance: number;
  /** Holdings valued at the as-of date, account currency. Null unless complete. */
  marketValue: number | null;
  /** The part of marketValue that is known. 0 for a non-holdings account. */
  knownMarketValueSubtotal: number;
  unpricedHoldingsCount: number;
  /** "USD->CAD" for each pair with no rate at or before the as-of date. */
  missingRatePairs: string[];
  pricesComplete: boolean;
  fxComplete: boolean;
  /** Read as `=== false`: an older backend sends no field, which is not "incomplete". */
  valuationComplete: boolean;
  /**
   * Held positions valued at the closest close the server could find, because
   * nothing was observed for the as-of date itself. The figure is a real
   * observation from another day, so it counts as known -- and has to be shown
   * as an approximation. Read as `?? 0`: an older backend sends no field.
   */
  approximatedPriceCount: number;
  /**
   * `"USD->CAD"` for each pair converted at the closest rate to the as-of date
   * rather than one that stood on it. Read as `?? []`.
   */
  approximatedRatePairs: string[];
  /**
   * Whether the account existed at the as-of date.
   *
   * Its inception is an asset's acquisition date, or otherwise its first
   * movement on either ledger; before that the account is not a thing with a
   * balance, so it is left out of the report rather than shown at its opening
   * balance. Read as `=== false`, never `!`: a backend that predates the field
   * sends nothing, and absent means "no information", not "did not exist".
   */
  existsAsOf: boolean;
}

export interface AccountBalancesAsOfResponse {
  /** The date the figures were measured at -- the payload's own request key. */
  asOfDate: string;
  /** The currency every total is presented in (the user's reporting currency). */
  displayCurrency: string;
  /**
   * Multiplier from each account currency present to `displayCurrency`, as the
   * rate stood on `asOfDate`. A currency **absent** from this map had no rate
   * for that date: its accounts are unconvertible, and a consumer must say so
   * rather than reaching for a live rate or for 1. See
   * `components/reports/account-balances/as-of-rates.ts`.
   */
  displayRates: Record<string, number>;
  /**
   * Currency -> the date its rate in `displayRates` was actually struck on, for
   * the currencies converted at the closest observation rather than at a rate
   * that stood on the as-of date.
   *
   * Absent from here means the rate stood on the date; absent from
   * `displayRates` means there is no rate at all. The two absences mean
   * opposite things, which is why the approximation is named separately.
   */
  approximatedDisplayRates: Record<string, string>;
  accounts: AccountBalanceAsOf[];
}
