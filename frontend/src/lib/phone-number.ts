import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumber,
} from 'libphonenumber-js/max';

/**
 * The browser's half of one phone-number rule, shared with the server.
 *
 * A payee phone is stored as E.164 with an RFC 3966 extension suffix
 * (`+12064488762`, `+442079460958;ext=12`) and shown as INTERNATIONAL with a
 * uniform ` x` extension (`+44 20 7946 0958 x12`). This file exists so the form
 * can say no before the request goes out; `backend/src/common/phone-number.util.ts`
 * is the authority, and `phone-number-cases.json` beside it is the truth table
 * both layers assert, so the two can never disagree about which numbers are
 * accepted or how one is written. A rule enforced only here would be a field
 * that blocks what the API accepts, or waves through what it refuses.
 *
 * `max` metadata rather than `min` for that reason: `min` reduces `isValid()`
 * to a length check, which is not the same question the server answers.
 */

/** What `normalizePhoneNumber` decided about one input. */
export type PhoneNormalization =
  | { ok: true; stored: string; display: string }
  | { ok: false; reason: PhoneRejection };

/**
 * Why a number was refused. Two reasons because they have different repairs:
 * `needs-country-code` is a number we could not place, and telling the user it
 * is "invalid" sends them to check digits that are perfectly correct.
 */
export type PhoneRejection = 'invalid' | 'needs-country-code';

/** The column defaults, so an unsaved preference reads as a saved one would. */
const DEFAULT_NUMBER_FORMAT = 'en-US';
const DEFAULT_LANGUAGE = 'en';

/** The literal `numberFormat` value meaning "ask the browser". */
const BROWSER_SENTINEL = 'browser';

/**
 * The region a bare national number is read in, from preferences the user has
 * already set: the number format first (a BCP 47 tag chosen for exactly this
 * kind of regional formatting), then the language. `null` means we cannot place
 * one, never a guessed region -- filing a UK number as North American would
 * store a plausible wrong number.
 */
export function phoneRegionFromPreferences(
  prefs: { numberFormat?: string | null; language?: string | null } | null | undefined,
): CountryCode | null {
  const candidates = [
    prefs?.numberFormat || DEFAULT_NUMBER_FORMAT,
    prefs?.language || DEFAULT_LANGUAGE,
  ];
  for (const tag of candidates) {
    const region = regionOfLocale(tag);
    if (region) return region;
  }
  return null;
}

/**
 * The ISO 3166 region of a BCP 47 tag, or null when it names none.
 *
 * A stored preference is not a value this function may reject over, so anything
 * naming no region -- `browser`, the `xx` pseudo-locale, a bare `en`, a tag
 * `Intl.Locale` refuses outright -- falls through to the next candidate.
 */
function regionOfLocale(tag: string): CountryCode | null {
  if (!tag || tag === BROWSER_SENTINEL) return null;
  let region: string | undefined;
  try {
    region = new Intl.Locale(tag).region;
  } catch {
    return null;
  }
  if (!region) return null;
  return isSupportedCountry(region) ? (region as CountryCode) : null;
}

/**
 * Read one number in `region` and answer with both forms, or with why it was
 * refused. The parser understands `ext.`, ` x` and `;ext=`, so an extension
 * survives however it was written.
 */
export function normalizePhoneNumber(
  input: string,
  region: CountryCode | null,
): PhoneNormalization {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };

  const parsed = parsePhoneNumberFromString(trimmed, region ?? undefined);
  if (!parsed || !parsed.isValid()) {
    const unplaceable = region === null && !trimmed.startsWith('+');
    return { ok: false, reason: unplaceable ? 'needs-country-code' : 'invalid' };
  }
  return { ok: true, stored: storedForm(parsed), display: displayForm(parsed) };
}

/**
 * How a stored number is shown to a person. Total by construction: rows written
 * before this rule are not backfilled, so a value that does not parse is
 * returned exactly as it is rather than blanked -- a stored "call the shop" is
 * worth showing even though it cannot be dialled.
 */
export function formatPhoneForDisplay(stored: string | null | undefined): string {
  if (!stored) return '';
  const parsed = parsePhoneNumberFromString(stored);
  if (!parsed || !parsed.isValid()) return stored;
  return displayForm(parsed);
}

/**
 * `+442079460958;ext=12`. The extension is deliberately not part of E.164, so
 * the RFC 3966 suffix is appended here and read back by the parser.
 */
function storedForm(parsed: PhoneNumber): string {
  return parsed.ext ? `${parsed.number};ext=${parsed.ext}` : parsed.number;
}

/**
 * `+44 20 7946 0958 x12`. The separator is fixed at ` x` rather than left to
 * `formatInternational()`, which spells it per country (` ext. ` in most, ` x`
 * in GB): one prefix means an extension is recognisable at a glance on a list
 * mixing countries. Without an extension this is `formatInternational()`.
 */
function displayForm(parsed: PhoneNumber): string {
  return parsed.format('INTERNATIONAL', {
    formatExtension: (number, ext) => `${number} x${ext}`,
  });
}
