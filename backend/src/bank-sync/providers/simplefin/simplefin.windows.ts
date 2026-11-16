import { isCalendarDate } from "../../../common/validators/is-calendar-date.validator";

import { getRequestTimezone } from "../../../common/request-context";

const DAY_SECONDS = 86_400;
// Bridge v2 emits gen.api for ranges over 45 days; do not ignore global errors.
export const SIMPLEFIN_MAX_WINDOW_DAYS = 45;
export interface SimplefinWindow {
  startDate: number;
  endDate: number;
}

/** Inclusive UTC calendar days become contiguous, exclusive-end API windows. */
export function simplefinWindows(
  dateFrom: string,
  dateTo: string,
): SimplefinWindow[] {
  if (
    !isCalendarDate(dateFrom) ||
    !isCalendarDate(dateTo) ||
    dateFrom > dateTo
  ) {
    throw new Error("Invalid SimpleFIN date range");
  }
  const padded =
    (getRequestTimezone() ??
      Intl.DateTimeFormat().resolvedOptions().timeZone) !== "UTC";
  const start =
    Date.parse(`${dateFrom}T00:00:00Z`) / 1000 - (padded ? DAY_SECONDS : 0);
  const end =
    Date.parse(`${dateTo}T00:00:00Z`) / 1000 +
    DAY_SECONDS +
    (padded ? DAY_SECONDS : 0);
  if (start < 0 || end > 253402300799)
    throw new Error("Unsupported SimpleFIN date range");
  const windows: SimplefinWindow[] = [];
  for (
    let cursor = start;
    cursor < end;
    cursor += SIMPLEFIN_MAX_WINDOW_DAYS * DAY_SECONDS
  ) {
    windows.push({
      startDate: cursor,
      endDate: Math.min(end, cursor + SIMPLEFIN_MAX_WINDOW_DAYS * DAY_SECONDS),
    });
  }
  return windows;
}
