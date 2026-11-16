import { DataSource, In } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { withScopedDb } from "../common/db/scoped-db";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { roundMoney } from "../common/round.util";
import { effectiveAnnualRateOn } from "./effective-loan-rate.util";
import { getPeriodicRate } from "./mortgage-amortization.util";
import {
  amortizationMethodFor,
  mortgageTypeOf,
  storesConstantPayment,
} from "./mortgage-type.util";
import {
  scheduledPaymentCount,
  scheduledPaymentDate,
} from "./mortgage-installment.util";
import { periodsPerYearForStoredFrequency } from "./payment-frequency.util";

/** A dated amount: what is due, and when. */
export interface DatedInstallment {
  dueDate: string;
  /** Positive; null when the occurrence's amount is unknown. */
  amount: number | null;
}

/**
 * What a reader needs in place of `payment_amount` for a mortgage whose
 * method has no constant payment (spec section 5.6, the `LlmAccountRow` row).
 */
export interface DerivedInstallmentFacts {
  /** The next occurrence of the mortgage's scheduled payment, as it would post. */
  nextInstallment: DatedInstallment | null;
  /**
   * INTEREST_ONLY: the final payment, the whole debt plus that period's
   * interest at the rate in force on its date (INV-LOAN-004), on payment `N`.
   * Priced on today's debt, so a later repayment lowers it.
   */
  bullet: { dueDate: string; amount: number } | null;
}

/**
 * Far enough ahead that the next occurrence of any loan cadence (yearly at
 * the longest) falls inside the window.
 */
const NEXT_OCCURRENCE_HORIZON_DAYS = 400;

/**
 * The next installment, and for INTEREST_ONLY the bullet, of every LINEAR or
 * INTEREST_ONLY mortgage in `accounts`, keyed by account id. Every other
 * account is absent from the map.
 *
 * The next installment is the scheduled payment's next occurrence from
 * `ScheduledOccurrenceService` (INV-OCCURRENCE-003), never the template's
 * `amount`; the template itself is kept at the method's installment by
 * `resolveInstallment`. `debts` is each account's outstanding debt (positive)
 * the reader already shows.
 */
export async function derivedInstallmentFacts(
  dataSource: DataSource,
  occurrences: ScheduledOccurrenceService,
  userId: string,
  accounts: Account[],
  debts: Map<string, number>,
): Promise<Map<string, DerivedInstallmentFacts>> {
  const derived = accounts.filter(
    (a) =>
      a.accountType === AccountType.MORTGAGE &&
      !storesConstantPayment(mortgageTypeOf(a)),
  );
  const facts = new Map<string, DerivedInstallmentFacts>();
  if (derived.length === 0) return facts;

  const scheduleIds = derived
    .map((a) => a.scheduledTransactionId)
    .filter((id): id is string => !!id);
  const accountIds = derived.map((a) => a.id);
  const { schedules, rates } = await withScopedDb(dataSource, async (m) => ({
    schedules:
      scheduleIds.length === 0
        ? []
        : await m.getRepository(ScheduledTransaction).find({
            where: { id: In(scheduleIds), userId, isActive: true },
            relations: ["splits"],
          }),
    rates: await m.getRepository(LoanRateChange).find({
      where: { accountId: In(accountIds) },
      order: { effectiveDate: "ASC" },
    }),
  }));

  const today = todayYMD();
  const next = await occurrences.expand(userId, schedules, {
    through: addDaysYMD(today, NEXT_OCCURRENCE_HORIZON_DAYS),
    maxOccurrences: 1,
  });
  const nextBySchedule = new Map(
    next.map((o) => [o.scheduledTransactionId, o]),
  );

  for (const account of derived) {
    const occurrence = account.scheduledTransactionId
      ? nextBySchedule.get(account.scheduledTransactionId)
      : undefined;
    const nextInstallment: DatedInstallment | null = occurrence
      ? {
          dueDate: occurrence.dueDate,
          amount:
            occurrence.amount === null
              ? null
              : roundMoney(Math.abs(occurrence.amount)),
        }
      : null;

    let bullet: DerivedInstallmentFacts["bullet"] = null;
    const type = mortgageTypeOf(account);
    const count = scheduledPaymentCount(account);
    const dueDate =
      count === null ? null : scheduledPaymentDate(account, count);
    const periodsPerYear = periodsPerYearForStoredFrequency(
      account.paymentFrequency,
    );
    if (
      amortizationMethodFor(type) === "INTEREST_ONLY" &&
      dueDate !== null &&
      periodsPerYear !== null
    ) {
      const debt = Math.max(0, debts.get(account.id) ?? 0);
      // No rate in the timeline or on the account is unknown, never 0%: the
      // bullet is withheld rather than shown as the bare debt.
      const annualRate = effectiveAnnualRateOn(
        rates.filter((r) => r.accountId === account.id),
        dueDate,
        account.interestRate == null ? null : Number(account.interestRate),
      );
      if (annualRate !== null && Number.isFinite(annualRate)) {
        bullet = {
          dueDate,
          amount: roundMoney(
            debt +
              roundMoney(
                debt * getPeriodicRate(annualRate, periodsPerYear, type),
              ),
          ),
        };
      }
    }
    facts.set(account.id, { nextInstallment, bullet });
  }
  return facts;
}
