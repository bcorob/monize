import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import {
  SetupLoanPaymentsDto,
  SetupLoanPaymentsResponseDto,
} from "./dto/setup-loan-payments.dto";
import { roundMoney } from "../common/round.util";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import {
  calculatePaymentSplit,
  PaymentFrequency,
  SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY,
} from "./loan-amortization.util";
import {
  calculateMortgagePaymentSplit,
  toMortgagePaymentFrequency,
} from "./mortgage-amortization.util";
import { mortgageTermEndDate } from "./payment-frequency.util";
import { localDateForColumn } from "../common/date-utils";
import { allocateLoanPayment } from "./loan-payment-waterfall.util";
import { FrequencyType as FrequencyTypeDto } from "../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";

@Injectable()
export class LoanPaymentSetupService {
  private readonly logger = new Logger(LoanPaymentSetupService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => CategoriesService))
    private categoriesService: CategoriesService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
  ) {}

  /**
   * Set up scheduled loan/mortgage payments for an existing account.
   * Creates a scheduled transaction with principal/interest splits
   * and updates the account's loan-specific fields.
   */
  async setupLoanPayments(
    userId: string,
    accountId: string,
    dto: SetupLoanPaymentsDto,
  ): Promise<SetupLoanPaymentsResponseDto> {
    const account = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      }),
    );

    if (!account) {
      throw new NotFoundException(
        tr("errors.accounts.notFound", "Account not found"),
      );
    }

    if (
      account.accountType !== AccountType.LOAN &&
      account.accountType !== AccountType.MORTGAGE &&
      account.accountType !== AccountType.LINE_OF_CREDIT
    ) {
      throw new BadRequestException(
        tr(
          "errors.accounts.onlyLoanMortgageLoc",
          "Only loan, mortgage, and line of credit accounts support scheduled payment setup",
        ),
      );
    }

    if (account.scheduledTransactionId) {
      throw new BadRequestException(
        tr(
          "errors.accounts.alreadyHasScheduledPayment",
          "This account already has a scheduled payment configured. Edit the existing scheduled transaction instead.",
        ),
      );
    }

    // Verify source account exists and belongs to user
    const sourceAccount = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: dto.sourceAccountId, userId },
      }),
    );
    if (!sourceAccount) {
      throw new BadRequestException(
        tr("errors.accounts.sourceNotFound", "Source account not found"),
      );
    }

    // Resolve interest category
    let interestCategoryId = dto.interestCategoryId || null;
    if (!interestCategoryId) {
      const { interestCategory } =
        await this.categoriesService.findLoanCategories(userId);
      if (interestCategory) {
        interestCategoryId = interestCategory.id;
      }
    }

    // Calculate principal/interest split for the next payment
    const currentBalance = Math.abs(Number(account.currentBalance));
    const interestRate = dto.interestRate || Number(account.interestRate) || 0;
    const extraPrincipal = dto.extraPrincipal || 0;
    // Base payment amount excludes extra principal for split calculation
    const basePaymentAmount = dto.paymentAmount - extraPrincipal;

    let principalPayment: number;
    let interestPayment: number;

    if (dto.detectedInterestAmount != null && dto.detectedInterestAmount >= 0) {
      // Use the interest amount detected from imported transaction history.
      // This continues the actual P/I ratio from the existing data rather than
      // recalculating from the amortization formula, which may differ due to
      // compounding method, rate changes, or rounding differences.
      interestPayment = dto.detectedInterestAmount;
      principalPayment = basePaymentAmount - interestPayment;
      if (principalPayment < 0) {
        principalPayment = 0;
      }
    } else if (
      account.accountType === AccountType.MORTGAGE &&
      // `??`, not `||`: the same request WRITES this flag
      // (`updateData.isCanadianMortgage = dto.isCanadianMortgage` below), so an
      // explicit `false` means "this is not a Canadian mortgage" and must decide
      // the split it is submitted with. Under `||` the stored flag won, and the
      // account was saved as non-Canadian with a split computed the Canadian
      // way -- and the setup dialog, which filters its cadence list on the
      // checkbox, offered quarterly to an account the server then refused.
      (dto.isCanadianMortgage ?? account.isCanadianMortgage)
    ) {
      // Use mortgage-specific calculation for Canadian mortgages.
      //
      // The DTO's frequency is a *recurrence* spelling, and casting it into
      // MortgagePaymentFrequency handed getMortgagePeriodsPerYear a value it has
      // no case for: SEMIMONTHLY, QUARTERLY and YEARLY all fell through to its
      // monthly default, so a semi-monthly Canadian mortgage was split at twice
      // the correct interest for the life of the loan. Normalize instead, and
      // refuse a cadence these helpers cannot express rather than computing a
      // confident wrong number for it.
      const mortgageFrequency = toMortgagePaymentFrequency(
        dto.paymentFrequency,
      );
      if (!mortgageFrequency) {
        throw new BadRequestException(
          tr(
            "errors.accounts.mortgageFrequencyUnsupported",
            "Canadian mortgages cannot be scheduled at this payment frequency",
            { frequency: dto.paymentFrequency },
          ),
        );
      }
      const split = calculateMortgagePaymentSplit(
        currentBalance,
        interestRate,
        basePaymentAmount,
        mortgageFrequency,
        dto.isCanadianMortgage ?? account.isCanadianMortgage ?? false,
        dto.isVariableRate ?? account.isVariableRate ?? false,
      );
      principalPayment = split.principal;
      interestPayment = split.interest;
    } else if (interestRate > 0) {
      const split = calculatePaymentSplit(
        currentBalance,
        interestRate,
        basePaymentAmount,
        dto.paymentFrequency as PaymentFrequency,
      );
      principalPayment = split.principal;
      interestPayment = split.interest;
    } else {
      // No interest rate: the whole of the base payment goes to principal.
      //
      // This branch alone used `dto.paymentAmount` rather than
      // `basePaymentAmount`, so extra principal was counted twice -- once inside
      // the regular principal child and again in its own child. The children
      // then summed to payment + extra against a parent of payment, and
      // `ScheduledTransactionsService.create` validates that sum to exact 4dp
      // equality: setting up payments on a 0% loan with any extra principal
      // failed outright.
      principalPayment = basePaymentAmount;
      interestPayment = 0;
    }

    // The clamp sequence -- interest-first, balance caps, extra absorbing the
    // shortfall -- is `allocateLoanPayment`, shared with the per-posting
    // recalculation in `ScheduledTransactionLoanService` because the two must
    // agree about what any installment looks like. A zero recorded balance
    // here means the history has not been imported yet, not that the loan is
    // paid off, so it does not bound the payment.
    const allocation = allocateLoanPayment({
      paymentAmount: dto.paymentAmount,
      extraPrincipal,
      interest: interestPayment,
      principal: principalPayment,
      currentBalance: currentBalance > 0 ? currentBalance : null,
    });
    principalPayment = allocation.principal;
    interestPayment = allocation.interest;
    const scheduledExtraPrincipal = allocation.extraPrincipal;
    const parentAmount = allocation.total;

    // The DTO accepts loan spellings; mortgage callers may also carry the
    // mortgage ones, so both tables are merged rather than a third copy written.
    // Deriving it means a new frequency in either domain is scheduled correctly
    // here without anybody remembering this line.
    //
    // Refused rather than defaulted. `?? "MONTHLY"` scheduled an unmapped
    // frequency twelve times a year and said nothing -- the same silent
    // fall-through migration 165 exists to heal -- and the `as any` that used to
    // sit on the payload below hid it from the compiler too. A frequency the
    // table cannot express is a 400, and `loan-payment-frequency.guard.spec.ts`
    // reads the DTO's own `@IsIn` list so the refusal is unreachable for every
    // value the DTO actually accepts.
    const scheduledFrequency =
      SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY[dto.paymentFrequency];
    if (!scheduledFrequency) {
      throw new BadRequestException(
        tr(
          "errors.accounts.paymentFrequencyUnsupported",
          "This payment frequency cannot be scheduled",
          { frequency: dto.paymentFrequency },
        ),
      );
    }

    // Build scheduled transaction splits
    const splits: Array<{
      transferAccountId?: string;
      categoryId?: string;
      amount: number;
      memo: string;
    }> = [
      {
        transferAccountId: accountId,
        amount: -principalPayment,
        memo: "Principal",
      },
    ];

    if (interestPayment > 0) {
      splits.push({
        categoryId: interestCategoryId || undefined,
        amount: -interestPayment,
        memo: "Interest",
      });
    }

    // Extra principal as a separate transfer split to the loan account,
    // matching the structure of imported transactions
    if (scheduledExtraPrincipal > 0) {
      splits.push({
        transferAccountId: accountId,
        amount: -scheduledExtraPrincipal,
        memo: "Extra Principal",
      });
    }

    const accountLabel =
      account.accountType === AccountType.MORTGAGE ? "Mortgage" : "Loan";

    // Create the scheduled transaction
    const scheduledTransaction = await this.scheduledTransactionsService.create(
      userId,
      {
        accountId: dto.sourceAccountId,
        name: `${accountLabel} Payment - ${account.name}`,
        payeeId: dto.payeeId || undefined,
        payeeName: dto.payeeName || account.institution || undefined,
        amount: -parentAmount,
        currencyCode: account.currencyCode,
        frequency: FrequencyTypeDto[scheduledFrequency],
        nextDueDate: dto.nextDueDate,
        startDate: dto.nextDueDate,
        isActive: true,
        autoPost: dto.autoPost ?? false,
        splits,
      },
    );

    // Update the account with loan payment details
    const updateData: Partial<Account> = {
      paymentAmount: dto.paymentAmount,
      // The configured standing instruction, not the possibly-clamped first
      // installment: this is what the recalculation grows the extra back to
      // once a transient clamp (an interest spike) has passed.
      extraPaymentAmount: extraPrincipal,
      paymentFrequency: dto.paymentFrequency,
      // Through `localDateForColumn`, not `new Date(...)`: this is a TypeORM
      // `date` column, serialized with local getters, so a UTC-midnight value
      // is stored a day early west of Greenwich -- and this date anchors every
      // amortization the account later computes.
      paymentStartDate: localDateForColumn(dto.nextDueDate),
      sourceAccountId: dto.sourceAccountId,
      interestCategoryId,
      scheduledTransactionId: scheduledTransaction.id,
    };

    if (interestRate > 0) {
      updateData.interestRate = interestRate;
    }

    if (account.accountType === AccountType.MORTGAGE) {
      if (dto.isCanadianMortgage !== undefined) {
        updateData.isCanadianMortgage = dto.isCanadianMortgage;
      }
      if (dto.isVariableRate !== undefined) {
        updateData.isVariableRate = dto.isVariableRate;
      }
      if (dto.amortizationMonths) {
        updateData.amortizationMonths = dto.amortizationMonths;
      }
      if (dto.termMonths) {
        updateData.termMonths = dto.termMonths;
        updateData.termEndDate = mortgageTermEndDate(
          new Date(dto.nextDueDate),
          dto.termMonths,
        );
      }
      if (!account.originalPrincipal) {
        updateData.originalPrincipal = Math.abs(Number(account.openingBalance));
      }
    }

    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).update(accountId, updateData),
    );

    this.logger.log(
      `Set up ${accountLabel.toLowerCase()} payments for account ${account.name}: ` +
        `$${dto.paymentAmount} ${dto.paymentFrequency}, next due ${dto.nextDueDate}` +
        (parentAmount !== roundMoney(dto.paymentAmount)
          ? `, first installment clamped to $${parentAmount} against the outstanding balance`
          : ""),
    );

    return {
      scheduledTransactionId: scheduledTransaction.id,
      accountId,
      paymentAmount: dto.paymentAmount,
      firstInstallmentAmount: parentAmount,
      paymentFrequency: dto.paymentFrequency,
      nextDueDate: dto.nextDueDate,
    };
  }
}
