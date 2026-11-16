import { getRequestTimezone } from "../common/request-context";
import { addDaysYMD, todayInTimezone } from "../common/date-utils";
import { SYNC_OVERLAP_DAYS } from "./bank-sync.constants";
import type { BankSyncAccount } from "./entities/bank-sync-account.entity";

export function syncWindow(
  link: Pick<BankSyncAccount, "syncFromDate" | "lastSuccessAt">,
  today: string,
): { dateFrom: string; dateTo: string } {
  let dateFrom = link.syncFromDate ?? today;
  if (link.lastSuccessAt) {
    const overlapStart = addDaysYMD(
      todayInTimezone(
        getRequestTimezone() ??
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        link.lastSuccessAt,
      ) ?? link.lastSuccessAt.toISOString().slice(0, 10),
      -SYNC_OVERLAP_DAYS,
    );
    if (overlapStart > dateFrom) dateFrom = overlapStart;
  }
  if (dateFrom > today) dateFrom = today;
  return { dateFrom, dateTo: today };
}

/** Each historical batch is separately reviewed; its cursor advances with the ledger. */
export function simplefinBatchWindow(
  link: Pick<
    BankSyncAccount,
    "syncFromDate" | "lastSuccessAt" | "backfillThrough"
  >,
  today: string,
) {
  const window = syncWindow(link, today);
  if (link.backfillThrough)
    window.dateFrom = addDaysYMD(link.backfillThrough, 1);
  const end = addDaysYMD(window.dateFrom, 44);
  return { dateFrom: window.dateFrom, dateTo: end < today ? end : today };
}
