import {
  AccountSubType,
  AccountType,
  InterestBookingMode,
} from "../../../accounts/entities/account.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { MnyWarning } from "./mny-warnings";

/**
 * The intermediate representation the mappers produce and the writer consumes
 * (design ADR-8).
 *
 * Deliberately its own model rather than the QIF parser's: the QIF shape cannot
 * carry exact transfer links, per-account currencies, closed/favourite flags, or
 * investment transfer semantics -- and the QIF processor's name-and-amount
 * transfer *matching* is exactly what a file with authoritative `TRN_XFER` pairs
 * must never fall back to.
 *
 * Nothing here touches the database. Identities are import-local keys and
 * pre-generated UUIDs, so transfer pairs and splits are fully wired before the
 * first INSERT.
 */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface MappedAccount {
  /**
   * Identity within this import. A Money account maps to `acct-<hacct>`; the
   * cash side Monize requires for an investment account that has no Money
   * companion is `acct-<hacct>-cash`.
   */
  readonly key: string;
  /**
   * The Money `hacct` whose transactions land in this account, or null for a
   * synthesized investment cash side.
   */
  readonly handle: number | null;
  /** Name Monize will use, after de-duplication and pair suffixing. */
  readonly name: string;
  /** Name as Money recorded it, for the review table and warnings. */
  readonly moneyName: string;
  readonly accountType: AccountType;
  readonly accountSubType: AccountSubType | null;
  readonly currencyCode: string;
  readonly openingBalance: number;
  readonly creditLimit: number | null;
  /**
   * Applied **after** the account's transactions are written:
   * `AccountsService.updateBalance` rejects closed accounts.
   */
  readonly closed: boolean;
  readonly closedDate: string | null;
  readonly favourite: boolean;
  readonly description: string | null;
  /** The other half of an investment pair, by `key`. */
  readonly linkedKey: string | null;
}

export interface MappedAccounts {
  /** The file's own base currency, or the user's preference when it has none. */
  readonly baseCurrency: string;
  /** ISO codes the import must ensure exist, base currency included. */
  readonly currencyCodes: readonly string[];
  readonly accounts: readonly MappedAccount[];
  /** Money `hacct` -> account key. An excluded account is absent. */
  readonly keyByHandle: ReadonlyMap<number, string>;
  /** Money `hacct` -> currency of the Monize account it maps to. */
  readonly currencyByHandle: ReadonlyMap<number, string>;
  /** Accounts left out by an unknown type or by the wizard's selection. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Categories and payees
// ---------------------------------------------------------------------------

export interface MappedCategory {
  /** `CAT.hcat`. */
  readonly handle: number;
  /** Monize parent name, or null for a top-level category. */
  readonly parentName: string | null;
  /**
   * Monize category name. A Money tree deeper than two levels is flattened
   * into a colon-joined child name (`Utilities:Gas:Winter` -> parent
   * `Utilities`, name `Gas:Winter`).
   */
  readonly name: string;
  /** `parentName:name`, the writer's find-or-create identity. */
  readonly fullName: string;
  readonly isIncome: boolean;
}

export interface MappedCategories {
  /** Unique by `fullName`, ordered parents-before-children. */
  readonly categories: readonly MappedCategory[];
  /** Every `hcat` that maps somewhere, including duplicates by name. */
  readonly byHandle: ReadonlyMap<number, MappedCategory>;
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

export interface MappedPayee {
  readonly handle: number;
  readonly name: string;
}

export interface MappedPayees {
  /** Unique by name, since `payees` is unique on `(user_id, name)`. */
  readonly payees: readonly MappedPayee[];
  readonly nameByHandle: ReadonlyMap<number, string>;
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface MappedSplit {
  readonly kind: SplitKind;
  /** Money `hcat` for a category split; null for a transfer split. */
  readonly categoryHandle: number | null;
  /** Account key for a transfer split -- the loan or destination account. */
  readonly transferAccountKey: string | null;
  /**
   * The counterpart transaction of a transfer split. Pre-generated, so the
   * split is wired before either row is inserted.
   */
  readonly linkedTransactionId: string | null;
  readonly amount: number;
  readonly memo: string | null;
}

export interface MappedTransaction {
  /** Pre-generated UUID: transfer pairs and splits reference it before insert. */
  readonly id: string;
  /** `TRN.htrn`, for warnings and for pairing. */
  readonly handle: number;
  readonly accountKey: string;
  readonly transactionDate: string;
  readonly amount: number;
  readonly currencyCode: string;
  readonly status: TransactionStatus;
  readonly payeeHandle: number | null;
  readonly categoryHandle: number | null;
  readonly description: string | null;
  readonly referenceNumber: string | null;
  readonly isTransfer: boolean;
  /** The other side of a `TRN_XFER` pair. Exact -- never name-matched. */
  readonly linkedTransactionId: string | null;
  readonly splits: readonly MappedSplit[];
}

export interface MappedTransactions {
  readonly transactions: readonly MappedTransaction[];
  /** Payee handles an imported transaction actually uses. */
  readonly referencedPayees: ReadonlySet<number>;
  /** Category handles an imported transaction or split actually uses. */
  readonly referencedCategories: ReadonlySet<number>;
  /** Transfer pairs fully linked in both directions. */
  readonly transfersLinked: number;
  /** `TRN` rows that are real postings but could not be imported. */
  readonly skipped: number;
  /**
   * Rows carrying a security, left for the investment mapper. Not a warning:
   * Phase 1 imports banking data and Phase 2 picks these up from the same
   * tables.
   */
  readonly deferredInvestments: number;
  /**
   * Money's own cash-sleeve rows for a trade in the paired brokerage account,
   * which the investment writer creates from the trade itself. Not skipped and
   * not lost: the row is written, from the other side. Reported because it is
   * the one number that says how much of a file went through that path, and it
   * has no other surface -- see `tradeCashLegRows` (issue #1175).
   */
  readonly tradeCashLegs: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Securities and investments
// ---------------------------------------------------------------------------

export interface MappedSecurity {
  /** `SEC.hsec`. */
  readonly handle: number;
  /**
   * Symbol Monize will use: trimmed, unique within the import and within the
   * `securities` column width. Never shared with another security -- PR #192
   * upserted on `(user_id, symbol)` and collapsed distinct funds into one.
   */
  readonly symbol: string;
  /** Symbol as Money recorded it; empty when Money had none. */
  readonly moneySymbol: string;
  readonly name: string;
  readonly currencyCode: string;
  /**
   * True for a generated placeholder symbol, which no quote provider can
   * resolve. Matches the QIF importer's convention for auto-created securities.
   */
  readonly skipPriceUpdates: boolean;
}

export interface MappedSecurities {
  readonly securities: readonly MappedSecurity[];
  readonly byHandle: ReadonlyMap<number, MappedSecurity>;
  /** Currency pseudo-securities and rows with no usable identity. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

export interface MappedInvestmentTransaction {
  /** Pre-generated UUID, so a share-transfer pair is wired before insert. */
  readonly id: string;
  /** `TRN.htrn`, or null for a `SEC_SPLIT`-derived SPLIT row. */
  readonly handle: number | null;
  /** The brokerage account key the shares move in. */
  readonly accountKey: string;
  /** The cash sleeve the cash leg lands in; null when the action moves no cash. */
  readonly cashAccountKey: string | null;
  readonly securityHandle: number;
  readonly action: InvestmentAction;
  readonly transactionDate: string;
  /**
   * Always positive -- direction comes from `action`, never from a sign
   * (`TRN_INV.qty` is stored positive). For a SPLIT this is the ratio the
   * holdings fold multiplies by.
   */
  readonly quantity: number | null;
  readonly price: number | null;
  readonly commission: number;
  /** Positive magnitude of the transaction, in the account's currency. */
  readonly totalAmount: number;
  readonly currencyCode: string;
  /** Signed cash impact on the cash sleeve; 0 for the share-only actions. */
  readonly cashAmount: number;
  readonly status: TransactionStatus;
  readonly payeeHandle: number | null;
  readonly categoryHandle: number | null;
  readonly description: string | null;
  /** The other leg of an `act` 15/16 share transfer. */
  readonly linkedInvestmentId: string | null;
}

export interface MappedInvestments {
  readonly transactions: readonly MappedInvestmentTransaction[];
  /** Security handles an imported investment row actually uses. */
  readonly referencedSecurities: ReadonlySet<number>;
  readonly referencedPayees: ReadonlySet<number>;
  readonly referencedCategories: ReadonlySet<number>;
  /** `act` 15/16 pairs turned into linked TRANSFER_IN / TRANSFER_OUT rows. */
  readonly transfersPaired: number;
  /** Security-carrying rows that could not be imported. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

/** One leg of a scheduled transaction built from a bill template's splits. */
export interface MappedBillSplit {
  readonly kind: SplitKind;
  /** Money `hcat` for a category leg; null for a transfer leg. */
  readonly categoryHandle: number | null;
  /** Account key a transfer leg pays into -- typically the loan account. */
  readonly transferAccountKey: string | null;
  readonly amount: number;
  readonly memo: string | null;
}

/** The investment template of a bill that schedules a recurring trade. */
export interface MappedBillInvestment {
  readonly action: InvestmentAction;
  readonly securityHandle: number;
  readonly quantity: number | null;
  readonly price: number | null;
  readonly commission: number;
}

/**
 * One detected-active bill series, ready to become a scheduled transaction.
 *
 * `handle` is the representative `BILL.hbill` and doubles as the wizard's
 * selection key (`options.bills`). Only detected-active series are mapped; the
 * checkbox list is the safety net for the detection being wrong in either
 * direction (design section 3, issue 2 -- 1,844 rows, ~20 real bills).
 */
export interface MappedBill {
  /** Representative `BILL.hbill`; the wizard's selection key. */
  readonly handle: number;
  /** `BILL.hbillHead`, or the row's own handle when the file has no series. */
  readonly seriesKey: number;
  /** Raw `BILL.st`, surfaced so real files can pin its semantics (question 12.3). */
  readonly status: number;
  /** Payee name, else the template's memo, else a generated fallback. */
  readonly name: string;
  readonly accountKey: string;
  readonly payeeHandle: number | null;
  /** Null when the bill is a transfer, an investment, or split. */
  readonly categoryHandle: number | null;
  readonly amount: number;
  readonly currencyCode: string;
  readonly frequency: FrequencyType;
  /** True when Monize cannot express the exact Money recurrence interval. */
  readonly approximate: boolean;
  readonly nextDueDate: string;
  readonly endDate: string | null;
  readonly description: string | null;
  readonly isTransfer: boolean;
  readonly transferAccountKey: string | null;
  readonly investment: MappedBillInvestment | null;
  readonly splits: readonly MappedBillSplit[];
}

export interface MappedBills {
  /** Detected-active candidates, one per series. */
  readonly bills: readonly MappedBill[];
  /** Distinct series seen in the file, active or not. */
  readonly seriesInFile: number;
  /** Series that could not be mapped at all (no template, no usable date). */
  readonly skipped: number;
  /** False for Money 2001 files, which predate the `BILL` table. */
  readonly supported: boolean;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

/**
 * What a loan or mortgage account's imported payments say about its terms.
 *
 * Money has no loan-terms table, so every field here is inferred from payment
 * shape and from the bill that pays the loan. A field the evidence does not
 * settle stays null and the writer leaves the account's own value alone.
 */
export interface MappedLoanTerms {
  readonly accountKey: string;
  /**
   * The category the payments book interest to, or null when the payments name
   * more than one non-principal category (a loan with an escrow leg does), in
   * which case escrow and interest cannot be told apart.
   */
  readonly interestCategoryHandle: number | null;
  /**
   * `SPLIT` when every observed payment booked interest as a split leg, which
   * is what `RateChangeInferenceService` needs so it does not also pair
   * standalone interest expenses and double-count. Null leaves the default.
   */
  readonly interestBookingMode: InterestBookingMode | null;
  /** Account key the payments came from -- the loan's funding account. */
  readonly sourceAccountKey: string | null;
  /** Scheduled installment, from the bill when there is one. */
  readonly paymentAmount: number | null;
  readonly paymentFrequency: FrequencyType | null;
  readonly paymentStartDate: string | null;
  /** Split-booked payments seen; 0 when the terms came only from a bill. */
  readonly paymentsObserved: number;
}

export interface MappedLoans {
  readonly loans: readonly MappedLoanTerms[];
  readonly warnings: readonly MnyWarning[];
}

/** One holding's line in the LOT cross-check (design task M2.3). */
export interface MnyHoldingCheck {
  readonly accountKey: string;
  readonly securityHandle: number;
  readonly symbol: string;
  /** Shares open lots say the account holds (`LOT` rows with no `htrnSell`). */
  readonly lotQuantity: number;
  /** Shares replaying the mapped investment actions produces. */
  readonly replayQuantity: number;
  /** `replayQuantity - lotQuantity`. */
  readonly delta: number;
  readonly matches: boolean;
}
