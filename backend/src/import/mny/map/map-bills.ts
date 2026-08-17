import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import {
  MappedAccounts,
  MappedBill,
  MappedBillInvestment,
  MappedBillSplit,
  MappedBills,
  MappedSecurities,
} from "../model/mny-import-model";
import {
  MnyFrequencyMapping,
  mapFrequency,
  mapInvestmentAction,
} from "../model/mny-model";
import {
  FrequencyType,
  calculateNextDueDate,
} from "../../../common/recurrence";
import { CADENCE_DAYS, inferFrequencyFromDueDates } from "./bill-cadence";
import { MnyBill, MnyPayee, MnyTransaction } from "../model/mny-rows";
import { MnyWarning } from "../model/mny-warnings";
import { isDegeneratePayeeName } from "./map-reference";
import { MnyBillData } from "../tables/read-bills";
import { MnyInvestmentData } from "../tables/read-investments";
import { MnyTransactionData } from "../tables/read-transactions";

/**
 * `BILL` rows mapped onto Monize scheduled transactions.
 *
 * The table is an accumulation, not a list of bills: Money keeps an instance row
 * per occurrence, and decades of them add up -- PR #192 imported all 1,844 rows
 * of the maintainer's file where ~20 bills were real, then bulk-deactivated the
 * rest (design section 3, issue 2). Here rows are grouped into series
 * (`hbillHead`), each series is reduced to one representative instance, and only
 * series whose next due date falls inside a sanity horizon become candidates.
 * The wizard shows the candidates as a checkbox list, which is the safety net
 * for the detection erring in either direction.
 *
 * `BILL.st` has never been observed with a non-default value in any fixture
 * (open question 12.3), so nothing filters on it. The raw value is carried on
 * every candidate instead, so a real file's harness run can pin its semantics.
 */

/**
 * Grace on top of a series' own cadence before it counts as dead. A bill the
 * user is a few weeks behind on is still a bill.
 *
 * This is added to one full cycle rather than used on its own: a yearly bill
 * observed 100 days after its last occurrence has not missed anything, and the
 * flat 92-day rule this replaces declared it dead -- on a *current* file, not
 * just a stale one.
 */
export const BILL_PAST_HORIZON_DAYS = 92;

/** One cycle of each frequency, in whole days, rounded up. */
function cycleDays(frequency: keyof typeof CADENCE_DAYS): number {
  return Math.ceil(CADENCE_DAYS[frequency]);
}

/**
 * The date a series' activity is judged against.
 *
 * A `.mny` is a **snapshot**, not a live database: the user stops using Money,
 * exports, and imports whenever they get to it. Measuring "is this series still
 * live" against the wall clock therefore makes the same file import differently
 * depending on the day it is run, and once the file is a quarter old every bill
 * in it is silently dropped -- which is what reduced a file holding ~30 live
 * bills to a single one.
 *
 * So the horizon is anchored to the file's own present: the newest `BILL`
 * instance it contains. A file still in use has that at or ahead of today, and
 * `asOf` wins, which is the behaviour a current file always had.
 */
export function billActivityAnchor(
  bills: readonly MnyBill[],
  asOf: string,
): string {
  const newest = bills
    .map((bill) => bill.nextDue)
    .filter((due): due is string => due !== null)
    .reduce<string | null>(
      (latest, due) => (latest === null || due > latest ? due : latest),
      null,
    );
  return newest !== null && newest < asOf ? newest : asOf;
}

/**
 * How far into the future a next due date may plausibly sit. A yearly bill's
 * next instance is at most ~366 days out; anything further is Money's own
 * far-future filler, not a schedule.
 */
export const BILL_FUTURE_HORIZON_DAYS = 400;

export interface MapBillsInput {
  readonly bills: MnyBillData;
  readonly transactions: MnyTransactionData;
  readonly investments: MnyInvestmentData;
  readonly accounts: MappedAccounts;
  readonly securities: MappedSecurities;
  readonly payees: readonly MnyPayee[];
  /** Balance cut-off date, `YYYY-MM-DD` -- the horizon is measured from it. */
  readonly asOf: string;
}

/** `date` shifted by `days`, in the repository's `YYYY-MM-DD` convention. */
export function shiftIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface Context {
  readonly input: MapBillsInput;
  readonly transactionByHandle: ReadonlyMap<number, MnyTransaction>;
  readonly childrenByParent: ReadonlyMap<number, MnyTransaction[]>;
  readonly partnerByHandle: ReadonlyMap<number, number>;
  readonly detailByHandle: ReadonlyMap<
    number,
    { price: number; quantity: number; commission: number }
  >;
  readonly payeeNameByHandle: ReadonlyMap<number, string>;
  readonly warnings: MnyWarning[];
}

function buildContext(input: MapBillsInput): Context {
  const transactionByHandle = new Map(
    input.transactions.transactions
      .filter((row) => row.handle !== null)
      .map((row) => [row.handle as number, row]),
  );

  const childrenByParent = new Map<number, MnyTransaction[]>();
  for (const split of [...input.transactions.splits].sort(
    (a, b) => a.position - b.position,
  )) {
    if (split.parent === null || split.child === null) {
      continue;
    }
    const child = transactionByHandle.get(split.child);
    if (!child) {
      continue;
    }
    childrenByParent.set(split.parent, [
      ...(childrenByParent.get(split.parent) ?? []),
      child,
    ]);
  }

  // Unlike the posting mapper, template transfer pairs need no existence
  // checks beyond the row lookup: a dangling partner simply resolves to
  // nothing and the leg stays a category leg.
  const partnerByHandle = new Map<number, number>();
  for (const transfer of input.transactions.transfers) {
    if (transfer.from === null || transfer.to === null) {
      continue;
    }
    if (
      !partnerByHandle.has(transfer.from) &&
      !partnerByHandle.has(transfer.to)
    ) {
      partnerByHandle.set(transfer.from, transfer.to);
      partnerByHandle.set(transfer.to, transfer.from);
    }
  }

  const detailByHandle = new Map(
    input.investments.investmentDetails
      .filter((detail) => detail.transaction !== null)
      .map((detail) => [
        detail.transaction as number,
        {
          price: detail.price,
          quantity: detail.quantity,
          commission: detail.commission,
        },
      ]),
  );

  const payeeNameByHandle = new Map(
    input.payees
      .filter(
        (payee) => payee.handle !== null && !isDegeneratePayeeName(payee.name),
      )
      .map((payee) => [payee.handle as number, payee.name.trim()]),
  );

  return {
    input,
    transactionByHandle,
    childrenByParent,
    partnerByHandle,
    detailByHandle,
    payeeNameByHandle,
    warnings: [],
  };
}

/** Groups instance rows into series; a row with no `hbillHead` is its own. */
function groupBySeries(bills: readonly MnyBill[]): Map<number, MnyBill[]> {
  const bySeries = new Map<number, MnyBill[]>();
  for (const bill of bills) {
    if (bill.handle === null) {
      continue;
    }
    const key = bill.series ?? bill.handle;
    bySeries.set(key, [...(bySeries.get(key) ?? []), bill]);
  }
  return bySeries;
}

/**
 * The instance that carries the series' schedule: the earliest one still due on
 * or after the cut-off, else the most recently due. A series whose instances
 * all lack a date has no schedule to import.
 */
function representativeOf(
  instances: readonly MnyBill[],
  asOf: string,
): MnyBill | null {
  const dated = instances
    .filter((bill) => bill.nextDue !== null)
    .sort((a, b) =>
      (a.nextDue as string) < (b.nextDue as string)
        ? -1
        : a.nextDue === b.nextDue
          ? 0
          : 1,
    );
  if (dated.length === 0) {
    return null;
  }
  return (
    dated.find((bill) => (bill.nextDue as string) >= asOf) ??
    dated[dated.length - 1]
  );
}

/**
 * Whether a series' schedule falls inside the active horizon, measured from the
 * file's own present (`anchor`) rather than the wall clock.
 *
 * A series stays a candidate for one full cycle plus `BILL_PAST_HORIZON_DAYS`
 * of grace, floored at `BILL_FUTURE_HORIZON_DAYS` so nothing is judged over a
 * window shorter than a year -- a monthly bill that lapsed for two months is
 * still the bill the user thinks they have, and the wizard's checkbox list is
 * where it gets unticked. Detection erring generous is recoverable; erring
 * strict drops the series with no UI that ever mentions it.
 */
function isActive(
  representative: MnyBill,
  anchor: string,
  mapping: MnyFrequencyMapping | null,
): boolean {
  const nextDue = representative.nextDue as string;
  if (nextDue > shiftIsoDate(anchor, BILL_FUTURE_HORIZON_DAYS)) {
    return false;
  }
  if (representative.endsOn !== null && representative.endsOn < anchor) {
    return false;
  }

  // A one-off that has already fallen due is spent, not a schedule.
  if (mapping === null || mapping.frequency === "ONCE") {
    return nextDue >= anchor;
  }

  const window = Math.max(
    BILL_FUTURE_HORIZON_DAYS,
    cycleDays(mapping.frequency) + BILL_PAST_HORIZON_DAYS,
  );
  return nextDue >= shiftIsoDate(anchor, -window);
}

/**
 * The series' next occurrence at or after `asOf`, rolled forward through its own
 * cadence.
 *
 * Money's newest instance is where the series stood when the file was last
 * used, which for any real import is in the past. Writing that date through
 * unchanged hands Monize a schedule that is months overdue on arrival, so the
 * bill lands looking like a backlog rather than a schedule. Rolling is bounded:
 * a daily series twenty years stale would otherwise iterate for ever.
 */
export function rollForward(
  due: string,
  frequency: FrequencyType,
  asOf: string,
): string {
  if (frequency === "ONCE") {
    return due;
  }
  let next = due;
  for (let step = 0; step < MAX_ROLL_STEPS && next < asOf; step += 1) {
    const advanced = calculateNextDueDate(next, frequency);
    if (advanced <= next) {
      return next;
    }
    next = advanced;
  }
  return next;
}

/** Enough to roll a daily series through a decade, and no further. */
const MAX_ROLL_STEPS = 4000;

/** The account key a template row's schedule belongs to, or null. */
function accountKeyOf(
  template: MnyTransaction,
  context: Context,
): string | null {
  return template.account === null
    ? null
    : (context.input.accounts.keyByHandle.get(template.account) ?? null);
}

function mapSplitLegs(
  template: MnyTransaction,
  context: Context,
): MappedBillSplit[] {
  const children =
    template.handle === null
      ? []
      : (context.childrenByParent.get(template.handle) ?? []);

  return children.map((child) => {
    const partner =
      child.handle === null
        ? null
        : (context.partnerByHandle.get(child.handle) ?? null);
    const partnerRow =
      partner === null
        ? null
        : (context.transactionByHandle.get(partner) ?? null);
    const partnerKey =
      partnerRow === null ? null : accountKeyOf(partnerRow, context);

    if (partnerKey !== null) {
      return {
        kind: SplitKind.TRANSFER,
        categoryHandle: null,
        transferAccountKey: partnerKey,
        amount: child.amount,
        memo: child.memo,
      };
    }

    return {
      kind: SplitKind.CATEGORY,
      categoryHandle: child.category,
      transferAccountKey: null,
      amount: child.amount,
      memo: child.memo,
    };
  });
}

function mapInvestmentTemplate(
  template: MnyTransaction,
  context: Context,
): MappedBillInvestment | null {
  const securityHandle = template.security as number;
  if (!context.input.securities.byHandle.has(securityHandle)) {
    return null;
  }
  const action = mapInvestmentAction(template.action);
  if (action === null) {
    return null;
  }
  const detail =
    template.handle === null
      ? undefined
      : context.detailByHandle.get(template.handle);

  return {
    action,
    securityHandle,
    quantity: detail && detail.quantity !== 0 ? detail.quantity : null,
    price: detail && detail.price !== 0 ? detail.price : null,
    commission: detail?.commission ?? 0,
  };
}

function billName(
  template: MnyTransaction,
  handle: number,
  context: Context,
): string {
  const payeeName =
    template.payee === null
      ? undefined
      : context.payeeNameByHandle.get(template.payee);
  if (payeeName) {
    return payeeName;
  }
  const memo = template.memo?.split("\n")[0].trim();
  return memo || `Bill ${handle}`;
}

/**
 * The cadence a series recurs at: what its own instances do, falling back to
 * what `BILL.frq` says they should do.
 *
 * The dates win a disagreement, and they still do now that `MNY_FREQUENCY` is
 * read off a real file rather than guessed. A series' spacing is the file
 * stating its own cadence, and it is the only thing that can catch a code
 * table wrong again -- it is what issue #1150 (yearly bills imported as every
 * two months) needed and did not have. Where the two agree the code's mapping
 * is kept as-is, so an approximated cadence still reports itself as
 * approximate.
 *
 * The dates cannot answer for a series Money has scheduled but never posted:
 * one instance is no gaps, so a brand-new bill rests entirely on the code pair.
 * That is the case the `(frq, cFrqInst)` decode has to get right on its own.
 */
export function resolveSeriesFrequency(
  representative: MnyBill,
  instances: readonly MnyBill[],
): MnyFrequencyMapping | null {
  const coded = mapFrequency(
    representative.frequency,
    representative.occurrencesPerUnit,
  );
  const observed = inferFrequencyFromDueDates(
    instances.map((instance) => instance.nextDue),
  );

  if (observed === null || coded?.frequency === observed) {
    return coded;
  }
  return { frequency: observed, approximate: false };
}

/** A series the user's account selection left out, as opposed to a bad row. */
const EXCLUDED = "excluded";

function mapOne(
  representative: MnyBill,
  mapping: MnyFrequencyMapping | null,
  context: Context,
): MappedBill | typeof EXCLUDED | null {
  const handle = representative.handle as number;
  const templateHandle = representative.templateTransaction;
  const template =
    templateHandle === null
      ? undefined
      : context.transactionByHandle.get(templateHandle);
  if (!template) {
    context.warnings.push({
      code: "billTemplateMissing",
      subject: `hbill=${handle}`,
    });
    return null;
  }

  const accountKey = accountKeyOf(template, context);
  if (accountKey === null) {
    if (template.account === null) {
      context.warnings.push({
        code: "unusableBill",
        subject: `hbill=${handle}`,
        detail: "no account",
      });
      return null;
    }
    // The account exists but is not being imported -- a choice, not a defect.
    return EXCLUDED;
  }

  if (mapping === null) {
    // The raw pair rides along. Money's picker offers five units and all five
    // are mapped, so an unknown `frq` is a version or a dialog this repository
    // has not seen -- and the pair is what a real file has to report for it to
    // be pinned down without guessing.
    context.warnings.push({
      code: "unusableBill",
      subject: `hbill=${handle}`,
      detail: `frq=${representative.frequency} cFrqInst=${representative.occurrencesPerUnit}`,
    });
    return null;
  }

  const name = billName(template, handle, context);
  if (mapping.approximate) {
    context.warnings.push({
      code: "billFrequencyApproximated",
      subject: name,
      detail: `frq=${representative.frequency} cFrqInst=${representative.occurrencesPerUnit}`,
    });
  }

  const splits = mapSplitLegs(template, context);
  const investment =
    template.security !== null
      ? mapInvestmentTemplate(template, context)
      : null;
  if (template.security !== null && investment === null) {
    context.warnings.push({
      code: "unusableBill",
      subject: name,
      detail: `act=${template.action}`,
    });
    return null;
  }

  // A top-level transfer template: the counterpart row names the account the
  // money goes to. Split templates carry their transfer legs as splits instead.
  const partner =
    splits.length > 0 || template.handle === null
      ? null
      : (context.partnerByHandle.get(template.handle) ?? null);
  const partnerRow =
    partner === null
      ? null
      : (context.transactionByHandle.get(partner) ?? null);
  const transferAccountKey =
    partnerRow === null || investment !== null
      ? null
      : accountKeyOf(partnerRow, context);

  return {
    handle,
    seriesKey: representative.series ?? handle,
    status: representative.status,
    name,
    accountKey,
    payeeHandle: template.payee,
    categoryHandle:
      splits.length > 0 || transferAccountKey !== null || investment !== null
        ? null
        : template.category,
    amount: template.amount,
    currencyCode:
      template.account === null
        ? ""
        : (context.input.accounts.currencyByHandle.get(template.account) ?? ""),
    frequency: mapping.frequency,
    approximate: mapping.approximate,
    // Rolled to the next occurrence at or after the import's cut-off: Money's
    // own newest instance is where the series stood when the file was last
    // used, which is in the past for any real import.
    nextDueDate: rollForward(
      representative.nextDue as string,
      mapping.frequency,
      context.input.asOf,
    ),
    endDate: representative.endsOn,
    description: template.memo,
    isTransfer: transferAccountKey !== null,
    transferAccountKey,
    investment,
    splits,
  };
}

/**
 * Drops the receiving side of a transfer bill that appears as two candidates.
 *
 * Money records a transfer bill once, but a file can carry a `BILL` row for
 * each side of the template pair. Importing both would post the transfer
 * twice; the paying side (the more negative amount) is the bill.
 */
function dedupeTransferPairs(
  bills: readonly MappedBill[],
  templateByBillHandle: ReadonlyMap<number, number>,
  context: Context,
): MappedBill[] {
  const billByTemplate = new Map(
    bills
      .map((bill): [number | undefined, MappedBill] => [
        templateByBillHandle.get(bill.handle),
        bill,
      ])
      .filter((entry): entry is [number, MappedBill] => entry[0] !== undefined),
  );

  const dropped = new Set<number>();
  for (const bill of bills) {
    if (dropped.has(bill.handle) || !bill.isTransfer) {
      continue;
    }
    const template = templateByBillHandle.get(bill.handle);
    const partner =
      template === undefined
        ? undefined
        : context.partnerByHandle.get(template);
    const other =
      partner === undefined ? undefined : billByTemplate.get(partner);
    if (!other || other.handle === bill.handle) {
      continue;
    }
    // Keep the paying side; on a tie the lower handle is stable.
    const keep =
      bill.amount < other.amount ||
      (bill.amount === other.amount && bill.handle < other.handle)
        ? bill
        : other;
    dropped.add(keep.handle === bill.handle ? other.handle : bill.handle);
  }

  return bills.filter((bill) => !dropped.has(bill.handle));
}

/**
 * Maps `BILL` onto scheduled-transaction candidates, one per detected-active
 * series. Inactive series are counted, never warned -- 1,824 dead rows worth of
 * warnings is exactly the noise issue 2 complained about.
 */
export function mapBills(input: MapBillsInput): MappedBills {
  const context = buildContext(input);

  if (!input.bills.supported) {
    return {
      bills: [],
      seriesInFile: 0,
      skipped: 0,
      supported: false,
      warnings: [],
    };
  }

  const bySeries = groupBySeries(input.bills.bills);
  let skipped = 0;
  const mapped: MappedBill[] = [];
  const templateByBillHandle = new Map<number, number>();

  const anchor = billActivityAnchor(input.bills.bills, input.asOf);

  for (const instances of bySeries.values()) {
    const representative = representativeOf(instances, anchor);
    if (representative === null) {
      continue;
    }
    const mapping = resolveSeriesFrequency(representative, instances);
    if (!isActive(representative, anchor, mapping)) {
      continue;
    }
    const bill = mapOne(representative, mapping, context);
    if (bill === null) {
      skipped += 1;
      continue;
    }
    if (bill === EXCLUDED) {
      continue;
    }
    mapped.push(bill);
    if (representative.templateTransaction !== null) {
      templateByBillHandle.set(bill.handle, representative.templateTransaction);
    }
  }

  const bills = dedupeTransferPairs(mapped, templateByBillHandle, context).sort(
    (a, b) =>
      a.nextDueDate < b.nextDueDate
        ? -1
        : a.nextDueDate > b.nextDueDate
          ? 1
          : a.handle - b.handle,
  );

  return {
    bills,
    seriesInFile: bySeries.size,
    skipped,
    supported: true,
    warnings: context.warnings,
  };
}

/**
 * Payee and category handles a set of bills references. Computed over the
 * *selected* bills, not all candidates: a payee only an unticked bill uses is
 * not referenced (design section 3, issue 3 -- referenced-only import counts
 * "a transaction, split, or selected bill").
 */
export function billReferences(bills: readonly MappedBill[]): {
  payees: ReadonlySet<number>;
  categories: ReadonlySet<number>;
} {
  return {
    payees: new Set(
      bills
        .map((bill) => bill.payeeHandle)
        .filter((handle): handle is number => handle !== null),
    ),
    categories: new Set(
      bills
        .flatMap((bill) => [
          bill.categoryHandle,
          ...bill.splits.map((split) => split.categoryHandle),
        ])
        .filter((handle): handle is number => handle !== null),
    ),
  };
}

/** The candidates the wizard's selection kept. */
export function selectedBills(
  bills: MappedBills,
  selection: readonly number[],
): MappedBill[] {
  const wanted = new Set(selection);
  return bills.bills.filter((bill) => wanted.has(bill.handle));
}
