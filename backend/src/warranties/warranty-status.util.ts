import { addDaysYMD } from "../common/date-utils";
import { daysBetweenYMD } from "../bank-sync/bank-sync-notifications";

/**
 * The status of a warranty, derived and never stored
 * (docs/specs/warranty-tracker.md decision 2, truth table A).
 */
export type WarrantyStatus = "lifetime" | "active" | "expiring" | "expired";

export const WARRANTY_STATUSES: readonly WarrantyStatus[] = [
  "lifetime",
  "active",
  "expiring",
  "expired",
];

/**
 * Days before `expires_on` during which a warranty reads `expiring`. Fixed in
 * v1 (decision 3); open question W1 asks whether it becomes a preference.
 */
export const WARRANTY_EXPIRING_WINDOW_DAYS = 30;

export interface WarrantyStatusResult {
  status: WarrantyStatus;
  /** Whole days from `today` to `expiresOn`; negative once expired; `null` for lifetime. */
  daysLeft: number | null;
}

/**
 * The one place a warranty's expiry is compared with today (WTY-002). The
 * list, the detail, the summary, the widget, the cron and the AI tool all read
 * the answer; none of them compares the two dates itself.
 *
 * Both dates are calendar dates (`YYYY-MM-DD`); `today` is the reader's own
 * date in their timezone. A warranty that expires today is `expiring` with
 * `daysLeft` 0, not `expired` (Warracker's rule).
 */
export function warrantyStatus(
  expiresOn: string | null,
  isLifetime: boolean,
  today: string,
  windowDays: number = WARRANTY_EXPIRING_WINDOW_DAYS,
): WarrantyStatusResult {
  if (isLifetime) return { status: "lifetime", daysLeft: null };
  if (expiresOn === null) {
    // `chk_warranty_expiry` makes this row impossible; answering a status for
    // it would invent one.
    throw new Error("A warranty that is not lifetime must carry expiresOn");
  }
  const daysLeft = daysBetweenYMD(today, expiresOn);
  if (daysLeft < 0) return { status: "expired", daysLeft };
  if (daysLeft <= windowDays) return { status: "expiring", daysLeft };
  return { status: "active", daysLeft };
}

/**
 * The rows `warrantyStatus` answers `status` for, as bounds a query can apply
 * to the stored columns, so a status filter runs in SQL and pagination counts
 * the rows the page shows. `expiresFrom` and `expiresTo` are inclusive and
 * `null` means unbounded. Derived from the same thresholds as `warrantyStatus`
 * and held to it by `warranty-status.util.spec.ts`, which checks every day
 * either side of each boundary against both.
 */
export interface WarrantyStatusBounds {
  isLifetime: boolean;
  expiresFrom: string | null;
  expiresTo: string | null;
}

export function warrantyStatusBounds(
  status: WarrantyStatus,
  today: string,
  windowDays: number = WARRANTY_EXPIRING_WINDOW_DAYS,
): WarrantyStatusBounds {
  switch (status) {
    case "lifetime":
      return { isLifetime: true, expiresFrom: null, expiresTo: null };
    case "expired":
      return {
        isLifetime: false,
        expiresFrom: null,
        expiresTo: addDaysYMD(today, -1),
      };
    case "expiring":
      return {
        isLifetime: false,
        expiresFrom: today,
        expiresTo: addDaysYMD(today, windowDays),
      };
    case "active":
      return {
        isLifetime: false,
        expiresFrom: addDaysYMD(today, windowDays + 1),
        expiresTo: null,
      };
  }
}
