import { addDaysYMD } from "../common/date-utils";

/**
 * A warranty term as the form's duration helper and the CSV importer's
 * `WarrantyDurationYears` / `Months` / `Days` columns give it. Absent parts
 * are zero.
 */
export interface WarrantyTerm {
  years?: number | null;
  months?: number | null;
  days?: number | null;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function isWholeNonNegative(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * The date a term starting on `purchaseDate` ends (design decision 1): years
 * and months first, clamped to the end of the month when the purchase day
 * does not exist there (18 months from 2026-01-31 is 2027-07-31, one month is
 * 2026-02-28), then days. The only place in the warranties module that adds
 * months to a date; the API and the CSV importer both call it.
 *
 * Refuses a term that is zero in total or has a negative or fractional part:
 * a warranty that ends the day it was bought is not a term anybody sells, and
 * the caller reports the refusal rather than storing it.
 */
export function termToExpiresOn(
  purchaseDate: string,
  term: WarrantyTerm,
): string {
  const years = term.years ?? 0;
  const months = term.months ?? 0;
  const days = term.days ?? 0;
  if (![years, months, days].every(isWholeNonNegative)) {
    throw new RangeError("A warranty term's parts must be whole numbers >= 0");
  }
  if (years + months + days === 0) {
    throw new RangeError("A warranty term must be longer than zero");
  }

  const [y, m, d] = purchaseDate.split("-").map(Number);
  const totalMonths = m - 1 + months + years * 12;
  const year = y + Math.floor(totalMonths / 12);
  const monthIndex = totalMonths % 12;
  const day = Math.min(d, daysInMonth(year, monthIndex));

  const pad = (n: number) => String(n).padStart(2, "0");
  return addDaysYMD(`${year}-${pad(monthIndex + 1)}-${pad(day)}`, days);
}
