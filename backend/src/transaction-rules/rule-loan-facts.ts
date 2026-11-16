import { EntityManager } from "typeorm";
import { addDaysYMD } from "../common/date-utils";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import { loadLoanSettlementFacts } from "../loan-installments/loan-settlement-facts";
import { DateRange } from "../loan-installments/occurrence-slots";
import {
  LoanFactsLookup,
  RuleLoanFacts,
  loanFactsCover,
} from "./rule-loan-settlement";
import { MAX_LOAN_SETTLEMENT_WINDOW_DAYS } from "./transaction-rules.limits";

/**
 * The loan facts a call reads while planning, the I/O half of
 * `rule-loan-settlement.ts`: the plan reports a `LoanFactsLookup`, this reads
 * the loan's facts through the loan core (`loadLoanSettlementFacts`) and the
 * plan runs again. One source serves the rows of one call, keyed by loan
 * account id, so a batch reads each loan once.
 *
 * The first read for a loan covers the whole pass: every row's date widened by
 * `MAX_LOAN_SETTLEMENT_WINDOW_DAYS` on both sides, which holds the window of
 * any action, and every row id. A row outside it (a preview's own date) widens
 * the read and reads again. Reading more slots than a row's window cannot
 * change its plan: the planner selects among the slots inside the window only.
 *
 * `lock` says which side of the write this source serves: a preview reads
 * unlocked; a path that will write the settlement (`applyToNew`, the manual
 * run's commit) has the loader take the schedule row and the two accounts'
 * balance-write locks before every read (spec section 13), so the claims and
 * the debt a plan is made from are the ones the write will act on.
 */
export interface LoanFactsSource {
  readonly m: EntityManager;
  readonly userId: string;
  /** Whether the loader locks before it reads: true on a path that will write. */
  readonly lock: boolean;
  /** The ids of the pass's stored rows. */
  readonly rowIds: readonly string[];
  /** The dates the pass's rows carry, widened by the largest window. */
  readonly passWindow: DateRange | null;
  /** The facts read so far, by loan account id. */
  readonly entries: Map<string, RuleLoanFacts>;
}

/** A source for one call over rows with these ids and dates. */
export function newLoanFactsSource(
  m: EntityManager,
  userId: string,
  pass: {
    readonly rowIds?: readonly string[];
    readonly dates?: readonly (string | null | undefined)[];
    readonly lock?: boolean;
  } = {},
): LoanFactsSource {
  const dates = (pass.dates ?? [])
    .filter((d): d is string => typeof d === "string" && isCalendarDate(d))
    .sort();
  return {
    m,
    userId,
    lock: pass.lock === true,
    rowIds: [...new Set(pass.rowIds ?? [])],
    passWindow:
      dates.length === 0
        ? null
        : {
            from: addDaysYMD(dates[0], -MAX_LOAN_SETTLEMENT_WINDOW_DAYS),
            to: addDaysYMD(
              dates[dates.length - 1],
              MAX_LOAN_SETTLEMENT_WINDOW_DAYS,
            ),
          },
    entries: new Map(),
  };
}

const union = (
  ranges: readonly (DateRange | null | undefined)[],
): DateRange => {
  const present = ranges.filter((r): r is DateRange => !!r);
  return {
    from: present.map((r) => r.from).sort()[0],
    to: present
      .map((r) => r.to)
      .sort()
      .reverse()[0],
  };
};

/**
 * Read the facts the lookups name that `source` does not already hold.
 * Returns whether anything was read, so the caller plans again only when the
 * plan can change.
 */
export async function answerLoanFactsLookups(
  source: LoanFactsSource,
  lookups: readonly LoanFactsLookup[],
): Promise<boolean> {
  let read = false;
  for (const lookup of lookups) {
    const held = source.entries.get(lookup.loanAccountId);
    if (loanFactsCover(held, lookup)) continue;
    const window = union([lookup.window, held?.window, source.passWindow]);
    const rowIds = new Set([
      ...source.rowIds,
      ...(held?.rowIds ?? []),
      ...(lookup.transactionId !== undefined ? [lookup.transactionId] : []),
    ]);
    const facts = await loadLoanSettlementFacts(
      source.m,
      source.userId,
      {
        loanAccountId: lookup.loanAccountId,
        sourceAccountId: lookup.sourceAccountId,
        window,
        rowIds: [...rowIds],
      },
      { lock: source.lock },
    );
    source.entries.set(lookup.loanAccountId, { window, rowIds, facts });
    read = true;
  }
  return read;
}
