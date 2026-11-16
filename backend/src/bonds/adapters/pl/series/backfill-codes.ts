import { enumerateMonthKeys } from "../../../domain/calendar-date";
import { seriesCodeFor } from "./series-code";
import { SERIES_TEMPLATES } from "./templates";

/** The earliest sale month any product's template is validated for. */
export const SERIES_VALID_FROM = Object.values(SERIES_TEMPLATES)
  .map((t) => t.validFrom)
  .sort()[0];

/**
 * Every series code of every product from its template's `validFrom` to the
 * month of `today`: one code per product and sale month, oldest month first and
 * the products in template order within a month. Pure.
 */
export function backfillCodes(today: string): string[] {
  const last = today.slice(0, 7);
  const templates = Object.values(SERIES_TEMPLATES);
  const byMonth = new Map<string, string[]>();
  for (const template of templates) {
    for (const month of enumerateMonthKeys(template.validFrom, last)) {
      const codes = byMonth.get(month) ?? [];
      codes.push(seriesCodeFor(template.product, month));
      byMonth.set(month, codes);
    }
  }
  return [...byMonth.keys()].sort().flatMap((month) => byMonth.get(month)!);
}
