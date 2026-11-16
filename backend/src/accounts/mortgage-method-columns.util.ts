import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { effectiveAnnualRateOn } from "./effective-loan-rate.util";
import { datedAnnuityInstallment } from "./annuity-relevel.util";
import { assertMortgageMethodTerms } from "./mortgage-installment.util";
import {
  MortgageType,
  PrepaymentMode,
  amortizationMethodFor,
  mortgageTypeOf,
  prepaymentModeColumn,
  prepaymentModeOf,
  storesConstantPayment,
} from "./mortgage-type.util";
import { todayYMD } from "../common/date-utils";
import { roundMoney } from "../common/round.util";
import { tr } from "../i18n/translate";

/**
 * The next due date of the account's linked loan payment, or null when it has
 * none. Read raw with `TO_CHAR`, so the date is the stored calendar date.
 */
async function nextLoanDueDate(
  m: EntityManager,
  account: Account,
): Promise<string | null> {
  if (!account.scheduledTransactionId) return null;
  const rows: Array<{ next_due_date: string | null }> = await m.query(
    `SELECT TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date
       FROM scheduled_transactions
      WHERE id = $1 AND user_id = $2`,
    [account.scheduledTransactionId, account.userId],
  );
  return rows[0]?.next_due_date ?? null;
}

/**
 * The method-dependent columns an account update writes beside the mortgage
 * type, in the same transaction as the type (spec decisions 10 and 11,
 * section 5.6). Mutates `account`, which already carries the saved type.
 *
 * - `prepayment_mode`: the requested mode, else the stored one, for LINEAR;
 *   null for every other type and every other account type.
 * - `payment_amount`: null for LINEAR and INTEREST_ONLY, which are refused
 *   first when a term their method needs is missing (spec section 8). A
 *   mortgage moved from one of those back to an annuity type gets the annuity
 *   installment of its dated debt over the remaining amortization at the rate
 *   in force on its next due date (`datedAnnuityInstallment`, the section 5.3
 *   ANNUITY formula), plus its standing extra, because an annuity mortgage
 *   must carry its constant payment again; with no rate to price at it is
 *   refused, never re-levelled at 0%. A save between two annuity types leaves
 *   the column as the request set it, as before.
 *
 * Answers whether the linked template must be repriced in the same
 * transaction (`ScheduledTransactionsService.repriceLoanTemplate`): the
 * method changed, or a LINEAR mortgage's mode did, so the installment the
 * template holds was priced by a rule the mortgage no longer follows.
 */
export async function applyMortgageMethodColumns(
  m: EntityManager,
  account: Account,
  previous: { type: MortgageType | null; mode: PrepaymentMode | null },
  requestedMode: PrepaymentMode | null | undefined,
): Promise<{ repriceTemplate: boolean }> {
  if (account.accountType !== AccountType.MORTGAGE) {
    account.prepaymentMode = null;
    return { repriceTemplate: false };
  }
  const type = mortgageTypeOf(account);
  account.prepaymentMode = prepaymentModeColumn(
    type,
    requestedMode,
    account.prepaymentMode,
  );
  const methodChanged =
    previous.type !== null &&
    amortizationMethodFor(previous.type) !== amortizationMethodFor(type);
  const modeChanged =
    previous.type === "LINEAR" &&
    type === "LINEAR" &&
    prepaymentModeOf({ prepaymentMode: previous.mode }) !==
      prepaymentModeOf(account);
  const repriceTemplate = methodChanged || modeChanged;

  if (!storesConstantPayment(type)) {
    assertMortgageMethodTerms(type, account);
    account.paymentAmount = null;
    return { repriceTemplate };
  }
  if (!methodChanged) return { repriceTemplate };

  const asOfDate = (await nextLoanDueDate(m, account)) ?? todayYMD();
  const rates = await m.getRepository(LoanRateChange).find({
    where: { accountId: account.id },
    order: { effectiveDate: "ASC" },
  });
  const annualRate = effectiveAnnualRateOn(
    rates,
    asOfDate,
    account.interestRate == null ? null : Number(account.interestRate),
  );
  if (annualRate === null || !Number.isFinite(annualRate)) {
    throw new BadRequestException(
      tr(
        "errors.accounts.mortgageMethodRequiresTerms",
        `A ${type} mortgage requires interestRate`,
        { type, fields: "interestRate" },
      ),
    );
  }
  account.paymentAmount = roundMoney(
    (await datedAnnuityInstallment(m, account, annualRate, asOfDate)) +
      (Number(account.extraPaymentAmount) || 0),
  );
  return { repriceTemplate };
}
