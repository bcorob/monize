import { randomUUID } from "node:crypto";
import { AccountSubType } from "../../../accounts/entities/account.entity";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { baseInvestmentAction } from "../../../securities/investment-replay.util";
import {
  disposalCashAmount,
  proceedsExcludingAccruedInterest,
  supportsAccruedInterest,
} from "../../../securities/accrued-interest.util";
import { roundMoney, roundToDecimals } from "../../../common/round.util";
import {
  MappedAccounts,
  MappedInvestmentTransaction,
  MappedInvestments,
  MappedSecurities,
} from "../model/mny-import-model";
import {
  MNY_UNCONFIRMED_ACTIONS,
  billTemplateHandles,
  decodeReference,
  hasInvestmentDetail,
  isRecurrenceTemplate,
  isUnpostedRow,
  mapInvestmentAction,
  mapTransactionStatus,
} from "../model/mny-model";
import { MnyBill, MnyTransaction } from "../model/mny-rows";
import { MnyWarning, MnyWarningRow } from "../model/mny-warnings";
import { MnyInvestmentData } from "../tables/read-investments";
import { cashKeyByAccountKey } from "./map-reference";
import { MnyTransactionData } from "../tables/read-transactions";

/**
 * `TRN` rows carrying a security, mapped onto Monize investment transactions.
 *
 * Every rule here answers a specific way PR #192 corrupted positions (issue 4 in
 * the design's assessment table):
 *
 * - **Driven from `TRN`, not `TRN_INV`.** A cash dividend (`act` 4) has no
 *   `TRN_INV` row at all, so iterating the detail table dropped every one of
 *   them. Investment rows are identified by carrying a security, never by their
 *   action code -- `act = 0` is BUY and is indistinguishable from a plain
 *   payment by code alone.
 * - **`act` 16 is REMOVE_SHARES, never SELL.** It closes lots without a sale, so
 *   mapping it to SELL both invented proceeds and corrupted average cost.
 * - **Quantity is always positive.** `TRN_INV.qty` is stored positive and
 *   direction comes only from the action; inferring it from a sign is what
 *   produced negative positions.
 * - **`SEC_SPLIT` is *not* applied to positions.** See `reportUnappliedSplits`:
 *   Money does not adjust its own share counts for those rows, and adjusting
 *   ours makes the import disagree with the file it came from.
 *
 * Nothing here touches the database, and no code is guessed: an action outside
 * the known set is skipped and counted, and an action whose meaning is inferred
 * or reported rather than measured here (`MNY_UNCONFIRMED_ACTIONS`) carries a
 * warning on every row it maps.
 */

/** Quantities are `decimal(20,8)`; ratios and share counts round to match. */
const QUANTITY_DECIMALS = 8;

/** Prices are `decimal(20,6)`. */
const PRICE_DECIMALS = 6;

/** Shares move and no money changes hands, so the transaction has no value. */
const ZERO_TOTAL_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
  InvestmentAction.TRANSFER_IN,
  InvestmentAction.TRANSFER_OUT,
  InvestmentAction.SPLIT,
]);

/**
 * Actions that never touch the cash sleeve. A reinvested distribution has a
 * real value but the money buys shares without ever landing as cash, so it has
 * a total and no cash leg.
 */
const NO_CASH_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  ...ZERO_TOTAL_ACTIONS,
  InvestmentAction.REINVEST,
]);

/** Cash leaves the sleeve; every other cash-moving action pays into it. */
const CASH_OUT_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
]);

export interface MapInvestmentsInput {
  readonly transactions: MnyTransactionData;
  readonly investments: MnyInvestmentData;
  readonly accounts: MappedAccounts;
  readonly securities: MappedSecurities;
  /** `BILL` rows, so their template transactions are not imported as postings. */
  readonly bills: readonly MnyBill[];
}

interface Context {
  readonly input: MapInvestmentsInput;
  /** `TRN_INV.htrn` -> the detail row, when the file has one. */
  readonly detailByHandle: ReadonlyMap<number, MnyInvestmentDetailValues>;
  /** Brokerage account key -> the cash sleeve that takes its cash legs. */
  readonly cashKeyByAccountKey: ReadonlyMap<string, string>;
  /** Account keys that are brokerage sides, so shares land somewhere real. */
  readonly brokerageKeys: ReadonlySet<string>;
  readonly warnings: MnyWarning[];
}

/**
 * The flagged-row context an investment warning carries, so the review step can
 * point at a transaction the user can find in Money rather than a bare `htrn`.
 */
function warningRow(
  row: MnyTransaction,
  input: MapInvestmentsInput,
): MnyWarningRow {
  return {
    handle: row.handle as number,
    accountKey:
      row.account === null
        ? null
        : (input.accounts.keyByHandle.get(row.account) ?? null),
    date: row.date,
    amount: row.amount,
    payeeHandle: row.payee,
    reference: decodeReference(row.reference),
    memo: row.memo,
  };
}

interface MnyInvestmentDetailValues {
  readonly price: number;
  readonly quantity: number;
  readonly commission: number;
  /** `TRN_INV.amtInt`: accrued interest, paid out with a redemption. */
  readonly interest: number;
}

/**
 * Replay order: by date, and by file order within a date. The holdings rebuild
 * orders the same way -- by date and then by insertion, since rows inserted in
 * one statement share a `created_at` -- so this is the order the positions will
 * be folded in after the write.
 */
function orderForReplay(
  transactions: readonly MappedInvestmentTransaction[],
): MappedInvestmentTransaction[] {
  return [...transactions].sort((a, b) =>
    a.transactionDate === b.transactionDate
      ? 0
      : a.transactionDate < b.transactionDate
        ? -1
        : 1,
  );
}

function indexDetails(
  investments: MnyInvestmentData,
): Map<number, MnyInvestmentDetailValues> {
  const byHandle = new Map<number, MnyInvestmentDetailValues>();
  for (const detail of investments.investmentDetails) {
    if (detail.transaction === null) {
      continue;
    }
    byHandle.set(detail.transaction, {
      price: detail.price,
      quantity: detail.quantity,
      commission: detail.commission,
      interest: detail.interest,
    });
  }
  return byHandle;
}

/**
 * The magnitude of the transaction.
 *
 * `TRN.amt` is Money's own cash figure and wins where it has one: it already
 * carries commission and any accrued interest, so recomputing from quantity and
 * price would disagree with what Money shows by those amounts. The sign is
 * discarded and taken from the action instead, which is the same rule that
 * governs quantity.
 *
 * The accrued interest is then taken back out: it is income, and a redemption's
 * total is proceeds, which is what every realized-gain fold measures against
 * cost basis. It reaches the ledger as the linked INTEREST companion instead.
 */
function totalAmountOf(
  row: MnyTransaction,
  action: InvestmentAction,
  quantity: number | null,
  price: number | null,
  commission: number,
  accruedInterest: number,
): number {
  const base = baseInvestmentAction(action);
  if (ZERO_TOTAL_ACTIONS.has(base as InvestmentAction)) {
    return 0;
  }
  if (row.amount !== 0) {
    return proceedsExcludingAccruedInterest(
      Math.abs(row.amount),
      accruedInterest,
    );
  }
  if (quantity === null || price === null) {
    return 0;
  }
  const gross = quantity * price;
  return roundMoney(
    base === InvestmentAction.SELL ? gross - commission : gross + commission,
  );
}

/** Signed impact on the cash sleeve. Direction comes from the action only. */
function cashAmountOf(
  action: InvestmentAction,
  totalAmount: number,
  accruedInterest: number,
): number {
  const base = baseInvestmentAction(action) as InvestmentAction;
  if (NO_CASH_ACTIONS.has(base) || totalAmount === 0) {
    return 0;
  }
  // The interest arrives with the proceeds, in one movement of money.
  const magnitude = disposalCashAmount(totalAmount, accruedInterest);
  return CASH_OUT_ACTIONS.has(base) ? -magnitude : magnitude;
}

function positiveOrNull(value: number, decimals: number): number | null {
  const rounded = roundToDecimals(Math.abs(value), decimals);
  return rounded > 0 ? rounded : null;
}

function mapOne(
  row: MnyTransaction,
  accountKey: string,
  action: InvestmentAction,
  context: Context,
): MappedInvestmentTransaction[] {
  const handle = row.handle as number;
  const detail = context.detailByHandle.get(handle);

  if (!detail && hasInvestmentDetail(row.action)) {
    // The cash figure on the TRN row is still real, so the row imports without
    // a share movement rather than being dropped or having one invented.
    context.warnings.push({
      code: "missingInvestmentDetail",
      subject: `htrn=${handle}`,
      detail: `act=${row.action}`,
      row: warningRow(row, context.input),
    });
  }

  const quantity = detail
    ? positiveOrNull(detail.quantity, QUANTITY_DECIMALS)
    : null;
  const price = detail ? positiveOrNull(detail.price, PRICE_DECIMALS) : null;
  const commission = detail ? roundMoney(Math.abs(detail.commission)) : 0;
  // Money records accrued interest on any investment detail row, but only a
  // redemption pays it out; anywhere else there is no action to carry it.
  const accruedInterest =
    detail && supportsAccruedInterest(action)
      ? roundMoney(Math.abs(detail.interest))
      : 0;
  const totalAmount = totalAmountOf(
    row,
    action,
    quantity,
    price,
    commission,
    accruedInterest,
  );
  const cashAmount = cashAmountOf(action, totalAmount, accruedInterest);
  const id = randomUUID();
  const currencyCode =
    context.input.accounts.currencyByHandle.get(row.account as number) ?? "";
  const status = mapTransactionStatus(row.clearedStatus, row.flags);
  const companionId = accruedInterest > 0 ? randomUUID() : null;

  const redemption: MappedInvestmentTransaction = {
    id,
    handle,
    accountKey,
    cashAccountKey:
      cashAmount === 0
        ? null
        : (context.cashKeyByAccountKey.get(accountKey) ?? null),
    // Both null here, and rewritten by `applyInvestmentCashSources` for the
    // trades Money paired with a banking row: this mapper runs before the
    // transaction mapper and cannot yet know which those are.
    fundingAccountKey: null,
    cashTransactionId: null,
    transactionSplitId: null,
    securityHandle: row.security as number,
    action,
    transactionDate: row.date as string,
    quantity,
    price,
    commission,
    accruedInterest,
    totalAmount,
    currencyCode,
    // A sleeve shares its brokerage's currency, so a trade settling there needs
    // no conversion. Only an adopted funding row can make this anything else.
    exchangeRate: 1,
    cashAmount,
    status,
    payeeHandle: row.payee,
    categoryHandle: row.category,
    description: row.memo,
    linkedInvestmentId: companionId,
  };

  if (companionId === null) {
    return [redemption];
  }

  return [
    redemption,
    {
      ...redemption,
      id: companionId,
      // No handle: the companion is not a `TRN` row, so nothing may adopt a
      // banking row on its behalf (`applyInvestmentCashSources` keys on it).
      handle: null,
      action: InvestmentAction.INTEREST,
      quantity: null,
      price: accruedInterest,
      commission: 0,
      accruedInterest: 0,
      totalAmount: accruedInterest,
      // The redemption's own cash row carries the interest already.
      cashAccountKey: null,
      cashAmount: 0,
      linkedInvestmentId: id,
    },
  ];
}

/**
 * Turns matching `act` 15 / `act` 16 rows into a linked TRANSFER_IN /
 * TRANSFER_OUT pair.
 *
 * Money records a security moving between accounts as two independent rows: an
 * ADD_SHARES in the destination and a REMOVE_SHARES in the source, with nothing
 * connecting them. They are the same event, so they are matched on date,
 * security and quantity across two different accounts.
 *
 * An unpaired row stays ADD/REMOVE_SHARES and produces **no warning**: that is
 * exactly what Money recorded and the position it produces is identical either
 * way. Opening a portfolio with shares transferred in from a broker is the
 * ordinary case, not an anomaly -- `money2002.mny` alone has 60 of them, which
 * is 60 lines of noise burying the warnings that do mean something.
 */
function pairShareTransfers(
  transactions: readonly MappedInvestmentTransaction[],
): { transactions: MappedInvestmentTransaction[]; paired: number } {
  const key = (transaction: MappedInvestmentTransaction): string =>
    `${transaction.transactionDate}|${transaction.securityHandle}|${transaction.quantity ?? 0}`;

  const removals = new Map<string, MappedInvestmentTransaction[]>();
  for (const transaction of transactions) {
    if (transaction.action !== InvestmentAction.REMOVE_SHARES) {
      continue;
    }
    const bucket = removals.get(key(transaction)) ?? [];
    removals.set(key(transaction), [...bucket, transaction]);
  }

  /** id -> the id it links to, and the action it becomes. */
  const rewrites = new Map<
    string,
    { action: InvestmentAction; linkedInvestmentId: string }
  >();
  const claimed = new Set<string>();
  let paired = 0;

  for (const addition of transactions) {
    if (
      addition.action !== InvestmentAction.ADD_SHARES ||
      addition.quantity === null
    ) {
      continue;
    }
    const partner = (removals.get(key(addition)) ?? []).find(
      (candidate) =>
        !claimed.has(candidate.id) &&
        candidate.accountKey !== addition.accountKey,
    );
    if (!partner) {
      continue;
    }

    claimed.add(partner.id);
    claimed.add(addition.id);
    rewrites.set(addition.id, {
      action: InvestmentAction.TRANSFER_IN,
      linkedInvestmentId: partner.id,
    });
    rewrites.set(partner.id, {
      action: InvestmentAction.TRANSFER_OUT,
      linkedInvestmentId: addition.id,
    });
    paired += 1;
  }

  const rewritten = transactions.map((transaction) => {
    const rewrite = rewrites.get(transaction.id);
    return rewrite
      ? {
          ...transaction,
          action: rewrite.action,
          linkedInvestmentId: rewrite.linkedInvestmentId,
        }
      : transaction;
  });

  return { transactions: rewritten, paired };
}

/**
 * Reports the `SEC_SPLIT` rows the file records, without applying any of them.
 *
 * The importer used to synthesize a SPLIT transaction per holder, on the design's
 * premise that ignoring a split leaves every later position wrong by its ratio.
 * **Money does not adjust its own share counts for these rows**, so applying them
 * makes the import disagree with the file. Two files say so, at seven positions,
 * with no counter-example:
 *
 * - The maintainer's brokerage held 200 VTI bought pre-`SEC_SPLIT` plus 100
 *   after, and transferred the account away with a single 300-share row. Money's
 *   `LOT` rows for both purchases are fully consumed by that transfer; applying
 *   the 1:2 ratio leaves 200 shares in an account Money shows as empty. XIU
 *   (1:4), XIC (1:4) and VWO (1:2) each do the same thing.
 * - Money Plus's own `sample.mny` agrees: `LOT` holds 3 MSFT against 6 replayed
 *   with the 1:2 split, 50 LEH against 1,225, and 110.25 ADM against 115.7625.
 *
 * The price series makes the reason visible. A split's `SP` row carries
 * `dPrice = 0` and `src = 0` -- a marker in the quote history, not a quote -- and
 * the prices either side of it are continuous, in the same units as the
 * transactions. `SEC_SPLIT` is quote-feed metadata: it turns up for securities
 * the user never held, and for the annual 1:1 "splits" Canadian ETFs record
 * against a reinvested distribution.
 *
 * So the rows are surfaced rather than acted on, and only when they could have
 * mattered: a ratio of exactly 1 changes no position, and a security the import
 * left behind has no position to change.
 */
function reportUnappliedSplits(context: Context): void {
  const { securitySplits, splitSecurities } = context.input.investments;

  for (const split of securitySplits) {
    if (split.handle === null) {
      continue;
    }
    const securityHandle = splitSecurities.get(split.handle) ?? null;
    const security =
      securityHandle === null
        ? undefined
        : context.input.securities.byHandle.get(securityHandle);
    const ratio =
      split.sharesBefore > 0 ? split.sharesAfter / split.sharesBefore : 0;

    if (
      security === undefined ||
      split.recordDate === null ||
      !Number.isFinite(ratio) ||
      ratio <= 0 ||
      ratio === 1
    ) {
      continue;
    }

    context.warnings.push({
      code: "securitySplitNotApplied",
      subject: security.symbol,
      detail: `${split.recordDate}: ${split.sharesBefore} -> ${split.sharesAfter}`,
    });
  }
}

function buildContext(input: MapInvestmentsInput): Context {
  const brokerageKeys = new Set<string>();
  for (const account of input.accounts.accounts) {
    if (account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE) {
      brokerageKeys.add(account.key);
    }
  }

  return {
    input,
    detailByHandle: indexDetails(input.investments),
    // Shared with the transaction mapper, which routes transfers into the same
    // sleeve this puts trade cash legs in.
    cashKeyByAccountKey: cashKeyByAccountKey(input.accounts),
    brokerageKeys,
    warnings: [],
  };
}

export function mapInvestments(input: MapInvestmentsInput): MappedInvestments {
  const context = buildContext(input);
  const warnings = context.warnings;
  const templates = billTemplateHandles(
    input.bills,
    input.transactions.transactions,
  );
  const splitChildren = new Set(
    input.transactions.splits
      .map((split) => split.child)
      .filter((child): child is number => child !== null),
  );

  const mapped: MappedInvestmentTransaction[] = [];
  let skipped = 0;

  for (const row of input.transactions.transactions) {
    if (
      row.handle === null ||
      row.security === null ||
      splitChildren.has(row.handle) ||
      templates.has(row.handle) ||
      isRecurrenceTemplate(row.frequency) ||
      isUnpostedRow(row.flags)
    ) {
      continue;
    }

    const accountKey =
      row.account === null
        ? null
        : (input.accounts.keyByHandle.get(row.account) ?? null);
    if (accountKey === null) {
      // The account was left out of the import: a choice, not a data problem.
      continue;
    }

    if (row.date === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${row.handle}`,
        detail: "no usable date",
        row: warningRow(row, input),
      });
      continue;
    }

    if (!input.securities.byHandle.has(row.security)) {
      // A currency pseudo-security, or a SEC row with no usable identity.
      skipped += 1;
      warnings.push({
        code: "missingInvestmentDetail",
        subject: `htrn=${row.handle}`,
        detail: `hsec=${row.security}`,
        row: warningRow(row, input),
      });
      continue;
    }

    if (!context.brokerageKeys.has(accountKey)) {
      skipped += 1;
      warnings.push({
        code: "investmentAccountMismatch",
        subject: `htrn=${row.handle}`,
        detail: accountKey,
        row: warningRow(row, input),
      });
      continue;
    }

    const action = mapInvestmentAction(row.action);
    if (action === null) {
      skipped += 1;
      warnings.push({
        code: "unknownInvestmentAction",
        subject: `htrn=${row.handle}`,
        detail: `act=${row.action}`,
        row: warningRow(row, input),
      });
      continue;
    }

    if (MNY_UNCONFIRMED_ACTIONS.has(row.action)) {
      warnings.push({
        code: "unconfirmedInvestmentAction",
        subject: `htrn=${row.handle}`,
        detail: `act=${row.action}`,
        row: warningRow(row, input),
      });
    }

    mapped.push(...mapOne(row, accountKey, action, context));
  }

  const paired = pairShareTransfers(mapped);
  reportUnappliedSplits(context);
  const transactions = orderForReplay(paired.transactions);

  return {
    transactions,
    referencedSecurities: new Set(
      transactions.map((transaction) => transaction.securityHandle),
    ),
    referencedPayees: new Set(
      transactions
        .map((transaction) => transaction.payeeHandle)
        .filter((handle): handle is number => handle !== null),
    ),
    referencedCategories: new Set(
      transactions
        .map((transaction) => transaction.categoryHandle)
        .filter((handle): handle is number => handle !== null),
    ),
    transfersPaired: paired.paired,
    skipped,
    warnings,
  };
}
