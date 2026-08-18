import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { roundFxRate } from "../../../common/fx-entry.util";
import {
  MappedInvestmentTransaction,
  MappedInvestments,
  MnyImportedTrade,
  MnyInvestmentCashSource,
} from "../model/mny-import-model";

/**
 * Where a trade's cash row comes from, decided once for every surface that
 * cares.
 *
 * Monize records the cash half of an investment action in one of three places,
 * and only the first is a row the investment writer creates:
 *
 * 1. **The brokerage's cash sleeve.** `writeInvestments` inserts it and links it
 *    through `investment_transactions.transaction_id`.
 * 2. **A funding account Money already has a row in** (issue #1212). That row is
 *    the cash leg; the trade adopts it.
 * 3. **A split leg the trade is embedded in** (issue #1211). The leg carries the
 *    amount; there is no separate cash row at all.
 *
 * Three readers have to agree about which of the three a trade is in -- the
 * writer, the expected-balance computation and the per-account row count -- and
 * the failure mode when they disagree is silent: a balance short or long by the
 * trade, or a verification report that flags every brokerage cash account.
 * Hence one predicate rather than three copies of `cashAmount !== 0`.
 */
export function investmentWritesOwnCashRow(
  transaction: MappedInvestmentTransaction,
): boolean {
  return (
    transaction.cashAccountKey !== null &&
    transaction.cashAmount !== 0 &&
    transaction.cashTransactionId === null &&
    transaction.transactionSplitId === null
  );
}

/**
 * The trades the transaction mapper needs to see, keyed by `TRN.htrn`.
 *
 * Only rows that will really be written are in it: a security-carrying `TRN`
 * row the investment mapper skipped -- an unknown `act`, a currency
 * pseudo-security, an account the user left out -- is not a trade, and a
 * banking row paired to one must stay exactly as Money wrote it.
 */
export function tradesByHandle(
  investments: MappedInvestments,
): ReadonlyMap<number, MnyImportedTrade> {
  const trades = new Map<number, MnyImportedTrade>();
  for (const transaction of investments.transactions) {
    if (transaction.handle === null) {
      continue;
    }
    trades.set(transaction.handle, {
      accountKey: transaction.accountKey,
      action: transaction.action,
      cashAmount: transaction.cashAmount,
      status: transaction.status,
    });
  }
  return trades;
}

/**
 * Points each trade at the banking row that already records its cash.
 *
 * The rate is derived, not defaulted. A trade funded from an account in another
 * currency has two amounts Money recorded for one event -- the trade's total in
 * the security's currency and the funding row's amount in the account's -- and
 * their ratio is the rate that settlement actually happened at. Writing 1 there
 * would post the cash unconverted, which is the "rate 1 means same currency,
 * never no rate found" rule: the cash side would be short or long by the whole
 * FX spread. `cashAmount !== 0` is what puts a trade in this map at all, and
 * `cashAmountOf` returns 0 whenever `totalAmount` is 0, so the divisor is
 * always positive here.
 */
export function applyInvestmentCashSources(
  investments: MappedInvestments,
  sources: ReadonlyMap<number, MnyInvestmentCashSource>,
): MappedInvestments {
  if (sources.size === 0) {
    return investments;
  }

  return {
    ...investments,
    transactions: investments.transactions.map((transaction) => {
      const source =
        transaction.handle === null
          ? undefined
          : sources.get(transaction.handle);
      if (source === undefined) {
        return transaction;
      }

      return {
        ...transaction,
        cashAccountKey: source.accountKey,
        // One movement of money, so one VOID boundary. An embedded row takes
        // its parent's status outright (`createEmbeddedForSplit`); an adopted
        // funding row and its trade void together, and `mapOne` applies the
        // other direction so the pair cannot end up half voided.
        status:
          source.status === TransactionStatus.VOID
            ? TransactionStatus.VOID
            : source.splitId !== null
              ? source.status
              : transaction.status,
        // Null for an embedded split, matching `createEmbeddedForSplit`: the
        // parent transaction's own account is the cash side there, so naming a
        // funding account as well would claim a second one.
        fundingAccountKey: source.splitId === null ? source.accountKey : null,
        cashTransactionId: source.transactionId,
        transactionSplitId: source.splitId,
        exchangeRate:
          source.currencyCode === transaction.currencyCode ||
          transaction.totalAmount <= 0
            ? 1
            : roundFxRate(Math.abs(source.amount) / transaction.totalAmount),
      };
    }),
  };
}
