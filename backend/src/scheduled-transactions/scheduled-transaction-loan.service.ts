import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { PaymentFrequency } from "../accounts/loan-amortization.util";
import { getPeriodicRate } from "../accounts/mortgage-amortization.util";
import { roundMoney } from "../common/round.util";
import {
  allocateLoanPayment,
  LoanPaymentAllocation,
} from "../accounts/loan-payment-waterfall.util";
import { withScopedDb } from "../common/db/scoped-db";
import { ensureYMD } from "../common/recurrence";
import { tr } from "../i18n/translate";
import { ACCOUNT_BALANCE_AS_OF_SQL } from "../common/ledger-balance.sql";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { effectiveAnnualRateOn } from "../accounts/effective-loan-rate.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  periodsPerYearForStoredFrequency,
} from "../accounts/payment-frequency.util";

// The account types that carry a scheduled loan-payment structure and therefore
// need their next principal/interest split advanced after each posting. This set
// must stay in step with what `LoanPaymentSetupService` accepts when it creates
// that structure -- it accepts LOAN, MORTGAGE and LINE_OF_CREDIT, so a LOC left
// out of the recalculation would keep billing the first installment's split
// forever (issue #1154 re-review).
const LOAN_LIKE_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.LOAN,
  AccountType.MORTGAGE,
  AccountType.LINE_OF_CREDIT,
]);

/** The template's managed lines: a principal transfer, one interest line, and
 *  optionally an extra-principal transfer. */
interface LoanTemplateSplits {
  principalSplit?: ScheduledTransactionSplit;
  interestSplit: ScheduledTransactionSplit;
  extraPrincipalSplit?: ScheduledTransactionSplit;
}

/**
 * Whether the installment is being priced to advance the stored TEMPLATE or to
 * post an OCCURRENCE. The difference is one rule and it is load-bearing.
 *
 * The template may grow back toward the account's configured payment: a clamp
 * written for one installment must not become the standing instruction (review
 * #1131). An occurrence may NOT: the parent it posts is the bill the user was
 * shown on the bills page and in the Post dialog, so re-pricing may re-divide
 * that total between interest and principal and never resize it. Letting the
 * posting take `max(template, account.payment_amount)` would move more money
 * than any surface displayed, the preview/commit divergence the FX rules call
 * out ("a preview computes what the commit will do, through the same code").
 */
type InstallmentPurpose = "template" | "posting";

/** One resolved installment: what the next posting of this template should move. */
type ResolvedInstallment =
  | { kind: "declined"; reason: string }
  /** The ledger could not be read -- not a zero balance, and not "not a loan". */
  | { kind: "unreadable"; reason: string }
  | {
      kind: "paid-off";
      debt: number;
      /**
       * Whether the template is one this service manages (principal transfer +
       * one identifiable interest line, optionally an extra-principal
       * transfer). A retired debt is only a reason to withhold an occurrence's
       * money when every line of the bill is one of those: a mortgage template
       * carrying an escrow, tax or insurance line still owes those lines when
       * the mortgage principal reaches zero, and skipping the write would
       * silently stop paying them.
       */
      managed: boolean;
    }
  | {
      kind: "ok";
      allocation: LoanPaymentAllocation;
      template: LoanTemplateSplits;
      debt: number;
      /** The rate actually priced at -- the timeline's, not the scalar. */
      annualRate: number;
      /** Configured installment total, extra included -- what drove the parent. */
      paymentAmount: number;
      basePaymentAmount: number;
      /** The configured extra, before the waterfall clamped it. */
      extraPrincipalAmount: number;
      templateAmount: number;
      templateExtraAmount: number;
    };

/** The effective split amounts a posting should write, keyed by scheduled-split id. */
export interface LoanPostingAllocation {
  /** Signed amounts (negative = payment out of the source account). */
  amountsBySplitId: Map<string, number>;
  /** Signed parent amount matching the sum of the managed children. */
  parentAmount: number;
}

/**
 * What a posting should do with a loan template.
 *
 * Three answers, not two. Collapsing `retired` into "not applicable" is how a
 * fully paid-off loan went on charging its whole stale installment: the posting
 * read `null` as "this is not a managed loan template, use the persisted
 * amounts" and wrote the last bill it happened to hold -- interest against a
 * debt that no longer exists, and principal that pushes the account into
 * credit. "There is nothing to price here" and "the price is zero" are
 * different instructions.
 */
export type LoanPostingDecision =
  /** Not a managed loan template -- post the persisted amounts, as before. */
  | { kind: "not-applicable" }
  /** A managed template whose debt is already retired: post no money. */
  | { kind: "retired" }
  | ({ kind: "allocation" } & LoanPostingAllocation);

@Injectable()
export class ScheduledTransactionLoanService {
  private readonly logger = new Logger(ScheduledTransactionLoanService.name);

  constructor(private dataSource: DataSource) {}

  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
  ): Promise<void> {
    return withScopedDb(this.dataSource, async (m) => {
      // This writer mutates the child split set, so it must serialize through
      // the same parent lock the posting path takes (issue #1154 re-review): a
      // recalculation that changed principal/interest without the lock could
      // land between a poster's split-set guard and its write, and because a
      // P/I reallocation leaves the parent total unchanged, the poster's own
      // parent lock would not have blocked it. Lock the parent, then read the
      // current child set and derive the loan from it -- never from a loan id
      // captured off a pre-lock snapshot.
      const scheduledTransaction = await m
        .getRepository(ScheduledTransaction)
        .findOne({
          where: { id: scheduledTransactionId },
          lock: { mode: "pessimistic_write" },
        });

      if (!scheduledTransaction || !scheduledTransaction.isActive) {
        return;
      }

      const splits = await m.getRepository(ScheduledTransactionSplit).find({
        where: { scheduledTransactionId },
      });

      const loanAccount = await this.findLoanAccount(m, splits);
      if (!loanAccount) {
        return;
      }

      // Recalculation runs after the schedule advances, so the installment being
      // prepared is the one due at the (new) nextDueDate.
      const installment = await this.resolveInstallment(
        m,
        scheduledTransaction,
        splits,
        loanAccount,
        ensureYMD(scheduledTransaction.nextDueDate),
        "template",
      );

      // A failed ledger read is not a template this method cannot account for,
      // and the remedy below ("set the interest category") would send the
      // reader nowhere. Two causes, two messages.
      if (installment.kind === "unreadable") {
        this.logger.warn(
          `Skipping loan recalculation for scheduled transaction ${scheduledTransactionId}: ` +
            `${installment.reason}. The stored principal/interest split stays at last period's ` +
            `figures until a later recalculation reads the ledger successfully.`,
        );
        return;
      }

      if (installment.kind === "paid-off") {
        // A LINE OF CREDIT owing nothing is not a finished loan -- it is a
        // revolving facility at a zero (or credit) balance, and the user can
        // draw on it again tomorrow. Deactivating its schedule is not
        // recoverable from the UI, so it keeps billing whatever the template
        // holds and simply writes no new split this period.
        //
        // This matters more since the debt became `max(0, -balance)`: an
        // overpaid account in credit now reads as owing nothing, where the
        // old `Math.abs` read a credit balance as fresh debt and kept
        // amortizing it. That change is right (it matches `debtMagnitude` on
        // the client) but it must not take a revolving account's schedule
        // down with it.
        if (loanAccount.accountType === AccountType.LINE_OF_CREDIT) {
          this.logger.log(
            `Loan recalculation: line of credit ${loanAccount.id} owes nothing through ` +
              `${ensureYMD(scheduledTransaction.nextDueDate)}; leaving the schedule active ` +
              `(a revolving facility can be drawn on again).`,
          );
          return;
        }
        await m
          .getRepository(ScheduledTransaction)
          .update(scheduledTransactionId, { isActive: false });
        return;
      }

      if (installment.kind === "declined") {
        this.logger.warn(
          `Skipping loan recalculation for scheduled transaction ${scheduledTransactionId}: ` +
            `${installment.reason}. ` +
            `Rewriting the parent would leave it unequal to the sum of its children and the occurrence would stop posting. ` +
            `Set the loan's interest category, or keep the template to principal + interest (+ extra principal).`,
        );
        return;
      }

      const {
        allocation,
        template,
        debt,
        paymentAmount,
        basePaymentAmount,
        extraPrincipalAmount,
        templateAmount,
        templateExtraAmount,
      } = installment;
      const { principalSplit, interestSplit, extraPrincipalSplit } = template;

      const newInterest = allocation.interest;
      const newPrincipal = allocation.principal;
      const finalExtraPrincipal = allocation.extraPrincipal;
      const requiredParentAmount = allocation.total;

      this.logger.log(
        `Recalculate loan splits: balance=${debt}, rate=${installment.annualRate}%, ` +
          `freq=${loanAccount.paymentFrequency || scheduledTransaction.frequency}, ` +
          `basePayment=${basePaymentAmount}, ` +
          `extra=${extraPrincipalAmount} (final ${finalExtraPrincipal}), ` +
          `newPrincipal=${newPrincipal}, newInterest=${newInterest}, ` +
          `isMortgage=${loanAccount.accountType === "MORTGAGE"}, ` +
          `isCanadian=${loanAccount.isCanadianMortgage}`,
      );

      if (principalSplit) {
        principalSplit.amount = -newPrincipal;
        await m.getRepository(ScheduledTransactionSplit).save(principalSplit);
      }

      if (interestSplit) {
        interestSplit.amount = -newInterest;
        await m.getRepository(ScheduledTransactionSplit).save(interestSplit);
      }

      // The extra principal child was never written here, so a clamped total had
      // nowhere to land: the parent would shrink while the children still summed
      // to the unclamped figure, and the posting path's split validator requires
      // exact 4dp equality between them (audit P5-008 again, on the child the
      // first fix did not reach). Written whenever it differs from what the
      // template holds -- in either direction, so one clamped installment does
      // not become the standing instruction (review #1131).
      if (extraPrincipalSplit && finalExtraPrincipal !== templateExtraAmount) {
        extraPrincipalSplit.amount = -finalExtraPrincipal;
        await m
          .getRepository(ScheduledTransactionSplit)
          .save(extraPrincipalSplit);
      }

      // Parent and children are written in the same transaction, so a posting
      // can never see one without the other. The parent is written whenever the
      // next installment differs from what the template holds: shrunk when the
      // debt no longer needs the whole configured payment, and grown back
      // toward the configured payment when a clamp written for one installment
      // no longer binds -- a voided final payment or an imported balance must
      // not leave the schedule billing the clamped figure forever (review
      // #1131). `allocateLoanPayment` bounds the total by the configured
      // payment, so this can never grow past what the user set.
      if (
        requiredParentAmount > 0 &&
        requiredParentAmount !== roundMoney(templateAmount)
      ) {
        await m
          .getRepository(ScheduledTransaction)
          .update(scheduledTransactionId, { amount: -requiredParentAmount });
        this.logger.log(
          `Loan payment recalculated: scheduled amount changed from ${templateAmount} to ${requiredParentAmount} (configured payment ${paymentAmount}, outstanding balance ${debt})`,
        );
      }
    });
  }

  /**
   * The effective principal/interest allocation for the occurrence about to be
   * posted, derived from the ledger at the consumption boundary.
   *
   * The stored split is a template computed when the *previous* occurrence
   * posted; any principal movement committed since (a standalone overpayment, a
   * void, an import) leaves it stale, and no mutation path recalculates it. So
   * the posting path calls this immediately before writing the financial
   * transaction -- inside the same scoped transaction and under the same parent
   * lock -- and posts these amounts instead of the persisted ones. When nothing
   * moved in between, this resolves to exactly what the template already holds.
   *
   * `asOfDate` is the date this occurrence's money actually moves -- the
   * posting date, which an override can move off the recurrence slot -- because
   * that is the date the interest accrues to.
   *
   * The total is the bill the user was shown: this re-divides it between
   * interest and principal and never resizes it (see `InstallmentPurpose`).
   *
   * The decision distinguishes three outcomes, because two of them used to
   * share `null` and a retired loan therefore went on charging its whole stale
   * installment:
   *
   *  - `not-applicable` -- the split set is not a managed loan template, or its
   *    shape is one the recalculation would also decline. The posting proceeds
   *    on the persisted amounts, which is today's behavior.
   *  - `retired` -- it IS a managed template and the debt through `asOfDate` is
   *    already settled, so the correct price is zero: the occurrence is claimed
   *    and the schedule advances, and no financial transaction is written.
   *  - `allocation` -- the interest/principal split to post.
   *
   * **Throws when the ledger cannot be read.** That is not "this is not a loan
   * template": silently declining there would post the stale stored split,
   * which is the exact defect this method exists to prevent, so the occurrence
   * refuses and the whole posting transaction rolls back rather than committing
   * a figure nothing verified.
   */
  async resolvePostingAllocation(
    scheduledTransaction: ScheduledTransaction,
    splits: ScheduledTransactionSplit[],
    asOfDate: string,
  ): Promise<LoanPostingDecision> {
    return withScopedDb(this.dataSource, async (m) => {
      const loanAccount = await this.findLoanAccount(m, splits);
      if (!loanAccount) {
        return { kind: "not-applicable" } as const;
      }

      const installment = await this.resolveInstallment(
        m,
        scheduledTransaction,
        splits,
        loanAccount,
        asOfDate,
        "posting",
      );
      if (installment.kind === "paid-off") {
        // Only a template whose every line this service accounts for. An
        // escrow or tax line is still owed when the mortgage principal reaches
        // zero, so that bill posts as it always has.
        return installment.managed
          ? ({ kind: "retired" } as const)
          : ({ kind: "not-applicable" } as const);
      }
      if (installment.kind === "unreadable") {
        throw new ServiceUnavailableException(
          tr(
            "errors.scheduled.loanLedgerUnreadable",
            "This loan payment could not be priced because its ledger balance could not be read. Try again.",
          ),
        );
      }
      if (installment.kind !== "ok") {
        return { kind: "not-applicable" } as const;
      }

      const { allocation, template } = installment;
      const amountsBySplitId = new Map<string, number>();
      if (template.principalSplit?.id) {
        amountsBySplitId.set(template.principalSplit.id, -allocation.principal);
      }
      if (template.interestSplit.id) {
        amountsBySplitId.set(template.interestSplit.id, -allocation.interest);
      }
      if (template.extraPrincipalSplit?.id) {
        amountsBySplitId.set(
          template.extraPrincipalSplit.id,
          -allocation.extraPrincipal,
        );
      }
      return {
        kind: "allocation" as const,
        amountsBySplitId,
        parentAmount: -allocation.total,
      };
    });
  }

  /**
   * The authoritative anchor for projecting this loan's amortization forward:
   * the next scheduled installment's due date, and the debt measured from the
   * ledger through that date -- the same boundary the scheduled bill's own
   * interest is calculated from, so the two price the same BALANCE (issue
   * #1253).
   *
   * The RATE is shared too: `datedAnnualRate` resolves it from the same
   * `loan_rate_changes` timeline the report reads, against a truth table both
   * layers assert. Neither input is the account's scalar unless the timeline
   * says nothing.
   *
   * `nextDueDate`/`debt` are null when the loan has no active scheduled payment
   * transferring to it; a projection then has no bill to be in parity with and
   * anchors at today, which the caller keeps as its fallback.
   */
  async getLoanProjectionAnchor(
    userId: string,
    loanAccountId: string,
  ): Promise<{ nextDueDate: string | null; debt: number | null }> {
    return withScopedDb(this.dataSource, async (m) => {
      const loanAccount = await m.getRepository(Account).findOne({
        where: { id: loanAccountId, userId },
      });
      if (
        !loanAccount ||
        !LOAN_LIKE_ACCOUNT_TYPES.has(loanAccount.accountType)
      ) {
        return { nextDueDate: null, debt: null };
      }

      // WHICH schedule is the loan's payment is the account's own statement:
      // `accounts.scheduled_transaction_id` is written by the two paths that
      // set a loan payment up, and INV-LOAN-005's migration relies on the same
      // pointer. Reaching instead for "any active schedule with a transfer
      // split into this loan" answers a different question -- a standalone
      // extra-principal transfer is an ordinary configuration and, due sooner,
      // would win the ORDER BY and anchor the report on an installment no bill
      // will ever post.
      //
      // The fallback covers a loan whose pointer was never written (an older
      // setup, an imported account): a schedule naming the loan as a transfer
      // target, by its top-level column OR by a split -- both spellings,
      // because a plain scheduled transfer into the loan carries no split and
      // the balance forecast already counts it.
      //
      // The date is the one the occurrence FALLS ON, so an override that moved
      // it off its recurrence slot moves the anchor with it -- the posting
      // prices at `postDate` for exactly that reason, and an anchor left on the
      // abandoned slot would put the report back into disagreement with the
      // bill it is supposed to match. The ordering stays on the slot, which is
      // what makes "the next one" well defined.
      const scheduleRows: Array<{ next_due_date: string }> = await m.query(
        `SELECT TO_CHAR(
                  COALESCE(ovr.override_date, st.next_due_date), 'YYYY-MM-DD'
                ) AS next_due_date
           FROM scheduled_transactions st
           LEFT JOIN scheduled_transaction_overrides ovr
             ON ovr.scheduled_transaction_id = st.id
            AND ovr.original_date = st.next_due_date
          WHERE st.user_id = $1
            AND st.is_active = true
            AND (
              st.id = $3::uuid
              OR ($3::uuid IS NULL AND (
                st.transfer_account_id = $2
                OR EXISTS (
                  SELECT 1 FROM scheduled_transaction_splits sts
                   WHERE sts.scheduled_transaction_id = st.id
                     AND sts.transfer_account_id = $2
                )
              ))
            )
          ORDER BY st.next_due_date ASC
          LIMIT 1`,
        [userId, loanAccountId, loanAccount.scheduledTransactionId ?? null],
      );
      const nextDueDate = scheduleRows[0]?.next_due_date ?? null;
      if (!nextDueDate) {
        return { nextDueDate: null, debt: null };
      }

      const debt = await this.datedLoanDebt(m, loanAccount, nextDueDate);
      if (debt === null) {
        // "The ledger could not be read" is not "this loan has no scheduled
        // payment" -- the caller reads the second as licence to project from
        // today's balance, which is the drift this endpoint exists to close.
        throw new ServiceUnavailableException(
          tr(
            "errors.accounts.loanLedgerUnreadable",
            "This loan's balance could not be read. Try again.",
          ),
        );
      }
      return { nextDueDate, debt };
    });
  }

  /** The loan-like account a split set transfers to, if any. */
  private async findLoanAccount(
    m: EntityManager,
    splits: ScheduledTransactionSplit[],
  ): Promise<Account | null> {
    for (const split of splits) {
      if (!split.transferAccountId) continue;
      const candidate = await m.getRepository(Account).findOne({
        where: { id: split.transferAccountId },
      });
      if (candidate && LOAN_LIKE_ACCOUNT_TYPES.has(candidate.accountType)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * The outstanding debt through `asOfDate`, from the authoritative ledger:
   * opening balance plus every non-void, top-level transaction dated on or
   * before that date -- the same expression `recalculateCurrentBalance` and the
   * balances-as-of report use, with the installment boundary in place of today.
   *
   * `accounts.current_balance` deliberately excludes future-dated rows, so it
   * cannot price an installment after a future payment has been posted; and a
   * previously stored principal/interest split is money already rounded to 4dp,
   * so advancing it with an amortization recurrence compounds the rounding
   * (issue #1253). The dated ledger balance is the one source both the next
   * bill and the amortization projection can agree on.
   *
   * Null only when the account row cannot be read back (deleted concurrently);
   * a failed lookup is not a zero balance.
   */
  private async datedLoanDebt(
    m: EntityManager,
    loanAccount: Account,
    asOfDate: string,
  ): Promise<number | null> {
    const rows: Array<{ balance: string }> = await m.query(
      ACCOUNT_BALANCE_AS_OF_SQL,
      [loanAccount.id, loanAccount.userId, asOfDate],
    );
    if (rows.length === 0 || rows[0].balance == null) {
      return null;
    }
    // Debt accounts store the balance negative; an overpaid balance (in
    // credit) reads as retired rather than as fresh debt.
    return Math.max(0, -roundMoney(Number(rows[0].balance)));
  }

  /**
   * The periodic rate the installment accrues at. One lookup for both
   * frequency spellings: the column is a bare VARCHAR written by two paths, so
   * a MORTGAGE row can hold the recurrence spelling SEMIMONTHLY -- cast into
   * getMortgagePeriodsPerYear it fell through to that function's monthly
   * default, and every posted split booked twice the interest for the life of
   * the loan. Account type still decides the COMPOUNDING (Canadian
   * semi-annual); it never decided the count.
   */
  /**
   * The annual rate this loan carries on `asOfDate`, from its recorded rate
   * history, falling back to the account's own scalar when no row applies.
   *
   * Recording a rate change deliberately does not write `accounts.interest_rate`
   * (see `effectiveAnnualRateOn`), so pricing an installment at that column
   * charges a rate nobody pays -- and made the bill disagree with the
   * amortization report even once the two priced the same balance. The rate is
   * dated for the same reason the balance is: a change recorded for next month
   * belongs to next month's installment, not this one.
   */
  private async datedAnnualRate(
    m: EntityManager,
    loanAccount: Account,
    asOfDate: string,
  ): Promise<number> {
    const scalar = Number(loanAccount.interestRate);
    const fallback = Number.isFinite(scalar) ? scalar : 0;
    const rows = await m.getRepository(LoanRateChange).find({
      where: { accountId: loanAccount.id },
      order: { effectiveDate: "ASC" },
    });
    return effectiveAnnualRateOn(rows, asOfDate, fallback) ?? fallback;
  }

  private periodicRateFor(
    loanAccount: Account,
    frequency: PaymentFrequency,
    interestRate: number,
  ): number {
    const periodsPerYear =
      periodsPerYearForStoredFrequency(frequency) ?? DEFAULT_PERIODS_PER_YEAR;

    return loanAccount.accountType === "MORTGAGE"
      ? getPeriodicRate(
          interestRate,
          periodsPerYear,
          loanAccount.isCanadianMortgage,
          loanAccount.isVariableRate,
        )
      : interestRate / 100 / periodsPerYear;
  }

  /**
   * Resolve one installment of a scheduled loan payment: identify the managed
   * template lines, measure the debt through `asOfDate` from the ledger, price
   * the interest at the periodic rate, and run the shared waterfall.
   *
   * Interest comes from the dated ledger balance, never from the previously
   * stored split values: those are money already rounded to 4dp, and the
   * amortization recurrence (`next = prev_interest - prev_principal * rate`)
   * is equivalent to recalculating from balance only when its inputs retain
   * full precision -- so the recurrence drifted from the amortization report by
   * a compounding cent (issue #1253). Both the post-posting recalculation and
   * the posting-boundary resolution price through here, so the template and
   * what actually posts cannot use two different rules.
   */
  private async resolveInstallment(
    m: EntityManager,
    scheduledTransaction: ScheduledTransaction,
    splits: ScheduledTransactionSplit[],
    loanAccount: Account,
    asOfDate: string,
    purpose: InstallmentPurpose,
  ): Promise<ResolvedInstallment> {
    const loanAccountId = loanAccount.id;

    const debt = await this.datedLoanDebt(m, loanAccount, asOfDate);
    if (debt === null) {
      return {
        kind: "unreadable",
        reason: `the ledger balance for loan account ${loanAccountId} could not be read`,
      };
    }

    const templateAmount = Math.abs(Number(scheduledTransaction.amount));
    const interestRate = await this.datedAnnualRate(m, loanAccount, asOfDate);
    const frequency = (loanAccount.paymentFrequency ||
      scheduledTransaction.frequency) as PaymentFrequency;

    // Identify splits: there may be a regular principal transfer, an interest
    // category split, and optionally a separate extra principal transfer.
    // Extra principal splits have memo "Extra Principal" and transfer to the
    // loan account. Regular principal also transfers to the loan account.
    const extraPrincipalSplit = splits.find(
      (s) =>
        s.transferAccountId === loanAccountId &&
        s.memo?.toLowerCase().includes("extra"),
    );
    const principalSplit = splits.find(
      (s) => s.transferAccountId === loanAccountId && s !== extraPrincipalSplit,
    );
    // Prefer the loan's configured interest category. "The first categorized
    // line" is an absence predicate -- it says the line is not the principal
    // transfer, not that it is interest -- so on a template a user has added
    // an escrow or insurance line to it recalculates whichever line happens to
    // be listed first. The configured category is the explicit statement, and
    // it is order-independent.
    const categoryLines = splits.filter(
      (s) => s.categoryId && !s.transferAccountId,
    );
    const interestSplit = loanAccount.interestCategoryId
      ? categoryLines.find(
          (s) => s.categoryId === loanAccount.interestCategoryId,
        )
      : categoryLines.length === 1
        ? categoryLines[0]
        : undefined;

    // This method understands exactly one template shape: a principal
    // transfer, one interest line, and optionally an extra-principal transfer.
    // It reprices the parent as principal + interest + extra, which is the
    // whole template only for that shape -- so a template carrying an escrow,
    // insurance or tax line ends up with a parent that no longer equals the
    // sum of its children, and the posting path's exact-4dp split validator
    // then refuses every occurrence. The schedule stops posting silently, with
    // the amount it would have charged nowhere on screen.
    //
    // So it declines rather than rewriting what it cannot account for. The
    // cost is a P/I split that stays at last period's figures; the alternative
    // cost is a bill that never posts again. Declining also removes the last
    // place a line was chosen by position: with several categorized lines and
    // no configured category, there is nothing here that identifies interest,
    // and guessing is what put an amortization figure onto a property-tax line.
    const unmanagedLines = splits.filter(
      (s) =>
        s !== interestSplit &&
        s !== principalSplit &&
        s !== extraPrincipalSplit,
    );
    const managed = !!interestSplit && unmanagedLines.length === 0;

    // The debt is checked AFTER the shape, so "paid off" can say whether this
    // is a bill whose every line the payoff settles. The order is the whole
    // point: read the other way round, a mortgage template with an escrow line
    // reports the same "paid off" as a plain principal+interest one, and a
    // posting that withholds money on it stops paying the escrow.
    if (debt <= 0.01) {
      return { kind: "paid-off", debt, managed };
    }

    if (!managed) {
      return {
        kind: "declined",
        reason: interestSplit
          ? `${unmanagedLines.length} line(s) beyond principal/interest/extra`
          : loanAccount.interestCategoryId
            ? "no line carries the loan's configured interest category"
            : `${categoryLines.length} categorized lines and no interest category configured on account ${loanAccountId}`,
      };
    }

    // What the template holds is what was just posted -- including any clamp
    // a previous pass wrote for that one installment (a final payment, an
    // interest spike consuming the extra). Deriving the *configured* payment
    // from it therefore ratchets: the clamp becomes the configuration and
    // nothing can grow back, even after the balance is restored by a void or
    // an import (review #1131). The durable configuration lives on the
    // account (payment_amount / extra_payment_amount, kept in sync when the
    // user edits the schedule); the template only wins where it is larger,
    // which can only mean a user edit the account columns have not seen.
    const templateExtraAmount = extraPrincipalSplit
      ? Math.abs(Number(extraPrincipalSplit.amount))
      : 0;
    // Only a template advancement may grow back toward the configured payment;
    // a posting re-divides the bill it was shown (see `InstallmentPurpose`).
    const paymentAmount =
      purpose === "posting"
        ? templateAmount
        : Math.max(templateAmount, Number(loanAccount.paymentAmount) || 0);
    // The extra can only ride in an existing split row -- this recalculation
    // never creates one -- so without the row the configured extra is 0.
    const extraPrincipalAmount = !extraPrincipalSplit
      ? 0
      : purpose === "posting"
        ? templateExtraAmount
        : Math.max(
            templateExtraAmount,
            Number(loanAccount.extraPaymentAmount) || 0,
          );
    const basePaymentAmount = paymentAmount - extraPrincipalAmount;

    const periodicRate = this.periodicRateFor(
      loanAccount,
      frequency,
      interestRate,
    );

    const newInterest = roundMoney(debt * periodicRate);
    const newPrincipal = roundMoney(basePaymentAmount - newInterest);

    // The clamp sequence -- interest-first across the whole installment
    // (recheck RR2-006, DR3-01), principal bounded by the debt with the
    // discretionary extra absorbing the shortfall (audit P5-008, FR-009) --
    // is `allocateLoanPayment`, shared with the first installment written by
    // `LoanPaymentSetupService` because the two must agree about what any
    // installment looks like.
    const allocation = allocateLoanPayment({
      paymentAmount,
      extraPrincipal: extraPrincipalAmount,
      interest: newInterest,
      principal: newPrincipal,
      currentBalance: debt,
    });

    return {
      kind: "ok",
      allocation,
      template: { principalSplit, interestSplit, extraPrincipalSplit },
      debt,
      annualRate: interestRate,
      paymentAmount,
      basePaymentAmount,
      extraPrincipalAmount,
      templateAmount,
      templateExtraAmount,
    };
  }

  async findLoanAccountFromSplits(
    splits: ScheduledTransactionSplit[],
  ): Promise<string | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const account = await this.findLoanAccount(m, splits);
      return account ? account.id : null;
    });
  }
}
