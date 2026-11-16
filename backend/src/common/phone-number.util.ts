import { BadRequestException } from "@nestjs/common";
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumber,
} from "libphonenumber-js/max";
import { DataSource } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withScopedDb } from "./db/scoped-db";
import { tr } from "../i18n/translate";

/**
 * One canonical shape for every phone number this application stores.
 *
 * A payee phone used to be kept exactly as typed, so the same business could be
 * recorded as "(206) 448-8762", "206.448.8762" and "+1 206 448 8762" by the
 * three doors that write one (the payee form, the AI/MCP `manage_payees` tools,
 * and the AI contact lookup). Nothing could compare two of them, and the value
 * a `tel:` link dialled depended on which door had written it.
 *
 * Stored form is E.164 with the RFC 3966 extension suffix -- `+12064488762`,
 * `+442079460958;ext=12` -- because that is the one writing of a number that is
 * the same in every country and carries the extension without inventing a
 * separator. Display is libphonenumber's INTERNATIONAL grouping with the
 * extension as ` x12`, which is what a reader recognises.
 *
 * The `max` metadata tier is deliberate on both layers: `min` reduces
 * `isValid()` to a length check, so the browser would accept numbers the server
 * then also had to accept, and "consistent" would mean nothing. The cost is
 * that fictional ranges (North American `555`) are correctly invalid.
 */

/** What `normalizePhoneNumber` decided about one input. */
export type PhoneNormalization =
  | { ok: true; stored: string; display: string }
  | { ok: false; reason: PhoneRejection };

/**
 * Why a number was refused. Two reasons rather than one because they have
 * different repairs: `needs-country-code` is a number we could not place (the
 * user has stated no region and wrote no `+`), and telling them it is "invalid"
 * would send them to check digits that are perfectly correct.
 */
export type PhoneRejection = "invalid" | "needs-country-code";

/**
 * The region a bare national number is read in, derived from what the user has
 * already told us rather than from a new preference.
 *
 * `number_format` first: it is a BCP 47 tag chosen for exactly this kind of
 * regional formatting, and its column default is `en-US`. It can hold the
 * literal `browser`, which names no region, so `language` answers next
 * (`pt-BR` -> BR; a bare `en` carries no region and yields null). A row that
 * does not exist reads as the column defaults, so a user resolves the same
 * region before and after their preferences are first saved -- the same rule
 * `preferredCurrency` follows for the reporting currency.
 *
 * `null` means "we cannot place a bare number", never a guessed region: filing
 * a UK number as North American would store a plausible wrong number.
 */
export function phoneRegionFromPreferences(
  prefs:
    | { numberFormat?: string | null; language?: string | null }
    | null
    | undefined,
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
 * The column defaults, so a missing preferences row and a saved-but-untouched
 * one resolve the same region. `user_preferences.number_format` defaults to
 * `en-US` and `language` to `en`.
 */
const DEFAULT_NUMBER_FORMAT = "en-US";
const DEFAULT_LANGUAGE = "en";

/** The literal `number_format`/`timezone` value meaning "ask the browser". */
const BROWSER_SENTINEL = "browser";

/**
 * The ISO 3166 region of a BCP 47 tag, or null when it names none.
 *
 * A stored preference is not a value this function may reject a request over,
 * so anything that names no region -- `browser`, the `xx` pseudo-locale, a
 * bare `en`, a tag `Intl.Locale` refuses outright -- simply falls through to
 * the next candidate. (`Intl.Locale` throws only on a syntactically invalid
 * tag; `browser` parses and reports no region, so both paths are needed.)
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
  // `isSupportedCountry` is the authority rather than the two-letter shape:
  // libphonenumber has no metadata for every region subtag Intl will parse.
  return isSupportedCountry(region) ? (region as CountryCode) : null;
}

/**
 * Read one number in `region` and answer with both forms, or with why it was
 * refused.
 *
 * The parser already understands `ext.`, ` x` and `;ext=`, so an extension
 * survives however the user wrote it. A number carrying its own `+` needs no
 * region at all, which is why a null region is only fatal for a bare national
 * number.
 */
export function normalizePhoneNumber(
  input: string,
  region: CountryCode | null,
): PhoneNormalization {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "invalid" };

  const parsed = parsePhoneNumberFromString(trimmed, region ?? undefined);
  if (!parsed || !parsed.isValid()) {
    // A number with no international prefix, in a session that names no
    // region, is unplaceable rather than wrong -- say so, so the fix the user
    // is asked for is the one that works.
    const unplaceable = region === null && !trimmed.startsWith("+");
    return {
      ok: false,
      reason: unplaceable ? "needs-country-code" : "invalid",
    };
  }

  return {
    ok: true,
    stored: storedForm(parsed),
    display: displayForm(parsed),
  };
}

/**
 * How a stored number is shown to a person. Total by construction: existing
 * rows were written before this rule and are NOT backfilled, so a value that
 * does not parse is returned exactly as it is rather than blanked -- a stored
 * "call the shop" is worth showing even though it cannot be dialled, and the
 * same is true of a number in some shape this build cannot read.
 */
export function formatPhoneForDisplay(
  stored: string | null | undefined,
): string {
  if (!stored) return "";
  const parsed = parsePhoneNumberFromString(stored);
  if (!parsed || !parsed.isValid()) return stored;
  return displayForm(parsed);
}

/**
 * `+442079460958;ext=12`. `PhoneNumber.number` is the E.164 alone -- the
 * extension is deliberately not part of E.164 -- so the RFC 3966 suffix is
 * appended here, and `parsePhoneNumberFromString` reads it back.
 */
function storedForm(parsed: PhoneNumber): string {
  return parsed.ext ? `${parsed.number};ext=${parsed.ext}` : parsed.number;
}

/**
 * `+44 20 7946 0958 x12`. The extension separator is fixed at ` x` rather than
 * left to `formatInternational()`, which spells it per country (` ext. ` in
 * most, ` x` in GB): one prefix means an extension is recognisable at a glance
 * on a payee list mixing countries, and it is what a number in this
 * application is specified to look like. Without an extension this is exactly
 * `formatInternational()`.
 */
function displayForm(parsed: PhoneNumber): string {
  return parsed.format("INTERNATIONAL", {
    formatExtension: (number, ext) => `${number} x${ext}`,
  });
}

/**
 * The caller's region, read for its own sake. Where a caller already holds the
 * preference row, call `phoneRegionFromPreferences(prefs)` rather than issuing
 * a second query.
 */
export async function resolveUserPhoneRegion(
  dataSource: DataSource,
  userId: string,
): Promise<CountryCode | null> {
  const prefs = await withScopedDb(dataSource, (m) =>
    m.getRepository(UserPreference).findOne({
      where: { userId },
      select: { userId: true, numberFormat: true, language: true },
    }),
  );
  return phoneRegionFromPreferences(prefs);
}

/**
 * Normalize a number a request supplied, or refuse the request.
 *
 * The message is chosen by the rejection reason so the reader is sent to the
 * repair that applies, and it names the value: a wrongly refused real number is
 * this feature's failure mode, and an error that does not quote what was typed
 * makes it unreportable.
 */
export function normalizePhoneOrThrow(
  input: string,
  region: CountryCode | null,
): string {
  const result = normalizePhoneNumber(input, region);
  if (result.ok) return result.stored;
  if (result.reason === "needs-country-code") {
    throw new BadRequestException(
      tr(
        "errors.payees.phoneNeedsCountryCode",
        `Include the country code for "${input}", for example +1 206 448 8762`,
        { phone: input },
      ),
    );
  }
  throw new BadRequestException(
    tr("errors.payees.invalidPhone", `"${input}" is not a valid phone number`, {
      phone: input,
    }),
  );
}
