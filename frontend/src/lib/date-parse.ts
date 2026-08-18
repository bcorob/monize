/**
 * Date patterns and the lenient parser every date field types through.
 *
 * Two things live here, and they belong together because the second cannot be
 * decided without the first:
 *
 *  - A **pattern** is a concrete arrangement of day, month and year with
 *    literal separators: `MM/DD/YYYY`, `DD.MM.YYYY`, `YYYY-MM-DD`,
 *    `DD-MMM-YYYY`. The user's `dateFormat` preference is one of those, or the
 *    sentinel `browser`, which `resolveDateFormatPattern` turns into a real
 *    pattern by asking `Intl` what the locale does. Nothing downstream should
 *    have to branch on `browser` again.
 *
 *  - `parseFlexibleDate` reads what a person actually typed -- `9-14`, `9/14`,
 *    `14 sep`, `091426`, `2026-09-14` -- and returns `YYYY-MM-DD`. What is
 *    missing is filled in from a reference date (today, or the value the field
 *    already holds), and what is ambiguous is resolved **by the pattern**: in
 *    `MM/DD/YYYY` the input `7/8` is 8 July, in `DD/MM/YYYY` it is 7 August.
 *    That is the whole reason the parser takes a pattern rather than guessing.
 *
 * The strict parser (`parseDateFromFormat` in `lib/utils.ts`) is still the one
 * to use where a value must already be canonical -- it delegates its pattern
 * work here so the two cannot disagree about what a pattern means.
 */

export type DateFieldType = 'year' | 'month' | 'day';

export interface DatePatternToken {
  type: DateFieldType | 'literal';
  /** The pattern text this token was cut from, e.g. `YYYY`, `MMM` or `/`. */
  text: string;
}

/** English month abbreviations, in the order `MMM` renders and parses them. */
export const MONTH_ABBREVS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
] as const;

const MONTH_FULL_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

/**
 * The pattern used when a locale cannot be read. ISO is the one arrangement
 * that is never ambiguous, so a failure to resolve degrades to unambiguous
 * rather than to a guess about which of day and month comes first.
 */
export const FALLBACK_DATE_PATTERN = 'YYYY-MM-DD';

/** The separators a user may type between the parts of a date. */
export const TYPEABLE_DATE_SEPARATORS = new Set([' ', '/', '-', '.', ',']);

/** Cut a pattern into its field and literal tokens. */
export function tokenizeDatePattern(pattern: string): DatePatternToken[] {
  const tokens: DatePatternToken[] = [];
  let literal = '';
  const flushLiteral = () => {
    if (literal) {
      tokens.push({ type: 'literal', text: literal });
      literal = '';
    }
  };

  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('YYYY', i)) {
      flushLiteral();
      tokens.push({ type: 'year', text: 'YYYY' });
      i += 4;
    } else if (pattern.startsWith('MMM', i)) {
      flushLiteral();
      tokens.push({ type: 'month', text: 'MMM' });
      i += 3;
    } else if (pattern.startsWith('MM', i)) {
      flushLiteral();
      tokens.push({ type: 'month', text: 'MM' });
      i += 2;
    } else if (pattern.startsWith('DD', i)) {
      flushLiteral();
      tokens.push({ type: 'day', text: 'DD' });
      i += 2;
    } else {
      literal += pattern[i];
      i += 1;
    }
  }
  flushLiteral();
  return tokens;
}

/**
 * The order day, month and year appear in a pattern. This is what decides
 * whether `7/8` is 8 July or 7 August, so it is read from the pattern rather
 * than assumed anywhere.
 */
export function datePatternFieldOrder(pattern: string): DateFieldType[] {
  return tokenizeDatePattern(pattern)
    .filter((token): token is DatePatternToken & { type: DateFieldType } =>
      token.type !== 'literal')
    .map((token) => token.type);
}

/** Every literal character a pattern contains, e.g. `.` for `DD.MM.YYYY`. */
export function datePatternLiteralChars(pattern: string): Set<string> {
  const chars = new Set<string>();
  for (const token of tokenizeDatePattern(pattern)) {
    if (token.type !== 'literal') continue;
    for (const ch of token.text) chars.add(ch);
  }
  return chars;
}

/** True when a pattern names its month with a name (`MMM`) rather than digits. */
export function datePatternUsesMonthName(pattern: string): boolean {
  return tokenizeDatePattern(pattern).some((t) => t.text === 'MMM');
}

/** Render a calendar date through a pattern. */
export function formatByPattern(
  year: number,
  month: number,
  day: number,
  pattern: string,
): string {
  return tokenizeDatePattern(pattern)
    .map((token) => {
      switch (token.text) {
        case 'YYYY':
          return String(year).padStart(4, '0');
        case 'MMM': {
          const abbrev = MONTH_ABBREVS[month - 1] ?? '';
          return abbrev ? abbrev[0].toUpperCase() + abbrev.slice(1) : '';
        }
        case 'MM':
          return String(month).padStart(2, '0');
        case 'DD':
          return String(day).padStart(2, '0');
        default:
          return token.text;
      }
    })
    .join('');
}

/**
 * Build a `YYYY-MM-DD` string, or null when the parts do not name a real day.
 * February 30 is rejected here rather than silently rolling into March.
 */
export function buildValidatedIsoDate(
  year: number,
  month: number,
  day: number,
): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (year < 1 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Turn the user's `dateFormat` preference into a concrete pattern.
 *
 * `browser` is not a pattern -- it means "whatever this locale does" -- and
 * every consumer that has to parse typed input needs the arrangement spelled
 * out. `Intl` knows it, so ask rather than keep a table of locales here.
 */
export function resolveDateFormatPattern(dateFormat: string, locale?: string): string {
  if (dateFormat && dateFormat !== 'browser') return dateFormat;

  try {
    const parts = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(2026, 8, 14));

    let pattern = '';
    for (const part of parts) {
      if (part.type === 'year') pattern += 'YYYY';
      else if (part.type === 'month') pattern += 'MM';
      else if (part.type === 'day') pattern += 'DD';
      else if (part.type === 'literal') pattern += part.value;
    }

    // Directional marks (ar, fa) are invisible and would be typed by nobody;
    // a trailing separator (ko renders "2026. 09. 14.") is not part of what
    // the user has to enter either.
    pattern = pattern.replace(/[‎‏؜]/g, '').trim();
    pattern = pattern.replace(/^[^YMD]+/, '').replace(/[^YMD]+$/, '');

    const order = datePatternFieldOrder(pattern);
    const complete = (['year', 'month', 'day'] as const).every((field) =>
      order.filter((f) => f === field).length === 1);
    return complete ? pattern : FALLBACK_DATE_PATTERN;
  } catch {
    return FALLBACK_DATE_PATTERN;
  }
}

/** Index of a month named in English, full or abbreviated. 1-based; 0 = no match. */
function monthFromName(token: string): number {
  const lower = token.toLowerCase();
  const abbrev = MONTH_ABBREVS.indexOf(lower.slice(0, 3) as typeof MONTH_ABBREVS[number]);
  if (abbrev === -1) return 0;
  // Accept an abbreviation or the full name, but not a word that merely starts
  // with three matching letters ("marketing" is not March).
  if (lower.length === 3 || lower === MONTH_FULL_NAMES[abbrev]) return abbrev + 1;
  return 0;
}

/**
 * Expand a 1- or 2-digit year against a reference year, in a window that runs
 * from 80 years back to 20 years forward. A finance app holds far more past
 * dates than future ones, so `50` typed in 2026 is 1950, not 2050 -- but a
 * scheduled transaction a decade out still resolves forward.
 */
export function expandTwoDigitYear(value: number, referenceYear: number): number {
  const century = Math.floor(referenceYear / 100) * 100;
  let candidate = century + value;
  // The window is what decides, not the reference's own century: in 1990 the
  // year "05" is 2005, and anchoring to the century would make it 1905.
  if (candidate > referenceYear + 20) candidate -= 100;
  else if (candidate < referenceYear - 79) candidate += 100;
  return candidate;
}

interface DayMonth {
  day: number;
  month: number;
}

/**
 * Assign two numbers to day and month in the pattern's order, swapping only
 * when the ordered reading names no real date and the swapped one does.
 *
 * The swap never touches an ambiguous input: `7/8` is valid both ways, so it
 * keeps the pattern's answer. It rescues `14/9` typed into `MM/DD/YYYY`, where
 * there is exactly one thing the user can have meant.
 */
function assignDayMonth(
  first: number,
  second: number,
  year: number,
  dayFirst: boolean,
): DayMonth | null {
  const ordered: DayMonth = dayFirst
    ? { day: first, month: second }
    : { month: first, day: second };
  if (buildValidatedIsoDate(year, ordered.month, ordered.day)) return ordered;

  const swapped: DayMonth = dayFirst
    ? { month: first, day: second }
    : { day: first, month: second };
  if (buildValidatedIsoDate(year, swapped.month, swapped.day)) return swapped;

  return null;
}

/** Split a run of digits into the pattern's fields, e.g. `09142026` in MM/DD/YYYY. */
function parseCompactDigits(
  digits: string,
  pattern: string,
  referenceDate: Date,
): string | null {
  const order = datePatternFieldOrder(pattern);
  const yearWidth = digits.length === 8 ? 4 : digits.length === 6 ? 2 : 0;
  if (yearWidth === 0) return null;

  const parts: Partial<Record<DateFieldType, number>> = {};
  let cursor = 0;
  for (const field of order) {
    const width = field === 'year' ? yearWidth : 2;
    parts[field] = Number(digits.slice(cursor, cursor + width));
    cursor += width;
  }

  const year = yearWidth === 2
    ? expandTwoDigitYear(parts.year ?? 0, referenceDate.getFullYear())
    : parts.year ?? 0;
  return buildValidatedIsoDate(year, parts.month ?? 0, parts.day ?? 0);
}

/** Split a 3- or 4-digit run into day and month, e.g. `914` or `0914`. */
function parseCompactDayMonth(
  digits: string,
  pattern: string,
  referenceDate: Date,
): string | null {
  const order = datePatternFieldOrder(pattern);
  const dayFirst = order.indexOf('day') < order.indexOf('month');
  const year = referenceDate.getFullYear();

  // Try every split of the run into two non-empty halves of at most two digits,
  // widest-first so "0914" reads as 09/14 rather than 0/914.
  const splits = digits.length === 4 ? [2] : [1, 2];
  for (const at of splits) {
    const first = Number(digits.slice(0, at));
    const second = Number(digits.slice(at));
    if (digits.length - at > 2) continue;
    const assigned = assignDayMonth(first, second, year, dayFirst);
    if (assigned) return buildValidatedIsoDate(year, assigned.month, assigned.day);
  }
  return null;
}

/**
 * Read a date the way a person types one, and return it as `YYYY-MM-DD`.
 *
 * Accepts the canonical form, an ISO date whatever the pattern is (a 4-digit
 * run is a year wherever it appears), short years (`4/1/26`), month names
 * (`14 sep`, `Sep 14 2026`), compact digits (`091426`), any of
 * `TYPEABLE_DATE_SEPARATORS` between the parts, and partial input -- a missing
 * year comes from `referenceDate`, and a lone day keeps that date's month.
 *
 * Returns null when the input does not name a real day. A caller showing a
 * field must treat that as "leave what was there", never as "clear it": an
 * unreadable entry is not the user asking for no date.
 */
export function parseFlexibleDate(
  input: string,
  pattern: string,
  referenceDate: Date = new Date(),
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const tokens = trimmed.match(/\p{L}+|\d+/gu);
  if (!tokens || tokens.length === 0) return null;
  // Anything that is neither a letter run, a digit run nor a separator is not
  // part of a date -- reject rather than quietly ignoring it.
  const leftovers = trimmed.replace(/\p{L}+|\d+/gu, '');
  for (const ch of leftovers) {
    if (!TYPEABLE_DATE_SEPARATORS.has(ch) && !datePatternLiteralChars(pattern).has(ch)) {
      return null;
    }
  }

  const order = datePatternFieldOrder(pattern);
  const dayFirst = order.indexOf('day') < order.indexOf('month');
  const yearBeforeDay = order.indexOf('year') < order.indexOf('day');
  const referenceYear = referenceDate.getFullYear();

  const nameTokens = tokens.filter((t) => /\p{L}/u.test(t));
  const numberTokens = tokens.filter((t) => /^\d+$/.test(t));

  // --- A month name pins the month; the numbers are day and year ---
  if (nameTokens.length > 0) {
    if (nameTokens.length > 1) return null;
    const month = monthFromName(nameTokens[0]);
    if (month === 0) return null;

    if (numberTokens.length === 0 || numberTokens.length > 2) return null;
    if (numberTokens.length === 1) {
      return buildValidatedIsoDate(referenceYear, month, Number(numberTokens[0]));
    }

    const fourDigit = numberTokens.findIndex((t) => t.length === 4);
    let yearToken: string;
    let dayToken: string;
    if (fourDigit !== -1) {
      yearToken = numberTokens[fourDigit];
      dayToken = numberTokens[fourDigit === 0 ? 1 : 0];
    } else if (yearBeforeDay) {
      [yearToken, dayToken] = numberTokens;
    } else {
      [dayToken, yearToken] = numberTokens;
    }
    const year = resolveYearToken(yearToken, referenceYear);
    if (year === null) return null;
    return buildValidatedIsoDate(year, month, Number(dayToken));
  }

  // --- Digits only ---
  if (numberTokens.length > 3) return null;

  if (numberTokens.length === 1) {
    const digits = numberTokens[0];
    if (digits.length <= 2) {
      // A lone number is a day in the month the field is already showing.
      return buildValidatedIsoDate(
        referenceYear,
        referenceDate.getMonth() + 1,
        Number(digits),
      );
    }
    if (digits.length === 3 || digits.length === 4) {
      return parseCompactDayMonth(digits, pattern, referenceDate);
    }
    if (digits.length === 6 || digits.length === 8) {
      return parseCompactDigits(digits, pattern, referenceDate);
    }
    return null;
  }

  if (numberTokens.length === 2) {
    // Two numbers are a day and a month: the year is the one thing a person
    // leaves out. A pair carrying a 4-digit year instead names a month and a
    // year with no day, and inventing the first of the month from that is a
    // guess about the value, not about the format.
    if (numberTokens.some((t) => t.length > 2)) return null;
    const assigned = assignDayMonth(
      Number(numberTokens[0]),
      Number(numberTokens[1]),
      referenceYear,
      dayFirst,
    );
    if (!assigned) return null;
    return buildValidatedIsoDate(referenceYear, assigned.month, assigned.day);
  }

  // Three numbers: the pattern says which is which, except that a 4-digit run
  // is a year wherever it sits -- that is what makes an ISO date readable in
  // every pattern, and it is never ambiguous.
  const fourDigitIndex = numberTokens.findIndex((t) => t.length === 4);
  const yearIndex = fourDigitIndex !== -1 ? fourDigitIndex : order.indexOf('year');
  const year = resolveYearToken(numberTokens[yearIndex], referenceYear);
  if (year === null) return null;

  const rest = numberTokens.filter((_, i) => i !== yearIndex);
  const assigned = assignDayMonth(Number(rest[0]), Number(rest[1]), year, dayFirst);
  if (!assigned) return null;
  return buildValidatedIsoDate(year, assigned.month, assigned.day);
}

/**
 * A year token as a full year. One and two digits expand; four are taken as
 * written. Three digits are rejected: `202` is a year that has been typed half
 * way, and reading it as the year 202 stores something nobody meant.
 */
function resolveYearToken(token: string, referenceYear: number): number | null {
  if (token.length === 4) return Number(token);
  if (token.length <= 2) return expandTwoDigitYear(Number(token), referenceYear);
  return null;
}

/**
 * Strict parse: the input must be the pattern, with the pattern's own
 * separators. Day and month may be unpadded (`1/2/2026`), the year may not --
 * a half-typed `202` is not the year 202.
 *
 * This is what a value already believed to be canonical is read with. Use
 * `parseFlexibleDate` for anything a person is still typing.
 */
export function parseByPattern(input: string, pattern: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let source = '^';
  const fields: DateFieldType[] = [];
  let monthIsName = false;
  for (const token of tokenizeDatePattern(pattern)) {
    switch (token.text) {
      case 'YYYY':
        source += '(\\d{4})';
        fields.push('year');
        break;
      case 'MMM':
        source += '([A-Za-z]{3})';
        fields.push('month');
        monthIsName = true;
        break;
      case 'MM':
        source += '(\\d{1,2})';
        fields.push('month');
        break;
      case 'DD':
        source += '(\\d{1,2})';
        fields.push('day');
        break;
      default:
        source += token.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  source += '$';

  const match = new RegExp(source, 'i').exec(trimmed);
  if (!match) return null;

  const parts: Partial<Record<DateFieldType, number>> = {};
  fields.forEach((field, i) => {
    const raw = match[i + 1];
    if (field === 'month' && monthIsName) {
      parts.month = MONTH_ABBREVS.indexOf(
        raw.toLowerCase() as typeof MONTH_ABBREVS[number],
      ) + 1;
      return;
    }
    parts[field] = Number(raw);
  });

  return buildValidatedIsoDate(parts.year ?? 0, parts.month ?? 0, parts.day ?? 0);
}
