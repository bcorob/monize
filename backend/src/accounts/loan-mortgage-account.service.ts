import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { Institution } from "../institutions/entities/institution.entity";
import { CreateAccountDto } from "./dto/create-account.dto";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { FrequencyType as FrequencyTypeDto } from "../scheduled-transactions/dto/create-scheduled-transaction.dto";
import {
  calculateAmortization,
  LOAN_FREQUENCY_TO_RECURRENCE,
  MAX_DATEABLE_PAYMENTS,
  PaymentFrequency,
  AmortizationResult,
} from "./loan-amortization.util";
import {
  calculateMortgageAmortization,
  getPeriodicRate,
  MORTGAGE_FREQUENCY_TO_RECURRENCE,
  MortgagePaymentFrequency,
  MortgageAmortizationInput,
  MortgageAmortizationResult,
} from "./mortgage-amortization.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  mortgageTermEndDate,
  periodsPerYearForStoredFrequency,
} from "./payment-frequency.util";
import { formatDateYMD, localDateForColumn } from "../common/date-utils";
import { roundMoney } from "../common/round.util";
import { tr } from "../i18n/translate";
import { LoanRateChangesService } from "../loan-rate-changes/loan-rate-changes.service";
import { withScopedDb } from "../common/db/scoped-db";

@Injectable()
export class LoanMortgageAccountService {
  private readonly logger = new Logger(LoanMortgageAccountService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => CategoriesService))
    private categoriesService: CategoriesService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
    @Inject(forwardRef(() => LoanRateChangesService))
    private loanRateChangesService: LoanRateChangesService,
  ) {}

  /**
   * Resolve a display name for the lender/institution backing a loan or
   * mortgage. The account form sends the selected institution as `institutionId`
   * (the modern Institutions table) and no longer fills the legacy free-text
   * `institution` field, so requiring the latter rejected accounts that did have
   * an institution set. Prefer the explicit free-text value when present (legacy
   * callers, imports), otherwise look the name up from the referenced
   * institution. Returns null when neither is available.
   */
  private async resolveInstitutionName(
    userId: string,
    institutionId: string | undefined,
    institution: string | undefined,
  ): Promise<string | null> {
    if (institution && institution.trim()) {
      return institution.trim();
    }
    if (institutionId) {
      const found = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Institution).findOne({
          where: { id: institutionId, userId },
        }),
      );
      return found?.name ?? null;
    }
    return null;
  }

  async createLoanAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account> {
    const {
      openingBalance = 0,
      paymentAmount,
      paymentFrequency,
      paymentStartDate,
      sourceAccountId,
      interestCategoryId,
      interestRate,
      institution,
      ...accountData
    } = createAccountDto;

    if (
      !paymentAmount ||
      !paymentFrequency ||
      !paymentStartDate ||
      !sourceAccountId
    ) {
      throw new BadRequestException(
        tr(
          "errors.accounts.loanRequiredFields",
          "Loan accounts require paymentAmount, paymentFrequency, paymentStartDate, and sourceAccountId",
        ),
      );
    }
    if (interestRate === undefined || interestRate === null) {
      throw new BadRequestException(
        tr(
          "errors.accounts.loanRequiresInterestRate",
          "Loan accounts require an interest rate",
        ),
      );
    }
    const institutionName = await this.resolveInstitutionName(
      userId,
      accountData.institutionId,
      institution,
    );
    if (!institutionName) {
      throw new BadRequestException(
        tr(
          "errors.accounts.loanRequiresInstitution",
          "Loan accounts require an institution name",
        ),
      );
    }

    let interestCatId = interestCategoryId;

    if (!interestCatId) {
      const { interestCategory } =
        await this.categoriesService.findLoanCategories(userId);
      if (interestCategory) {
        interestCatId = interestCategory.id;
      }
    }

    const loanAmount = Math.abs(openingBalance);
    const amortization = calculateAmortization(
      loanAmount,
      interestRate,
      paymentAmount,
      paymentFrequency as PaymentFrequency,
      new Date(paymentStartDate),
    );

    const savedAccount = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(Account);
      const account = repo.create({
        ...accountData,
        userId,
        openingBalance: -loanAmount,
        currentBalance: -loanAmount,
        interestRate,
        institution,
        paymentAmount,
        paymentFrequency,
        // A TypeORM `date` column, serialized with local getters: a UTC-midnight
        // value is stored a day early west of Greenwich, and this date anchors
        // every amortization the account later computes.
        paymentStartDate: localDateForColumn(paymentStartDate),
        sourceAccountId,
        interestCategoryId: interestCatId || null,
      });
      return repo.save(account);
    });

    const endDateStr =
      // The same ceiling the end-date helpers date up to. Two literals
      // disagreed at the boundary: the util dated exactly 10000 while this
      // refused it, so one schedule had a payoff date and no scheduled end.
      amortization.totalPayments > 0 &&
      amortization.totalPayments <= MAX_DATEABLE_PAYMENTS
        ? formatDateYMD(amortization.endDate)
        : undefined;

    const scheduledTransaction = await this.scheduledTransactionsService.create(
      userId,
      {
        accountId: sourceAccountId,
        name: `Loan Payment - ${savedAccount.name}`,
        payeeName: institutionName,
        amount: -paymentAmount,
        currencyCode: accountData.currencyCode,
        // Through the loan-to-recurrence table rather than a cast. Every loan
        // frequency happens to share its spelling with a recurrence frequency
        // except SEMIMONTHLY, and a cast is exactly how that kind of mismatch
        // reaches the database unvalidated (`as any` skips class-validator: the
        // pipe only runs on controller input, and the column has no CHECK).
        frequency:
          FrequencyTypeDto[
            LOAN_FREQUENCY_TO_RECURRENCE[paymentFrequency as PaymentFrequency]
          ],
        nextDueDate: paymentStartDate,
        startDate: paymentStartDate,
        endDate: endDateStr,
        isActive: true,
        autoPost: false,
        splits: [
          {
            transferAccountId: savedAccount.id,
            amount: -amortization.principalPayment,
            memo: "Principal",
          },
          {
            categoryId: interestCatId || undefined,
            amount: -amortization.interestPayment,
            memo: "Interest",
          },
        ],
      },
    );

    savedAccount.scheduledTransactionId = scheduledTransaction.id;
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).save(savedAccount),
    );

    return savedAccount;
  }

  async createMortgageAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account> {
    const {
      openingBalance = 0,
      mortgagePaymentFrequency,
      paymentStartDate,
      sourceAccountId,
      interestCategoryId,
      interestRate,
      institution,
      isCanadianMortgage = false,
      isVariableRate = false,
      termMonths,
      amortizationMonths,
      ...accountData
    } = createAccountDto;

    if (
      !mortgagePaymentFrequency ||
      !paymentStartDate ||
      !sourceAccountId ||
      !amortizationMonths
    ) {
      throw new BadRequestException(
        tr(
          "errors.accounts.mortgageRequiredFields",
          "Mortgage accounts require mortgagePaymentFrequency, paymentStartDate, sourceAccountId, and amortizationMonths",
        ),
      );
    }
    if (interestRate === undefined || interestRate === null) {
      throw new BadRequestException(
        tr(
          "errors.accounts.mortgageRequiresInterestRate",
          "Mortgage accounts require an interest rate",
        ),
      );
    }
    const institutionName = await this.resolveInstitutionName(
      userId,
      accountData.institutionId,
      institution,
    );
    if (!institutionName) {
      throw new BadRequestException(
        tr(
          "errors.accounts.mortgageRequiresInstitution",
          "Mortgage accounts require an institution name",
        ),
      );
    }

    let interestCatId = interestCategoryId;

    if (!interestCatId) {
      const { interestCategory } =
        await this.categoriesService.findLoanCategories(userId);
      if (interestCategory) {
        interestCatId = interestCategory.id;
      }
    }

    const mortgageAmount = Math.abs(openingBalance);
    const amortizationInput: MortgageAmortizationInput = {
      principal: mortgageAmount,
      annualRate: interestRate,
      amortizationMonths,
      paymentFrequency: mortgagePaymentFrequency,
      isCanadian: isCanadianMortgage,
      isVariableRate,
      startDate: new Date(paymentStartDate),
    };
    const amortization = calculateMortgageAmortization(amortizationInput);

    const termEndDate = termMonths
      ? mortgageTermEndDate(new Date(paymentStartDate), termMonths)
      : null;

    const savedAccount = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(Account);
      const account = repo.create({
        ...accountData,
        userId,
        openingBalance: -mortgageAmount,
        currentBalance: -mortgageAmount,
        interestRate,
        institution,
        paymentAmount: amortization.paymentAmount,
        paymentFrequency: mortgagePaymentFrequency,
        // A TypeORM `date` column, serialized with local getters: a UTC-midnight
        // value is stored a day early west of Greenwich, and this date anchors
        // every amortization the account later computes.
        paymentStartDate: localDateForColumn(paymentStartDate),
        sourceAccountId,
        interestCategoryId: interestCatId || null,
        isCanadianMortgage,
        isVariableRate,
        termMonths: termMonths || null,
        termEndDate,
        amortizationMonths,
        originalPrincipal: mortgageAmount,
      });
      return repo.save(account);
    });

    // The one mortgage-to-recurrence table, shared with calculateMortgageEndDate
    // so the payoff date and the schedule that reaches it cannot disagree. It
    // used to be a local copy that mapped SEMI_MONTHLY to itself -- a value the
    // recurrence engine does not recognize, whose `default` returns the same
    // date, so the occurrence was due forever and the mortgage's payment
    // schedule never advanced. Migration 165 heals the rows that copy wrote.
    const scheduledFrequency =
      MORTGAGE_FREQUENCY_TO_RECURRENCE[mortgagePaymentFrequency];

    const endDateStr =
      // The same ceiling the end-date helpers date up to. Two literals
      // disagreed at the boundary: the util dated exactly 10000 while this
      // refused it, so one schedule had a payoff date and no scheduled end.
      amortization.totalPayments > 0 &&
      amortization.totalPayments <= MAX_DATEABLE_PAYMENTS
        ? formatDateYMD(amortization.endDate)
        : undefined;

    const scheduledTransaction = await this.scheduledTransactionsService.create(
      userId,
      {
        accountId: sourceAccountId,
        name: `Mortgage Payment - ${savedAccount.name}`,
        payeeName: institutionName,
        amount: -amortization.paymentAmount,
        currencyCode: accountData.currencyCode,
        frequency: FrequencyTypeDto[scheduledFrequency],
        nextDueDate: paymentStartDate,
        startDate: paymentStartDate,
        endDate: endDateStr,
        isActive: true,
        autoPost: false,
        splits: [
          {
            transferAccountId: savedAccount.id,
            amount: -amortization.principalPayment,
            memo: "Principal",
          },
          {
            categoryId: interestCatId || undefined,
            amount: -amortization.interestPayment,
            memo: "Interest",
          },
        ],
      },
    );

    savedAccount.scheduledTransactionId = scheduledTransaction.id;
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).save(savedAccount),
    );

    return savedAccount;
  }

  previewMortgageAmortization(
    mortgageAmount: number,
    interestRate: number,
    amortizationMonths: number,
    paymentFrequency: MortgagePaymentFrequency,
    paymentStartDate: Date,
    isCanadian: boolean,
    isVariableRate: boolean,
  ): MortgageAmortizationResult {
    return calculateMortgageAmortization({
      principal: Math.abs(mortgageAmount),
      annualRate: interestRate,
      amortizationMonths,
      paymentFrequency,
      isCanadian,
      isVariableRate,
      startDate: paymentStartDate,
    });
  }

  previewLoanAmortization(
    loanAmount: number,
    interestRate: number,
    paymentAmount: number,
    paymentFrequency: PaymentFrequency,
    paymentStartDate: Date,
  ): AmortizationResult {
    return calculateAmortization(
      Math.abs(loanAmount),
      interestRate,
      paymentAmount,
      paymentFrequency,
      paymentStartDate,
    );
  }

  /**
   * Legacy mortgage-rate endpoint, now a thin wrapper over the rate-change
   * timeline: every call records a history row (finally persisting the
   * effective date) and, when no explicit payment is given, keeps the old
   * recalculate-to-hold-amortization default via recalculatePayment.
   */
  async updateMortgageRate(
    account: Account,
    userId: string,
    newRate: number,
    effectiveDate: Date,
    newPaymentAmount?: number,
  ): Promise<{
    newRate: number;
    paymentAmount: number;
    principalPayment: number;
    interestPayment: number;
    effectiveDate: string;
  }> {
    if (account.accountType !== AccountType.MORTGAGE) {
      throw new BadRequestException(
        tr(
          "errors.accounts.onlyMortgageAccounts",
          "This operation is only valid for mortgage accounts",
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

    const rateChange = await this.loanRateChangesService.create(
      userId,
      account.id,
      {
        effectiveDate: formatDateYMD(effectiveDate),
        annualRate: newRate,
        newPaymentAmount: newPaymentAmount ?? null,
        recalculatePayment: newPaymentAmount == null,
      },
    );

    const currentBalance = Math.abs(Number(account.currentBalance));
    const paymentAmount =
      rateChange.newPaymentAmount ?? (Number(account.paymentAmount) || 0);
    const periodicRate = getPeriodicRate(
      newRate,
      // The STORED cadence, read through the lookup that knows both spellings.
      // Casting it to MortgagePaymentFrequency and asking
      // getMortgagePeriodsPerYear turned SEMIMONTHLY into its monthly default,
      // so a semi-monthly mortgage's posted split carried twice the interest.
      periodsPerYearForStoredFrequency(account.paymentFrequency) ??
        DEFAULT_PERIODS_PER_YEAR,
      account.isCanadianMortgage || false,
      account.isVariableRate || false,
    );
    const interestPayment = roundMoney(currentBalance * periodicRate);
    const principalPayment = roundMoney(paymentAmount - interestPayment);

    return {
      newRate,
      paymentAmount,
      principalPayment,
      interestPayment,
      effectiveDate: rateChange.effectiveDate,
    };
  }
}
