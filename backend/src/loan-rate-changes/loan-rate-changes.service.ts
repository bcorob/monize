import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { LoanRateChange } from "./entities/loan-rate-change.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { CreateLoanRateChangeDto } from "./dto/create-loan-rate-change.dto";
import { UpdateLoanRateChangeDto } from "./dto/update-loan-rate-change.dto";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import {
  calculatePaymentAmount,
  getPeriodicRate,
  recalculateMortgageAfterRateChange,
} from "../accounts/mortgage-amortization.util";
import { roundMoney } from "../common/round.util";
import { todayYMD, formatDateYMDLocal } from "../common/date-utils";
import {
  DEFAULT_PERIODS_PER_YEAR,
  periodsPerYearForStoredFrequency,
  toMortgagePaymentFrequency,
} from "../accounts/payment-frequency.util";

const RATE_CHANGE_ACCOUNT_TYPES = [AccountType.LOAN, AccountType.MORTGAGE];

/**
 * A before/after summary of how a linked scheduled bill payment would change
 * to match the account's new rate/payment. Returned by `create` when the caller
 * defers the sync so the UI can ask the user for permission before applying it.
 */
export interface ScheduledPaymentPreview {
  scheduledTransactionId: string;
  scheduledTransactionName: string | null;
  currencyCode: string;
  /** Absolute total payment amounts (null when unknown from the schedule) */
  currentPaymentAmount: number | null;
  proposedPaymentAmount: number;
  /** Absolute principal/interest portions; current values are null when the
   * schedule's splits do not clearly separate them */
  currentPrincipal: number | null;
  proposedPrincipal: number;
  currentInterest: number | null;
  proposedInterest: number;
  /** Extra-principal split preserved as-is (0 when there is none) */
  extraPrincipal: number;
}

/** The scheduled-payment update to apply, plus its user-facing preview. */
interface ScheduledUpdatePlan {
  scheduledTransactionId: string;
  payload: Parameters<ScheduledTransactionsService["update"]>[2];
  preview: ScheduledPaymentPreview;
}

/** A created rate change plus the pending scheduled-payment change, if any. */
export type CreateLoanRateChangeResult = LoanRateChange & {
  scheduledPaymentPreview: ScheduledPaymentPreview | null;
};

/** Normalize a DATE column value (string at runtime, Date in tests) to YYYY-MM-DD */
export function toYmd(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.split("T")[0];
  return formatDateYMDLocal(value);
}

function dayBefore(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(year, month - 1, day - 1);
  return formatDateYMDLocal(date);
}

/** Whole calendar months from `fromYmd` to `toYmd` (floored at 0) */
function monthsBetweenYmd(fromYmd: string, toYmdStr: string): number {
  const [fromYear, fromMonth] = fromYmd.split("-").map(Number);
  const [toYear, toMonth] = toYmdStr.split("-").map(Number);
  return Math.max(0, (toYear - fromYear) * 12 + (toMonth - fromMonth));
}

@Injectable()
export class LoanRateChangesService {
  private readonly logger = new Logger(LoanRateChangesService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
  ) {}

  async findAll(userId: string, accountId: string): Promise<LoanRateChange[]> {
    await this.verifyLoanAccount(userId, accountId);
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(LoanRateChange).find({
        where: { userId, accountId },
        order: { effectiveDate: "ASC" },
      }),
    );
  }

  /**
   * Record a rate change. The account's own `interestRate`/`paymentAmount` are
   * left untouched (they are user-owned via the edit form); only the linked
   * scheduled bill payment is realigned to the timeline's current rate. By
   * default that resync is applied immediately (the legacy mortgage-rate
   * behaviour). Pass `deferScheduledSync` to instead return a preview of the
   * pending scheduled-payment change and leave it unapplied, so the caller can
   * confirm with the user before applying it via `applyScheduledPaymentSync`.
   */
  async create(
    userId: string,
    accountId: string,
    dto: CreateLoanRateChangeDto,
    options?: { deferScheduledSync?: boolean },
  ): Promise<CreateLoanRateChangeResult> {
    const account = await this.verifyLoanAccount(userId, accountId);

    if (dto.newPaymentAmount != null && dto.recalculatePayment) {
      throw new BadRequestException(
        tr(
          "errors.loanRateChanges.paymentModeConflict",
          "Provide either a new payment amount or recalculatePayment, not both",
        ),
      );
    }
    if (dto.recalculatePayment) {
      if (account.accountType !== AccountType.MORTGAGE) {
        throw new BadRequestException(
          tr(
            "errors.loanRateChanges.recalculateMortgageOnly",
            "Payment recalculation is only available for mortgage accounts",
          ),
        );
      }
      if (account.isClosed) {
        throw new BadRequestException(
          tr(
            "errors.accounts.updateRateClosed",
            "Cannot update rate on a closed account",
          ),
        );
      }
    }

    const newPaymentAmount = dto.recalculatePayment
      ? this.recalculatePaymentForRate(
          account,
          dto.annualRate,
          dto.effectiveDate,
        )
      : (dto.newPaymentAmount ?? null);

    const { saved, resolved } = await withScopedDb(
      this.dataSource,
      async (m) => {
        await this.rejectDuplicateDate(m, accountId, dto.effectiveDate);
        await this.insertInitialRowIfFirst(m, account, dto.effectiveDate);

        const rateChange = m.create(LoanRateChange, {
          userId,
          accountId,
          effectiveDate: dto.effectiveDate,
          annualRate: dto.annualRate,
          newPaymentAmount,
          source: "manual" as const,
          note: dto.note ?? null,
        });

        return {
          saved: await m.save(rateChange),
          resolved: await this.resolveCurrentTimeline(m, account),
        };
      },
    );

    let scheduledPaymentPreview: ScheduledPaymentPreview | null = null;
    if (resolved) {
      if (options?.deferScheduledSync) {
        const plan = await this.buildScheduledUpdate(userId, account, resolved);
        scheduledPaymentPreview = plan?.preview ?? null;
      } else {
        await this.syncScheduledTransaction(userId, account, resolved);
      }
    }
    return { ...saved, scheduledPaymentPreview };
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    dto: UpdateLoanRateChangeDto,
  ): Promise<LoanRateChange> {
    const account = await this.verifyLoanAccount(userId, accountId);
    const rateChange = await this.findOne(userId, accountId, id);

    const { saved, resolved } = await withScopedDb(
      this.dataSource,
      async (m) => {
        if (
          dto.effectiveDate !== undefined &&
          dto.effectiveDate !== rateChange.effectiveDate
        ) {
          await this.rejectDuplicateDate(m, accountId, dto.effectiveDate);
        }

        const merged = m.merge(LoanRateChange, rateChange, {
          ...(dto.effectiveDate !== undefined
            ? { effectiveDate: dto.effectiveDate }
            : {}),
          ...(dto.annualRate !== undefined
            ? { annualRate: dto.annualRate }
            : {}),
          ...(dto.newPaymentAmount !== undefined
            ? { newPaymentAmount: dto.newPaymentAmount }
            : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          // A user-edited inferred row becomes manual so re-running detection
          // never clobbers their correction.
          ...(rateChange.source === "inferred"
            ? { source: "manual" as const }
            : {}),
        });

        return {
          saved: await m.save(merged),
          resolved: await this.resolveCurrentTimeline(m, account),
        };
      },
    );

    if (resolved) {
      await this.syncScheduledTransaction(userId, account, resolved);
    }
    return saved;
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    const account = await this.verifyLoanAccount(userId, accountId);
    const rateChange = await this.findOne(userId, accountId, id);

    const resolved = await withScopedDb(this.dataSource, async (m) => {
      await m.remove(rateChange);
      return this.resolveCurrentTimeline(m, account);
    });

    if (resolved) {
      await this.syncScheduledTransaction(userId, account, resolved);
    }
  }

  /**
   * Resolve the rate and payment in effect today from the timeline WITHOUT
   * mutating the account: the rate is the latest row not in the future; the
   * payment is the latest non-null newPaymentAmount at or before today. Rows
   * dated in the future are recorded but not applied. The account's own
   * `interestRate`/`paymentAmount` remain user-owned (set only via the account
   * edit form) and are never overwritten from the timeline -- so editing rates
   * or running detection can never clobber a manually-set rate/payment. Returns
   * null for a closed account or when no row applies (nothing to resync).
   */
  async resolveCurrentTimeline(
    manager: EntityManager,
    account: Account,
  ): Promise<{ annualRate: number; paymentAmount: number | null } | null> {
    if (account.isClosed) return null;

    const rows = await manager.find(LoanRateChange, {
      where: { accountId: account.id },
      order: { effectiveDate: "ASC" },
    });
    const today = todayYMD();
    const applicable = rows.filter((row) => row.effectiveDate <= today);
    if (applicable.length === 0) return null;

    const latest = applicable[applicable.length - 1];
    const latestWithPayment = [...applicable]
      .reverse()
      .find((row) => row.newPaymentAmount != null);

    return {
      annualRate: Number(latest.annualRate),
      paymentAmount:
        latestWithPayment?.newPaymentAmount != null
          ? Number(latestWithPayment.newPaymentAmount)
          : null,
    };
  }

  /**
   * Resync the linked scheduled payment to the account's current rate and
   * payment. Best-effort, mirroring the tolerance of the mortgage-rate update
   * flow -- the rate history itself is already committed.
   */
  async syncScheduledTransaction(
    userId: string,
    account: Account,
    override?: { annualRate: number; paymentAmount: number | null },
  ): Promise<void> {
    const plan = await this.buildScheduledUpdate(userId, account, override);
    if (!plan) return;
    try {
      await this.scheduledTransactionsService.update(
        userId,
        plan.scheduledTransactionId,
        plan.payload,
      );
    } catch (error) {
      this.logger.warn(
        `Could not update scheduled transaction: ${error.message}`,
      );
    }
  }

  /**
   * Apply the pending scheduled-payment change for an account after the user
   * has granted permission. Recomputes from the account's current (already
   * updated) rate/payment so it matches the preview shown at rate-change time.
   * Returns the applied change, or null when there is nothing to sync.
   */
  async applyScheduledPaymentSync(
    userId: string,
    accountId: string,
  ): Promise<ScheduledPaymentPreview | null> {
    const account = await this.verifyLoanAccount(userId, accountId);
    const resolved = await withScopedDb(this.dataSource, (m) =>
      this.resolveCurrentTimeline(m, account),
    );
    const plan = await this.buildScheduledUpdate(
      userId,
      account,
      resolved ?? undefined,
    );
    if (!plan) return null;
    await this.scheduledTransactionsService.update(
      userId,
      plan.scheduledTransactionId,
      plan.payload,
    );
    return plan.preview;
  }

  /**
   * Recompute the linked scheduled payment's principal/interest split from the
   * account's current balance and rate, preserving any separate extra-principal
   * split (memo contains "extra"). Returns the update to apply plus a
   * before/after preview, or null when the account has no applicable linked
   * scheduled bill payment. Does not apply anything.
   */
  async buildScheduledUpdate(
    userId: string,
    account: Account,
    override?: { annualRate: number; paymentAmount: number | null },
  ): Promise<ScheduledUpdatePlan | null> {
    if (account.isClosed || !account.scheduledTransactionId) return null;
    // The current rate/payment come from the resolved timeline when supplied,
    // else the account's own (user-owned) scalars. The timeline never mutates
    // the account, so this override is how a rate change reaches the bill.
    const annualRate = override?.annualRate ?? account.interestRate;
    const effectivePayment =
      override?.paymentAmount ?? account.paymentAmount ?? null;
    if (annualRate == null || !effectivePayment || !account.paymentFrequency) {
      return null;
    }
    const balance = Math.abs(Number(account.currentBalance));
    if (balance <= 0.01) return null;

    let scheduled: Awaited<ReturnType<ScheduledTransactionsService["findOne"]>>;
    try {
      scheduled = await this.scheduledTransactionsService.findOne(
        userId,
        account.scheduledTransactionId,
      );
    } catch (error) {
      this.logger.warn(
        `Could not load scheduled transaction: ${error.message}`,
      );
      return null;
    }

    const isMortgage = account.accountType === AccountType.MORTGAGE;
    // One lookup for both spellings of the stored cadence; only the COMPOUNDING
    // is mortgage-specific. Two casts into two domain functions meant a
    // semi-monthly mortgage was split at a monthly rate and a quarterly one at
    // three times its rate.
    const periodsPerYear =
      periodsPerYearForStoredFrequency(account.paymentFrequency) ??
      DEFAULT_PERIODS_PER_YEAR;
    const periodicRate = isMortgage
      ? getPeriodicRate(
          annualRate,
          periodsPerYear,
          account.isCanadianMortgage || false,
          account.isVariableRate || false,
        )
      : annualRate / 100 / periodsPerYear;

    const paymentAmount = Number(effectivePayment);
    let interest = roundMoney(balance * periodicRate);
    if (interest > paymentAmount) interest = paymentAmount;
    let principal = roundMoney(paymentAmount - interest);
    if (principal > balance) principal = roundMoney(balance);

    const splits = scheduled.splits || [];
    const extraSplit = splits.find(
      (s) =>
        s.transferAccountId === account.id &&
        s.memo?.toLowerCase().includes("extra"),
    );
    const extraAmount = extraSplit ? Math.abs(Number(extraSplit.amount)) : 0;
    const proposedPaymentAmount = roundMoney(paymentAmount + extraAmount);

    const payload = {
      amount: -proposedPaymentAmount,
      splits: [
        {
          transferAccountId: account.id,
          amount: -principal,
          memo: "Principal",
        },
        {
          categoryId: account.interestCategoryId || undefined,
          amount: -interest,
          memo: "Interest",
        },
        ...(extraSplit
          ? [
              {
                transferAccountId: account.id,
                amount: -extraAmount,
                memo: extraSplit.memo || "Extra Principal",
              },
            ]
          : []),
      ],
    };

    const principalSplit = splits.find(
      (s) =>
        s.transferAccountId === account.id &&
        !s.memo?.toLowerCase().includes("extra"),
    );
    const interestSplit = splits.find(
      (s) =>
        !s.transferAccountId &&
        (s.categoryId != null || s.memo?.toLowerCase().includes("interest")),
    );

    const preview: ScheduledPaymentPreview = {
      scheduledTransactionId: account.scheduledTransactionId,
      scheduledTransactionName: scheduled.name ?? null,
      currencyCode: scheduled.currencyCode ?? account.currencyCode ?? "",
      currentPaymentAmount:
        scheduled.amount != null ? Math.abs(Number(scheduled.amount)) : null,
      proposedPaymentAmount,
      currentPrincipal: principalSplit
        ? Math.abs(Number(principalSplit.amount))
        : null,
      proposedPrincipal: principal,
      currentInterest: interestSplit
        ? Math.abs(Number(interestSplit.amount))
        : null,
      proposedInterest: interest,
      extraPrincipal: extraAmount,
    };

    return {
      scheduledTransactionId: account.scheduledTransactionId,
      payload,
      preview,
    };
  }

  /**
   * Snapshot the origination rate as an 'initial' row the first time any
   * change is recorded, so the timeline carries an explicit anchor for the
   * pre-change rate rather than relying on the account's current scalar.
   */
  async insertInitialRowIfFirst(
    manager: EntityManager,
    account: Account,
    firstChangeDate: string,
  ): Promise<void> {
    const count = await manager.count(LoanRateChange, {
      where: { accountId: account.id },
    });
    if (count > 0) return;
    if (account.interestRate == null) return;

    const startDate = toYmd(account.paymentStartDate);
    const effectiveDate =
      startDate && startDate < firstChangeDate
        ? startDate
        : dayBefore(firstChangeDate);

    const initial = manager.create(LoanRateChange, {
      userId: account.userId,
      accountId: account.id,
      effectiveDate,
      annualRate: Number(account.interestRate),
      newPaymentAmount:
        account.paymentAmount != null ? Number(account.paymentAmount) : null,
      source: "initial" as const,
      note: null,
    });
    await manager.save(initial);
  }

  /** Ownership and type gate applied before any rate-change operation */
  async verifyLoanAccount(userId: string, accountId: string): Promise<Account> {
    const account = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      }),
    );
    if (!account) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${accountId} not found`,
          { id: accountId },
        ),
      );
    }
    if (!RATE_CHANGE_ACCOUNT_TYPES.includes(account.accountType)) {
      throw new BadRequestException(
        tr(
          "errors.loanRateChanges.notLoanAccount",
          "Rate changes are only available for loan and mortgage accounts",
        ),
      );
    }
    return account;
  }

  private async findOne(
    userId: string,
    accountId: string,
    id: string,
  ): Promise<LoanRateChange> {
    const rateChange = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(LoanRateChange).findOne({
        where: { id, userId, accountId },
      }),
    );
    if (!rateChange) {
      throw new NotFoundException(
        tr(
          "errors.loanRateChanges.notFound",
          `Rate change with ID ${id} not found`,
          { id },
        ),
      );
    }
    return rateChange;
  }

  private async rejectDuplicateDate(
    manager: EntityManager,
    accountId: string,
    effectiveDate: string,
  ): Promise<void> {
    const existing = await manager.findOne(LoanRateChange, {
      where: { accountId, effectiveDate },
    });
    if (existing) {
      throw new ConflictException(
        tr(
          "errors.loanRateChanges.duplicateDate",
          `A rate change effective ${effectiveDate} already exists for this account`,
          { date: effectiveDate },
        ),
      );
    }
  }

  /**
   * Payment that holds the remaining amortization constant at the new rate
   * (the pre-history mortgage-rate endpoint's behaviour, now opt-in).
   */
  private recalculatePaymentForRate(
    account: Account,
    annualRate: number,
    effectiveDate: string,
  ): number {
    const currentBalance = Math.abs(Number(account.currentBalance));
    const startDate = toYmd(account.paymentStartDate) ?? todayYMD();
    const monthsElapsed = monthsBetweenYmd(startDate, effectiveDate);
    const remainingAmortizationMonths = Math.max(
      12,
      (account.amortizationMonths || 300) - monthsElapsed,
    );

    // Converted, not cast. `recalculateMortgageAfterRateChange` derives its
    // periodic rate from a MORTGAGE-domain cadence, and the column can hold the
    // recurrence spelling: casting handed it SEMIMONTHLY, which its lookup read
    // as monthly, so the recalculated installment was a whole month's payment on
    // a half-monthly schedule -- persisted on the rate change and pushed into
    // the scheduled transaction. Quarterly and yearly have no mortgage cadence
    // at all, so those amortize on the standard convention instead of being
    // forced into a mortgage shape the helpers cannot express.
    const mortgageFrequency = toMortgagePaymentFrequency(
      account.paymentFrequency || "MONTHLY",
    );
    if (!mortgageFrequency) {
      const periodsPerYear =
        periodsPerYearForStoredFrequency(account.paymentFrequency) ??
        DEFAULT_PERIODS_PER_YEAR;
      // The COMPOUNDING is still the account's own, even where the cadence is
      // not one the mortgage helpers can express. Amortizing on the nominal
      // convention here would have derived the persisted installment one way
      // and the split this file computes 200 lines above it the other, for the
      // same Canadian account -- two conventions for one mortgage.
      return calculatePaymentAmount(
        currentBalance,
        getPeriodicRate(
          annualRate,
          periodsPerYear,
          account.isCanadianMortgage || false,
          account.isVariableRate || false,
        ),
        Math.max(
          1,
          Math.round((remainingAmortizationMonths * periodsPerYear) / 12),
        ),
      );
    }

    const result = recalculateMortgageAfterRateChange(
      currentBalance,
      annualRate,
      remainingAmortizationMonths,
      mortgageFrequency,
      account.isCanadianMortgage || false,
      account.isVariableRate || false,
    );
    return result.paymentAmount;
  }
}
