import {
  MnyTransaction,
  MnyTransactionSplit,
  MnyTransfer,
} from "../model/mny-rows";
import {
  toAmount,
  toDate,
  toHandle,
  toInteger,
  toOptionalText,
} from "../model/mny-values";
import { MnyFileFormat } from "../model/mny-money99";
import { MnyDatabase } from "../msisam/open-mny";
import { adaptMoney99Transactions } from "./money99-transactions";
import { RowSpec, TableAvailability, readTableByName } from "./table-reader";

/**
 * Readers for `TRN`, `TRN_SPLIT` and `TRN_XFER`.
 *
 * The version aliases live here: Money Plus moved the payee handle from `hpay`
 * to `lHpay`, and the classification handles from `hcls1` / `hcls2` to
 * `lHcls1` / `lHcls2`. A file has exactly one of each pair, so reading only the
 * old name silently drops every payee on a Money Plus file -- the newest name
 * is therefore listed first.
 *
 * A Money 97-99 file differs by more than names, and its rows are rewritten
 * into the Money 2001+ shape here (`adaptMoney99Transactions`), so no mapper
 * has to know which format it is reading -- except for the action table, which
 * the mappers look up by `format`.
 */

const TRANSACTION_SPEC: RowSpec<MnyTransaction> = {
  handle: { from: "htrn", as: toHandle },
  account: { from: "hacct", as: toHandle },
  linkedAccount: { from: "hacctLink", as: toHandle },
  payee: { from: ["lHpay", "hpay"], as: toHandle },
  category: { from: "hcat", as: toHandle },
  security: { from: "hsec", as: toHandle },
  date: { from: "dt", as: toDate },
  amount: { from: "amt", as: toAmount },
  clearedStatus: { from: "cs", as: toInteger },
  flags: { from: "grftt", as: toInteger },
  action: { from: "act", as: (value) => toInteger(value, -1) },
  frequency: { from: "frq", as: (value) => toInteger(value, -1) },
  reference: { from: "szId", as: toOptionalText },
  memo: { from: "mMemo", as: toOptionalText },
  billSeries: { from: "hbillHead", as: toHandle },
  // Money writes -1 for "no classification", which `toHandle` reads as null.
  classification1: { from: ["lHcls1", "hcls1"], as: toHandle },
  classification2: { from: ["lHcls2", "hcls2"], as: toHandle },
};

const SPLIT_SPEC: RowSpec<MnyTransactionSplit> = {
  child: { from: "htrn", as: toHandle },
  parent: { from: "htrnParent", as: toHandle },
  position: { from: "iSplit", as: toInteger },
};

const TRANSFER_SPEC: RowSpec<MnyTransfer> = {
  from: { from: "htrnFrom", as: toHandle },
  to: { from: "htrnLink", as: toHandle },
};

export interface MnyTransactionData {
  /** Which code space `TRN.act` is in; see `mapInvestmentAction`. */
  readonly format: MnyFileFormat;
  readonly transactions: MnyTransaction[];
  readonly splits: MnyTransactionSplit[];
  readonly transfers: MnyTransfer[];
  readonly availability: readonly TableAvailability[];
}

export function readTransactionData(db: MnyDatabase): MnyTransactionData {
  const transactions = readTableByName(db, "TRN", TRANSACTION_SPEC);
  const splits = readTableByName(db, "TRN_SPLIT", SPLIT_SPEC);
  const transfers = readTableByName(db, "TRN_XFER", TRANSFER_SPEC);

  const rows =
    db.format === "jet3"
      ? adaptMoney99Transactions(transactions.rows, transfers.rows)
      : { transactions: transactions.rows, transfers: transfers.rows };

  return {
    format: db.format,
    transactions: rows.transactions,
    splits: splits.rows,
    transfers: rows.transfers,
    availability: [
      transactions.availability,
      splits.availability,
      transfers.availability,
    ],
  };
}
