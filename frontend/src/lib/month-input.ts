import { isCalendarMonth } from '@/lib/calendar-month';

/**
 * A month typed by hand, read into `YYYY-MM`.
 *
 * The calendar's month picker offers twelve buttons and a year stepper, which
 * is fine for next March and useless for March 1998. Typing is the way to reach
 * a distant month, so this takes what someone would actually type rather than
 * one canonical form: `2026-06`, `06/2026`, `202606`, `Jun 2026`, `June`, `6`,
 * `2026`.
 *
 * Everything is integer arithmetic on strings and a lookup in the CALLER's
 * month labels -- no `Date`, no `Intl`, no browser clock. A reader whose
 * interface is in German types `Mär` and gets March because the labels handed in
 * are the ones their month grid is already drawing.
 *
 * `fallbackMonth` supplies the half a partial entry leaves out: `6` is June of
 * the month on screen's year, `2026` is the month on screen in 2026. It is
 * never the clock's answer, for the reason nothing else in the calendar reads
 * the clock (design I2).
 *
 * Returns `null` for anything it cannot read, which the caller reports at the
 * field. It never guesses: a bare `0612` is four digits and reads as a year,
 * because a year is what four digits mean everywhere else in this function.
 */
export function parseMonthInput(
  text: string,
  monthLabels: readonly string[],
  fallbackMonth: string,
): string | null {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length === 0) return null;

  const [fallbackYear, fallbackMonthNumber] = fallbackMonth.split('-');

  const numeric = parseNumericMonth(cleaned, fallbackYear, fallbackMonthNumber);
  if (numeric !== null) return numeric;

  return parseNamedMonth(cleaned, monthLabels, fallbackYear);
}

/** `YYYY-MM` from a year and a month number, or `null` if either is out of range. */
function toMonth(year: number, month: number): string | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  return isCalendarMonth(candidate) ? candidate : null;
}

/** The all-digits forms, in the order that disambiguates them. */
function parseNumericMonth(
  cleaned: string,
  fallbackYear: string,
  fallbackMonthNumber: string,
): string | null {
  // A four-digit part is the year wherever it sits, which is what separates
  // `06/2026` from `2026/06` without having to know a locale's ordering.
  const yearFirst = cleaned.match(/^(\d{4})\s*[-/. ]\s*(\d{1,2})$/);
  if (yearFirst) return toMonth(Number(yearFirst[1]), Number(yearFirst[2]));

  const monthFirst = cleaned.match(/^(\d{1,2})\s*[-/. ]\s*(\d{4})$/);
  if (monthFirst) return toMonth(Number(monthFirst[2]), Number(monthFirst[1]));

  const packed = cleaned.match(/^(\d{4})(\d{2})$/);
  if (packed) return toMonth(Number(packed[1]), Number(packed[2]));

  const yearOnly = cleaned.match(/^(\d{4})$/);
  if (yearOnly) return toMonth(Number(yearOnly[1]), Number(fallbackMonthNumber));

  const monthOnly = cleaned.match(/^(\d{1,2})$/);
  if (monthOnly) return toMonth(Number(fallbackYear), Number(monthOnly[1]));

  return null;
}

/**
 * A month named in words, with an optional year on either side of it.
 *
 * Matched by prefix against the labels the caller passed, so both the
 * abbreviation the grid draws and the full word someone types resolve: `jun`
 * and `june` both begin with the English label `Jan`..`Dec` entry for June.
 * Ambiguity is refused rather than guessed -- in a locale where two months share
 * a prefix, a reader who typed it gets the field's error and can type one more
 * letter.
 */
function parseNamedMonth(
  cleaned: string,
  monthLabels: readonly string[],
  fallbackYear: string,
): string | null {
  const yearMatch = cleaned.match(/(?:^|[^0-9])(\d{4})(?![0-9])/);
  const year = yearMatch ? Number(yearMatch[1]) : Number(fallbackYear);
  const word = (yearMatch ? cleaned.replace(yearMatch[1], '') : cleaned)
    .replace(/[-/.,]/g, ' ')
    .trim();
  if (word.length === 0) return null;

  const matches: number[] = [];
  for (const [index, label] of monthLabels.entries()) {
    const normalized = label.trim().toLowerCase();
    if (normalized.length === 0) continue;
    // Either direction: the typed word may be longer than the label ("june"
    // against "jun") or shorter than it ("mar" against a locale's "März").
    if (word.startsWith(normalized) || normalized.startsWith(word)) {
      matches.push(index + 1);
    }
  }
  // Two months claiming the same prefix is a question, not an answer.
  if (new Set(matches).size !== 1) return null;

  return toMonth(year, matches[0]);
}
