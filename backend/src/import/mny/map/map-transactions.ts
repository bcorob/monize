import { randomUUID } from "node:crypto";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { roundMoney } from "../../../common/round.util";
import { MnyBill, MnyTransaction } from "../model/mny-rows";
import {
  MappedSplit,
  MappedTransaction,
  MappedTransactions,
} from "../model/mny-import-model";
import {
  billTemplateHandles,
  decodeReference,
  isLoanPaymentTemplate,
  isRecurrenceTemplate,
  isUnpostedRow,
  mapTransactionStatus,
} from "../model/mny-model";
import { MnyWarning, MnyWarningRow } from "../model/mny-warnings";
import { MnyTransactionData } from "../tables/read-transactions";
import { TransferIndex, indexTransfers } from "./map-transfers";

/**
 * `TRN`, `TRN_SPLIT` and `TRN_XFER` mapped onto Monize transactions.
 *
 * The two rules that carry the most history:
 *
 * **The phantom filter is `frq != -1` and nothing else.** PR #192 also excluded
 * rows it read as auto-entered, but Money's scheduler posts real transactions --
 * including every loan payment -- so that filter is what made loan and mortgage
 * accounts import with zero transactions. Its sibling mistake outlived it:
 * `grftt & 0x80` was read as "voided" when it actually marks a row in a debt
 * account, so the loan payments that survived the filter all imported VOID and
 * dropped straight back out of the balance (see `MNY_TRANSACTION_FLAG`).
 *
 * **A split leg that is really a transfer stays a transfer.** PR #192 imported
 * every `TRN_SPLIT` child as a category-only row, so the principal leg of a loan
 * payment lost its transfer nature and showed blank. Here a child that appears
 * in `TRN_XFER` becomes a Monize transfer split pointing at the counterpart
 * transaction, which is imported exactly once as an ordinary row in the loan
 * account and links back to the *parent* payment -- the same wiring
 * `TransactionSplitService` produces for a hand-entered transfer split.
 */

export interface MapTransactionsInput {
  readonly transactions: MnyTransactionData;
  /** Money `hacct` -> account key, from `mapAccounts`. Absent = not imported. */
  readonly accountKeyByHandle: ReadonlyMap<number, string>;
  /** Money `hacct` -> the Monize account's currency. */
  readonly currencyByHandle: ReadonlyMap<number, string>;
  /** `BILL` rows, so their template transactions are not imported as postings. */
  readonly bills: readonly MnyBill[];
  /**
   * Brokerage account key -> its linked cash sleeve, from `mapAccounts`. A
   * transfer whose far side is an investment row lands in the sleeve, because
   * that is where Monize keeps a brokerage's cash.
   */
  readonly cashKeyByAccountKey: ReadonlyMap<string, string>;
}

/**
 * The cash-sleeve side of a transfer between a bank account and an investment
 * account -- a transaction Money does not store, because its investment row is
 * both the transfer destination and the trade.
 */
interface CashCounterpart extends MappedTransaction {
  /** `TRN.htrn` of the investment row this is the cash side of. */
  readonly handle: number;
}

/** Everything the per-row mapping needs, computed once. */
interface Context {
  readonly input: MapTransactionsInput;
  readonly byHandle: ReadonlyMap<number, MnyTransaction>;
  /** `TRN_SPLIT.htrn` -- rows that are legs of another transaction. */
  readonly parentOfChild: ReadonlyMap<number, number>;
  readonly childrenByParent: ReadonlyMap<number, MnyTransaction[]>;
  readonly billTemplates: ReadonlySet<number>;
  readonly transfers: TransferIndex;
  /** Pre-generated ids for the rows that will be imported as transactions. */
  readonly idByHandle: ReadonlyMap<number, string>;
  /** Investment row handle -> the cash-sleeve transaction standing in for it. */
  readonly cashCounterparts: ReadonlyMap<number, CashCounterpart>;
  readonly warnings: MnyWarning[];
}

/**
 * The flagged-row context a warning carries, so the review step can show the
 * user which transactions to look at in Money rather than a bare `htrn`.
 */
function warningRow(
  row: MnyTransaction,
  input: MapTransactionsInput,
): MnyWarningRow {
  return {
    handle: row.handle as number,
    accountKey:
      row.account === null
        ? null
        : (input.accountKeyByHandle.get(row.account) ?? null),
    date: row.date,
    amount: row.amount,
    payeeHandle: row.payee,
    reference: decodeReference(row.reference),
    memo: row.memo,
  };
}

interface Indexes {
  readonly byHandle: ReadonlyMap<number, MnyTransaction>;
  readonly parentOfChild: ReadonlyMap<number, number>;
  readonly childrenByParent: ReadonlyMap<number, MnyTransaction[]>;
  readonly billTemplates: ReadonlySet<number>;
  readonly transfers: TransferIndex;
  /**
   * Rows that are Money's own copy of a trade's cash leg, which Monize writes
   * from the investment transaction instead. See `tradeCashLegRows`.
   */
  readonly tradeCashLegs: ReadonlySet<number>;
  readonly warnings: MnyWarning[];
}

/** Everything the posting predicate reads before `tradeCashLegs` can exist. */
type PostingIndexes = Omit<Indexes, "tradeCashLegs">;

function buildIndexes(input: MapTransactionsInput): Indexes {
  const warnings: MnyWarning[] = [];
  const rows = input.transactions.transactions;

  const byHandle = new Map(
    rows
      .filter((row) => row.handle !== null)
      .map((row) => [row.handle as number, row]),
  );

  const parentOfChild = new Map<number, number>();
  const childrenByParent = new Map<number, MnyTransaction[]>();

  // Ordered by `iSplit` so legs keep the order the user sees in Money.
  for (const split of [...input.transactions.splits].sort(
    (a, b) => a.position - b.position,
  )) {
    if (split.parent === null || split.child === null) {
      continue;
    }
    const child = byHandle.get(split.child);
    if (!child) {
      continue;
    }
    parentOfChild.set(split.child, split.parent);
    if (!byHandle.has(split.parent)) {
      warnings.push({
        code: "orphanedSplit",
        subject: `htrn=${split.child}`,
        detail: `parent htrn=${split.parent}`,
        row: warningRow(child, input),
      });
      continue;
    }
    childrenByParent.set(split.parent, [
      ...(childrenByParent.get(split.parent) ?? []),
      child,
    ]);
  }

  const base: PostingIndexes = {
    byHandle,
    parentOfChild,
    childrenByParent,
    billTemplates: billTemplateHandles(
      input.bills,
      input.transactions.transactions,
    ),
    transfers: indexTransfers(input.transactions.transfers, rows),
    warnings,
  };

  return { ...base, tradeCashLegs: tradeCashLegRows(rows, base, input) };
}

/**
 * Whether a row is a posting at all, before the trade-cash-leg rule.
 *
 * Split children, bill templates, recurrence templates (`frq != -1`),
 * loan-payment templates, scheduled instances Money never posted and genuinely
 * orphaned transfer sides are out. Scheduler-posted rows are **in**: they are
 * real postings, and excluding them emptied PR #192's loan accounts.
 *
 * Separate from `isImportablePosting` only because `tradeCashLegRows` has to
 * ask this question in order to answer the other one.
 */
function isPostingRow(
  row: MnyTransaction,
  indexes: PostingIndexes,
  input: MapTransactionsInput,
): boolean {
  const handle = row.handle;
  return (
    handle !== null &&
    !indexes.parentOfChild.has(handle) &&
    !indexes.billTemplates.has(handle) &&
    !indexes.transfers.orphanedHandles.has(handle) &&
    !isRecurrenceTemplate(row.frequency) &&
    !isLoanPaymentTemplate(row.flags) &&
    !isUnpostedRow(row.flags) &&
    row.security === null &&
    row.date !== null &&
    row.account !== null &&
    input.accountKeyByHandle.has(row.account)
  );
}

/**
 * Whether a row is a real posting worth importing as a banking transaction:
 * a posting that Monize is not already writing from somewhere else.
 */
function isImportablePosting(
  row: MnyTransaction,
  indexes: Indexes,
  input: MapTransactionsInput,
): boolean {
  return (
    isPostingRow(row, indexes, input) &&
    !indexes.tradeCashLegs.has(row.handle as number)
  );
}

/**
 * Rows that are Money's own record of the cash half of a trade in the paired
 * brokerage account.
 *
 * Money keeps an investment account's cash in a companion account and writes
 * the cash side of a trade there as an ordinary `TRN` row, paired to the trade
 * through `TRN_XFER` -- `act` 1 has one 2,015 times in 2,029 and `act` 3 1,090
 * times in 1,090. Monize does not need that row: `writeInvestments` creates the
 * sleeve transaction itself from the investment row's `cashAmount`, and links
 * the two through `investment_transactions.transaction_id`.
 *
 * Importing it anyway put the same payment in the cash register three times --
 * the purchase, a transfer in and a transfer out -- where Money shows one
 * (issue #1175). The pair of extra rows is this row plus the counterpart
 * `buildCashCounterparts` synthesized for it, which for these rows lands in the
 * row's **own** account.
 *
 * That is also why dropping them cannot move a balance: a row belongs to this
 * set exactly when its synthesized counterpart mirrors it into the same
 * account, so the two always summed to zero. What changes is the row count, not
 * the money -- whatever the investment mapper then does with the trade, whether
 * it writes a cash leg, maps it to an action that moves none, or skips it
 * outright.
 *
 * **Top-level rows only.** A split *leg* in the sleeve pointing at a trade is a
 * different shape: its parent has already taken the cash out of the sleeve, so
 * there the synthesized counterpart is what keeps the balance right and must
 * stay.
 */
function tradeCashLegRows(
  rows: readonly MnyTransaction[],
  indexes: PostingIndexes,
  input: MapTransactionsInput,
): ReadonlySet<number> {
  const handles = new Set<number>();

  for (const row of rows) {
    if (!isPostingRow(row, indexes, input)) {
      continue;
    }
    const handle = row.handle as number;
    const partner = indexes.transfers.partnerByHandle.get(handle);
    const far =
      partner === undefined ? undefined : indexes.byHandle.get(partner);
    if (!far || far.security === null || far.account === null) {
      continue;
    }

    const brokerageKey = input.accountKeyByHandle.get(far.account);
    const cashKey =
      brokerageKey === undefined
        ? undefined
        : input.cashKeyByAccountKey.get(brokerageKey);
    if (cashKey !== undefined && cashKey === accountKeyOf(row, input)) {
      handles.add(handle);
    }
  }

  return handles;
}

/**
 * The cash-sleeve transactions that make bank-to-investment transfers balance.
 *
 * Money stores such a transfer as a pair whose far side carries `hsec`: one row
 * that is simultaneously "cash arrived from chequing" and "shares were bought".
 * The investment mapper takes that row and writes the trade, including its cash
 * leg *out* of the sleeve -- so nothing was left to represent the cash coming
 * *in*, and the bank row, whose partner is not a banking transaction, imported
 * as an ordinary payment with no counterpart.
 *
 * Money then simply vanished: across the maintainer's file 2,718 top-level rows
 * and 537 split legs debited a bank account with nothing arriving anywhere, and
 * the sleeves absorbed the whole difference -- $604,161.81 negative in total,
 * of which $553,225.57 is this.
 *
 * So the missing side is synthesized here, in the sleeve, linked to the bank
 * row both ways. The sleeve then nets out: the transfer pays cash in, the
 * trade's own leg takes it out.
 *
 * A near side already *in* that sleeve needs none of this, and gets none: those
 * rows are `tradeCashLegs`, so `isImportablePosting` rejects them and `nearId`
 * is undefined before the far side is ever looked at. A synthesized row
 * mirroring its own account is what issue #1175 saw in the register.
 */
function buildCashCounterparts(
  rows: readonly MnyTransaction[],
  indexes: Indexes,
  input: MapTransactionsInput,
  idByHandle: ReadonlyMap<number, string>,
): Map<number, CashCounterpart> {
  const counterparts = new Map<number, CashCounterpart>();

  for (const row of rows) {
    const handle = row.handle;
    if (handle === null) {
      continue;
    }

    // The near side has to be a row this import actually creates: a posting, or
    // a leg of one. A leg's transfer points back at its parent payment, the
    // same wiring `counterpartId` uses in the other direction.
    const parent = indexes.parentOfChild.get(handle);
    const nearId =
      parent === undefined
        ? isImportablePosting(row, indexes, input)
          ? idByHandle.get(handle)
          : undefined
        : idByHandle.get(parent);
    if (nearId === undefined) {
      continue;
    }

    const partner = indexes.transfers.partnerByHandle.get(handle);
    if (partner === undefined || counterparts.has(partner)) {
      continue;
    }
    const far = indexes.byHandle.get(partner);
    // Only an investment row needs standing in for. Anything else either
    // imports as a banking transaction of its own or is genuinely excluded.
    if (!far || far.security === null || far.account === null) {
      continue;
    }
    const brokerageKey = input.accountKeyByHandle.get(far.account);
    const cashKey =
      brokerageKey === undefined
        ? undefined
        : input.cashKeyByAccountKey.get(brokerageKey);
    if (cashKey === undefined) {
      continue;
    }

    counterparts.set(partner, {
      id: randomUUID(),
      handle: partner,
      accountKey: cashKey,
      transactionDate: (far.date ?? row.date) as string,
      // The mirror of the bank side, so the pair sums to zero.
      amount: roundMoney(-row.amount),
      currencyCode: input.currencyByHandle.get(far.account) ?? "",
      status: mapTransactionStatus(row.clearedStatus, row.flags),
      payeeHandle: row.payee,
      categoryHandle: null,
      description: row.memo,
      referenceNumber: null,
      isTransfer: true,
      linkedTransactionId: nearId,
      splits: [],
    });
  }

  return counterparts;
}

/** The Monize account a row's transaction belongs in, or null when not imported. */
function accountKeyOf(
  row: MnyTransaction | null,
  input: MapTransactionsInput,
): string | null {
  return row?.account === null || row?.account === undefined
    ? null
    : (input.accountKeyByHandle.get(row.account) ?? null);
}

/**
 * The transaction id a transfer counterpart should point at.
 *
 * When the counterpart is itself a split leg, the link goes to that leg's
 * **parent** transaction -- Monize records the split's own leg on
 * `transaction_splits.linked_transaction_id`, and the far side points back at the
 * parent payment.
 */
function counterpartId(partner: number, context: Context): string | null {
  const synthesized = context.cashCounterparts.get(partner);
  if (synthesized !== undefined) {
    return synthesized.id;
  }
  const throughParent = context.parentOfChild.get(partner);
  const target = throughParent ?? partner;
  return context.idByHandle.get(target) ?? null;
}

function mapSplitChild(
  child: MnyTransaction,
  context: Context,
): MappedSplit | null {
  const handle = child.handle;
  if (handle === null) {
    return null;
  }

  const partner = context.transfers.partnerByHandle.get(handle) ?? null;
  const partnerRow =
    partner === null ? null : (context.byHandle.get(partner) ?? null);
  // A leg paying into an investment account lands in that account's cash
  // sleeve, not on the brokerage side where the shares are.
  const synthesized =
    partner === null ? undefined : context.cashCounterparts.get(partner);
  const partnerKey =
    synthesized?.accountKey ?? accountKeyOf(partnerRow, context.input);
  const partnerId = partner === null ? null : counterpartId(partner, context);

  // A split leg Money records in TRN_XFER is a transfer -- most often the
  // principal portion of a loan payment.
  if (partnerKey !== null && partnerId !== null) {
    return {
      kind: SplitKind.TRANSFER,
      categoryHandle: null,
      transferAccountKey: partnerKey,
      linkedTransactionId: partnerId,
      amount: child.amount,
      memo: child.memo,
    };
  }

  if (partner !== null) {
    // The counterpart is not being imported. Keeping the leg as a category split
    // preserves the parent's total; dropping it would not.
    context.warnings.push({
      code: "transferAcrossExcludedAccount",
      subject: `htrn=${handle}`,
      detail: `partner htrn=${partner}`,
      row: warningRow(child, context.input),
    });
  }

  return {
    kind: SplitKind.CATEGORY,
    categoryHandle: child.category,
    transferAccountKey: null,
    linkedTransactionId: null,
    amount: child.amount,
    memo: child.memo,
  };
}

function mapOne(
  row: MnyTransaction,
  accountKey: string,
  context: Context,
): MappedTransaction {
  const handle = row.handle as number;
  const splits = (context.childrenByParent.get(handle) ?? [])
    .map((child) => mapSplitChild(child, context))
    .filter((split): split is MappedSplit => split !== null);

  if (splits.length > 0) {
    const legTotal = roundMoney(
      splits.reduce((sum, split) => sum + split.amount, 0),
    );
    const total = roundMoney(row.amount);
    if (legTotal !== total) {
      context.warnings.push({
        code: "splitSumMismatch",
        subject: `htrn=${handle}`,
        detail: `legs ${legTotal} vs total ${total}`,
        row: warningRow(row, context.input),
      });
    }
  }

  // A split parent is never itself a transfer: its transfer legs are splits.
  const partner =
    splits.length > 0
      ? null
      : (context.transfers.partnerByHandle.get(handle) ?? null);
  const linkedTransactionId =
    partner === null ? null : counterpartId(partner, context);

  if (partner !== null && linkedTransactionId === null) {
    context.warnings.push({
      code: "transferAcrossExcludedAccount",
      subject: `htrn=${handle}`,
      detail: `partner htrn=${partner}`,
      row: warningRow(row, context.input),
    });
  }

  return {
    id: context.idByHandle.get(handle) as string,
    handle,
    accountKey,
    transactionDate: row.date as string,
    amount: row.amount,
    currencyCode:
      context.input.currencyByHandle.get(row.account as number) ?? "",
    status: mapTransactionStatus(row.clearedStatus, row.flags),
    payeeHandle: row.payee,
    // A split parent carries no category of its own: the legs do.
    categoryHandle: splits.length > 0 ? null : row.category,
    description: row.memo,
    referenceNumber: decodeReference(row.reference),
    isTransfer: linkedTransactionId !== null,
    linkedTransactionId,
    splits,
  };
}

/**
 * Rows a real posting could not be made of, reported once each.
 *
 * A `tradeCashLegs` row is not one of them and deliberately raises nothing: it
 * is a perfectly usable posting that Monize writes from the trade instead, so
 * counting it as skipped would report data loss that did not happen. Its own
 * count travels as `MappedTransactions.tradeCashLegs`.
 */
function reportUnusable(
  rows: readonly MnyTransaction[],
  indexes: Indexes,
  input: MapTransactionsInput,
  warnings: MnyWarning[],
): number {
  let skipped = 0;

  for (const row of rows) {
    const handle = row.handle;
    if (
      handle === null ||
      indexes.parentOfChild.has(handle) ||
      indexes.billTemplates.has(handle) ||
      isRecurrenceTemplate(row.frequency) ||
      isLoanPaymentTemplate(row.flags) ||
      isUnpostedRow(row.flags) ||
      row.security !== null
    ) {
      continue;
    }

    if (indexes.transfers.orphanedHandles.has(handle)) {
      // A dangling TRN_XFER reference: Money's own phantom row.
      skipped += 1;
      warnings.push({
        code: "orphanedTransferSide",
        subject: `htrn=${handle}`,
        row: warningRow(row, input),
      });
      continue;
    }

    if (row.account === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${handle}`,
        detail: "no account",
        row: warningRow(row, input),
      });
      continue;
    }

    // An account the user left out is a choice, not a data problem.
    if (!input.accountKeyByHandle.has(row.account)) {
      continue;
    }

    if (row.date === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${handle}`,
        detail: "no usable date",
        row: warningRow(row, input),
      });
    }
  }

  return skipped;
}

/** Distinct transfer pairs where both top-level sides were imported. */
function countPlainTransferPairs(context: Context): number {
  const counted = new Set<number>();

  for (const [handle, partner] of context.transfers.partnerByHandle) {
    if (counted.has(handle) || counted.has(partner)) {
      continue;
    }
    const linked = (side: number): boolean =>
      context.idByHandle.has(side) || context.cashCounterparts.has(side);
    if (
      linked(handle) &&
      linked(partner) &&
      !context.parentOfChild.has(handle) &&
      !context.parentOfChild.has(partner)
    ) {
      counted.add(handle);
      counted.add(partner);
    }
  }

  return counted.size / 2;
}

/**
 * Maps banking transactions, deferring anything that carries a security to the
 * investment mapper (Phase 2 reads the same tables).
 *
 * Every transaction id is pre-generated (design ADR-9) so transfer pairs and
 * transfer splits are fully wired before the first INSERT and the writer needs no
 * second pass to discover them.
 */
export function mapTransactions(
  input: MapTransactionsInput,
): MappedTransactions {
  const indexes = buildIndexes(input);
  const rows = input.transactions.transactions;
  const warnings = indexes.warnings;

  const idByHandle = new Map<number, string>(
    rows
      .filter((row) => isImportablePosting(row, indexes, input))
      .map((row) => [row.handle as number, randomUUID()]),
  );

  const cashCounterparts = buildCashCounterparts(
    rows,
    indexes,
    input,
    idByHandle,
  );

  const context: Context = {
    input,
    byHandle: indexes.byHandle,
    parentOfChild: indexes.parentOfChild,
    childrenByParent: indexes.childrenByParent,
    billTemplates: indexes.billTemplates,
    transfers: indexes.transfers,
    idByHandle,
    cashCounterparts,
    warnings,
  };

  const transactions = [
    ...rows
      .filter((row) => isImportablePosting(row, indexes, input))
      .map((row) => mapOne(row, accountKeyOf(row, input) as string, context)),
    ...cashCounterparts.values(),
  ];

  const referencedPayees = new Set(
    transactions
      .map((transaction) => transaction.payeeHandle)
      .filter((handle): handle is number => handle !== null),
  );
  const referencedCategories = new Set(
    transactions
      .flatMap((transaction) => [
        transaction.categoryHandle,
        ...transaction.splits.map((split) => split.categoryHandle),
      ])
      .filter((handle): handle is number => handle !== null),
  );

  const transferSplits = transactions.reduce(
    (count, transaction) =>
      count +
      transaction.splits.filter((split) => split.kind === SplitKind.TRANSFER)
        .length,
    0,
  );

  return {
    transactions,
    referencedPayees,
    referencedCategories,
    transfersLinked: countPlainTransferPairs(context) + transferSplits,
    skipped: reportUnusable(rows, indexes, input, warnings),
    tradeCashLegs: indexes.tradeCashLegs.size,
    deferredInvestments: rows.filter(
      (row) =>
        row.security !== null &&
        row.handle !== null &&
        !indexes.parentOfChild.has(row.handle) &&
        !isRecurrenceTemplate(row.frequency),
    ).length,
    warnings,
  };
}
