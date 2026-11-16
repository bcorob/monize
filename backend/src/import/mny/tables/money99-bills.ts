import { isRecurrenceTemplate } from "../model/mny-model";
import { MnyBill } from "../model/mny-rows";
import { toDate, toHandle, toInteger, toNumber } from "../model/mny-values";
import { MnyDatabase } from "../msisam/open-mny";
import type { MnyBillData } from "./read-bills";
import { RowSpec, readTableByName } from "./table-reader";

/**
 * Scheduled bills of a Money 97-99 file, which has no `BILL` table.
 *
 * Money 97-99 keep a series as a recurrence template in `TRN` (`frq != -1`)
 * plus one pending instance, and the template's `htrnSrc` names that instance.
 * A scheduled transfer is two templates, one per leg, and only the paying leg
 * names an instance, so "has a pending instance" is also "is the series' own
 * template" -- the receiving leg, a split template's legs and their
 * counterparts never qualify.
 *
 * Each series becomes the one `BILL` row the mappers would have read from a
 * Money 2001+ file: the template is both the series and its row, dated at the
 * template's own `dt` (the pending instance's date). Money 99 stores no end
 * date or series status, and `cpmtsRemaining` was -1 on every template
 * observed, so the series is unbounded and its status unknown (-1), which
 * nothing filters on.
 */

interface Money99BillTemplate {
  readonly handle: number | null;
  readonly frequency: number;
  readonly occurrencesPerUnit: number;
  readonly date: string | null;
  readonly pendingInstance: number | null;
}

const TEMPLATE_SPEC: RowSpec<Money99BillTemplate> = {
  handle: { from: "htrn", as: toHandle },
  frequency: { from: "frq", as: (value) => toInteger(value, -1) },
  occurrencesPerUnit: { from: "cFrqInst", as: (value) => toNumber(value, 1) },
  date: { from: "dt", as: toDate },
  pendingInstance: { from: "htrnSrc", as: toHandle },
};

/** Money 99 records no series status; nothing reads one either way. */
const UNKNOWN_STATUS = -1;

export function readMoney99Bills(db: MnyDatabase): MnyBillData {
  const templates = readTableByName(db, "TRN", TEMPLATE_SPEC);

  const bills = templates.rows
    .filter(
      (row) =>
        row.handle !== null &&
        isRecurrenceTemplate(row.frequency) &&
        row.pendingInstance !== null,
    )
    .map((row): MnyBill => ({
      handle: row.handle,
      status: UNKNOWN_STATUS,
      frequency: row.frequency,
      occurrencesPerUnit: row.occurrencesPerUnit,
      nextDue: row.date,
      templateTransaction: row.handle,
      series: row.handle,
      instance: 0,
      endsOn: null,
      maxInstances: -1,
    }));

  return {
    bills,
    supported: templates.availability.present,
    availability: templates.availability,
  };
}
