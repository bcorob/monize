import { MnyBill } from "../model/mny-rows";
import { toDate, toHandle, toInteger, toNumber } from "../model/mny-values";
import { MnyDatabase } from "../msisam/open-mny";
import { RowSpec, TableAvailability, readTableByName } from "./table-reader";

/**
 * Reader for `BILL`, Money's scheduled bills and deposits.
 *
 * Money 2001 has no `BILL` table. Its absence is reported, never thrown --
 * assuming the Money Plus table set is what crash-looped the PR #192 proof of
 * concept on a Money 2001 file.
 */

const BILL_SPEC: RowSpec<MnyBill> = {
  handle: { from: "hbill", as: toHandle },
  status: { from: "st", as: (value) => toInteger(value, -1) },
  frequency: { from: "frq", as: (value) => toInteger(value, -1) },
  occurrencesPerUnit: { from: "cFrqInst", as: (value) => toNumber(value, 1) },
  nextDue: { from: "dt", as: toDate },
  templateTransaction: { from: "lHtrn", as: toHandle },
  series: { from: "hbillHead", as: toHandle },
  instance: { from: "iinst", as: toInteger },
  endsOn: { from: "dtMax", as: toDate },
  maxInstances: { from: "cInstMax", as: toInteger },
};

export interface MnyBillData {
  readonly bills: MnyBill[];
  /** False for Money 2001 files, which predate scheduled bills. */
  readonly supported: boolean;
  readonly availability: TableAvailability;
}

export function readBillData(db: MnyDatabase): MnyBillData {
  const bills = readTableByName(db, "BILL", BILL_SPEC);

  return {
    bills: bills.rows,
    supported: bills.availability.present,
    availability: bills.availability,
  };
}
