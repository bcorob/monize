import { Between, EntityManager, In } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransactionPosting } from "../scheduled-transactions/entities/scheduled-transaction-posting.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { addDaysYMD } from "../common/date-utils";
import { datedLoanDebts } from "../accounts/dated-loan-debt.util";
import {
  DateRange,
  occurrenceSlotsInRange,
  OccurrenceSlot,
  periodSpan,
} from "./occurrence-slots";

/**
 * Everything the pure settlement planner (`plan-loan-settlement.ts`) prices a
 * pass of bank rows against one loan from, read in one place
 * (`docs/specs/loan-installment-settlement.md` section 7.1) and, when the
 * caller is about to write, after the locks of section 13: the schedule row,
 * then `lockAccountsForBalanceWrite(source, loan)`, the order `post()` takes
 * them, so the debt is read under the lock that authorizes the write
 * (CONC-001).
 *
 * The loader answers for the loan the action names, not for "any schedule
 * that transfers into it": the loan's payment is `accounts.scheduled_transaction_id`
 * (`docs/specs/scheduled-loan-installment-pricing.md` section 2). Facts that
 * are missing are reported as missing (`schedule: null`, an empty calendar)
 * for the planner to refuse by name; only an account that cannot be read at
 * all, or a ledger that cannot, is `LoanFactsUnavailable`.
 */

/** A claim on the schedule, as the planner reads it. */
export type LoanOccurrenceClaim = Pick<
  ScheduledTransactionPosting,
  "id" | "originalDueDate" | "source" | "transactionId"
>;

export interface LoanSettlementFacts {
  readonly kind: "facts";
  readonly loanAccount: Account;
  /** The loan's active scheduled payment; null when the pointer is unset, the row is gone or it is inactive. */
  readonly schedule: ScheduledTransaction | null;
  /** The schedule's template lines; empty without a schedule. */
  readonly splits: readonly ScheduledTransactionSplit[];
  /** The loan's rate history, ascending by effective date. */
  readonly rateChanges: readonly LoanRateChange[];
  /** The calendar slots dated inside the pass's window, with their periods. */
  readonly slots: readonly OccurrenceSlot[];
  /** The schedule's claims whose `original_due_date` lies in the slots' periods. */
  readonly claims: readonly LoanOccurrenceClaim[];
  /**
   * The ids among `input.rowIds` that a claim of any schedule names, whoever
   * wrote it: a row `post()` wrote, or a row a rule settled that no longer
   * reads as a split (edited down to one line, spec section 15 item 9). Each
   * already pays an occurrence, so the planner refuses it.
   */
  readonly postedRowIds: ReadonlySet<string>;
  /** `datedLoanDebt` at each slot date. */
  readonly debtByDueDate: ReadonlyMap<string, number>;
}

/** The loan's account row or its ledger could not be read: not a zero, not "not a loan". */
export interface LoanFactsUnavailable {
  readonly kind: "unavailable";
  readonly reason: string;
}

export interface LoanSettlementFactsInput {
  readonly loanAccountId: string;
  /** The account the pass's rows are in: locked with the loan before the reads. */
  readonly sourceAccountId: string;
  /**
   * The union of the pass's windows (`settlementWindow` of each row): the
   * slots dated inside it are enumerated and priced.
   */
  readonly window: DateRange;
  /**
   * The ids of the pass's rows. A claim naming one of them, on any schedule
   * and of either source, marks that row as one that already pays an
   * occurrence (spec section 11, row 9).
   */
  readonly rowIds?: readonly string[];
}

export interface LoanSettlementFactsOptions {
  /**
   * Take the schedule row (`FOR UPDATE`) and the two accounts' balance-write
   * locks before reading. True on a path that will write the settlement;
   * false for a preview.
   */
  readonly lock: boolean;
}

/**
 * Load the facts for settling rows of `sourceAccountId` against
 * `loanAccountId`, for the owner `userId`. Under RLS a loan that is not the
 * caller's reads as absent, and so does one read with the wrong owner here:
 * both are `LoanFactsUnavailable`.
 */
export async function loadLoanSettlementFacts(
  m: EntityManager,
  userId: string,
  input: LoanSettlementFactsInput,
  options: LoanSettlementFactsOptions,
): Promise<LoanSettlementFacts | LoanFactsUnavailable> {
  const accounts = m.getRepository(Account);
  const schedules = m.getRepository(ScheduledTransaction);

  // The pointer to the schedule is read first, unlocked, because the lock
  // order starts with the schedule row and the row is only known from it.
  const pointer = await accounts.findOne({
    where: { id: input.loanAccountId, userId },
  });
  if (!pointer) return unavailable(input.loanAccountId);

  let schedule: ScheduledTransaction | null = null;
  if (pointer.scheduledTransactionId) {
    schedule = await schedules.findOne({
      where: { id: pointer.scheduledTransactionId, userId },
      ...(options.lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
    });
  }
  if (options.lock) {
    await lockAccountsForBalanceWrite(
      m,
      [input.sourceAccountId, input.loanAccountId],
      userId,
    );
  }

  // Every financial input is read after the locks, the account row again
  // included: a rate or a term written between the pointer read and the lock
  // belongs to this settlement.
  const loanAccount = options.lock
    ? await accounts.findOne({ where: { id: input.loanAccountId, userId } })
    : pointer;
  if (!loanAccount) return unavailable(input.loanAccountId);

  const rateChanges = await m.getRepository(LoanRateChange).find({
    where: { accountId: loanAccount.id },
    order: { effectiveDate: "ASC" },
  });
  const postedRowIds = await postedRows(m, input.rowIds ?? []);

  if (!schedule || !schedule.isActive) {
    return {
      kind: "facts",
      loanAccount,
      schedule: null,
      splits: [],
      rateChanges,
      slots: [],
      claims: [],
      postedRowIds,
      debtByDueDate: new Map(),
    };
  }

  const splits = await m.getRepository(ScheduledTransactionSplit).find({
    where: { scheduledTransactionId: schedule.id },
  });

  const slots = occurrenceSlotsInRange(schedule, input.window);
  const span = periodSpan(slots);
  const claims: LoanOccurrenceClaim[] = span
    ? await m.getRepository(ScheduledTransactionPosting).find({
        select: {
          id: true,
          originalDueDate: true,
          source: true,
          transactionId: true,
        },
        where: {
          scheduledTransactionId: schedule.id,
          // The span's end is exclusive; `Between` is inclusive at both ends.
          originalDueDate: Between(span.from, addDaysYMD(span.to, -1)),
        },
        order: { originalDueDate: "ASC" },
      })
    : [];

  const debtByDueDate = await datedLoanDebts(
    m,
    loanAccount,
    slots.map((slot) => slot.date),
  );
  if (debtByDueDate === null) {
    return {
      kind: "unavailable",
      reason: `the ledger balance for loan account ${loanAccount.id} could not be read`,
    };
  }

  return {
    kind: "facts",
    loanAccount,
    schedule,
    splits,
    rateChanges,
    slots,
    claims,
    postedRowIds,
    debtByDueDate,
  };
}

/**
 * The ids among `rowIds` that a claim names, on any of the owner's schedules
 * and of either source. A `rule` claim's row is refused before it can be
 * planned again, so the partial unique index on `transaction_id` is never the
 * one the claim's `INSERT` conflicts on.
 */
async function postedRows(
  m: EntityManager,
  rowIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(rowIds)];
  if (ids.length === 0) return new Set();
  const rows = await m.getRepository(ScheduledTransactionPosting).find({
    select: { id: true, transactionId: true },
    where: { transactionId: In(ids) },
  });
  return new Set(
    rows
      .map((row) => row.transactionId)
      .filter((id): id is string => id !== null),
  );
}

function unavailable(loanAccountId: string): LoanFactsUnavailable {
  return {
    kind: "unavailable",
    reason: `loan account ${loanAccountId} could not be read`,
  };
}
