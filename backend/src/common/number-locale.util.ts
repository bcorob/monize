import { DEFAULT_LOCALE } from "../i18n/config";
import { roundToDecimals } from "./round.util";
import { getDecimalPlacesForCurrency } from "./format-currency.util";

/**
 * Number formatting for content the server composes and addresses to a person:
 * an email, a notification, a generated report note.
 *
 * The counterpart of `frontend/src/hooks/useNumberFormat.ts`. Both answer the
 * same question -- which locale renders this figure's separators, grouping and
 * currency placement -- and both must answer it the same way, or a Polish
 * reader gets `18 812,71 zl` on screen and `zl18,812.71` in the email about it
 * (issue #1316).
 *
 * The deterministic `en-US` helpers in `format-currency.util.ts` stay where the
 * output is read by a *machine* (an LLM prompt, the English fallback string
 * stored on an action-history row); everything read by a person comes through
 * here.
 */

/**
 * Resolve the effective number locale from a user's stored preferences.
 *
 * Mirrors the frontend's `getEffectiveLocale`, with one deliberate difference:
 * there, an unresolvable preference hands off to the browser by returning
 * `undefined`. The server has no browser, so it lands on {@link DEFAULT_LOCALE}
 * -- the documented deterministic default, not a guess at the reader's machine.
 *
 * - An explicit `numberFormat` (e.g. `pl-PL`, `de-DE`) always wins, so a user
 *   can pick Polish grouping with an English UI.
 * - `numberFormat === 'browser'` falls back to the UI `language`, so a reader
 *   who never touched the setting still gets numbers in their UI's convention.
 * - A `language` of `browser` (follow the browser) or `xx` (the pseudo-locale)
 *   is not a real Intl locale, so those fall through to the default too.
 */
export function resolveNumberLocale(
  numberFormat: string | null | undefined,
  language: string | null | undefined,
): string {
  if (numberFormat && numberFormat !== "browser") {
    return usableLocale(numberFormat);
  }
  if (language && language !== "browser" && language !== "xx") {
    return usableLocale(language);
  }
  return DEFAULT_LOCALE;
}

/**
 * Cache of "can `Intl` build a formatter for this tag", so the probe below runs
 * once per distinct stored value rather than once per figure.
 */
const localeUsable = new Map<string, boolean>();

/**
 * The locale itself, or {@link DEFAULT_LOCALE} when `Intl` cannot use it.
 *
 * `Intl.NumberFormat` throws `RangeError` on a STRUCTURALLY invalid tag -- and
 * `en_US`, the underscore form half the world writes, is one. Nothing validates
 * `numberFormat` on the way in (the DTO checks `@IsString()` and a length), so
 * one such value used to reach every formatter here at once: the Monthly
 * Comparison report answered 500, and because the throw happened inside the cron
 * that composes them, that user's bill reminders and budget alerts stopped
 * arriving with no message anywhere saying why.
 *
 * Note the failure this must NOT have: catching the throw at the call site and
 * falling back to another formatter *built from the same locale* -- which is
 * what the first version of `formatCurrency` did, so its catch threw too. The
 * check belongs here, once, before any formatter is built.
 *
 * A tag that is well-formed but unknown (`zzz`) does not throw; `Intl` resolves
 * it to its own default. That is not this function's problem to solve -- it is a
 * locale the reader asked for and the platform could not honour.
 */
function usableLocale(locale: string): string {
  const cached = localeUsable.get(locale);
  if (cached !== undefined) return cached ? locale : DEFAULT_LOCALE;
  let usable = true;
  try {
    new Intl.NumberFormat(locale);
  } catch {
    usable = false;
  }
  localeUsable.set(locale, usable);
  return usable ? locale : DEFAULT_LOCALE;
}

/**
 * The formatters a template or a message builder needs. Structurally the subset
 * of the frontend hook's return value that server-composed copy uses, so the
 * two layers stay comparable line for line.
 */
export interface NumberT {
  /** The locale these formatters resolved to; exposed so callers can log or assert it. */
  readonly locale: string;
  /** Money with its symbol, at the currency's own decimal places (JPY 0, USD 2, BHD 3). */
  formatCurrency(amount: number, currencyCode: string): string;
  /** Money without a symbol, for a caller that shows the code separately. */
  formatCurrencyAmount(amount: number, currencyCode: string): string;
  /** A plain number (a count, a ratio) at a fixed number of decimals. */
  formatNumber(value: number, decimals?: number): string;
  /** A percentage in percentage units (12.3 -> "12.3%" / "12,3%"). */
  formatPercent(value: number, decimals?: number): string;
  /**
   * A percentage that keeps the precision the value already carries (0 to
   * `maxDecimals`, trailing zeros trimmed). The counterpart of the client's
   * `formatPercentTrimmed`: for a figure that arrives already rounded, pinning a
   * decimal count would change what the reader sees, and a localization fix must
   * not change the figure.
   */
  formatPercentTrimmed(value: number, maxDecimals?: number): string;
}

/**
 * Cache of `Intl.NumberFormat` instances, keyed by locale plus options. A digest
 * email renders one formatter per money cell otherwise, and a cron fan-out
 * multiplies that by the user count. The keyspace stays small in practice (a
 * handful of locale/currency/option combinations).
 */
const formatterCache = new Map<string, Intl.NumberFormat>();

function intl(
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/**
 * Build a {@link NumberT} for an already-resolved locale.
 *
 * Deliberately closures rather than object methods: a caller that destructures
 * (`const { formatCurrency } = n`) would lose a `this` binding, and the failure
 * would be a runtime crash in a cron-composed email nobody is watching.
 */
export function numberFormatterForLocale(rawLocale: string): NumberT {
  // Exported, so a caller can reach it with a tag that never went through
  // `resolveNumberLocale`. Probe here too: every formatter below is built from
  // this one value, so an unusable tag would take all of them down together.
  const locale = usableLocale(rawLocale);
  const formatNumber = (value: number, decimals = 2): string =>
    intl(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);

  const formatCurrency = (amount: number, currencyCode: string): string => {
    try {
      const formatter = intl(locale, {
        style: "currency",
        currency: currencyCode,
        currencyDisplay: "narrowSymbol",
      });
      // Pre-round to the currency's own precision so an IEEE 754 midpoint
      // (159.735 held as 159.73499...) rounds the way money does.
      const decimals = formatter.resolvedOptions().minimumFractionDigits ?? 2;
      return formatter.format(roundToDecimals(amount, decimals));
    } catch {
      // An unknown currency code costs the symbol, never the reader's locale:
      // falling back to en-US here would be the defect wearing a catch block.
      return formatNumber(amount, 2);
    }
  };

  return {
    locale,
    formatCurrency,
    formatNumber,
    formatCurrencyAmount(amount: number, currencyCode: string): string {
      const decimals = getDecimalPlacesForCurrency(currencyCode);
      return formatNumber(roundToDecimals(amount, decimals), decimals);
    },
    formatPercent(value: number, decimals = 2): string {
      // Intl's percent style takes a fraction; the call sites work in
      // percentage units, as the frontend hook's `formatPercent` does.
      return intl(locale, {
        style: "percent",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value / 100);
    },
    formatPercentTrimmed(value: number, maxDecimals = 4): string {
      return intl(locale, {
        style: "percent",
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDecimals,
      }).format(value / 100);
    },
  };
}

/**
 * Build a {@link NumberT} from a recipient's stored preferences. Pass the
 * `user_preferences` row's `numberFormat` and `language`; a missing row (a user
 * who has never opened Settings) lands on the default locale.
 */
export function numberFormatterFor(
  numberFormat: string | null | undefined,
  language: string | null | undefined,
): NumberT {
  return numberFormatterForLocale(resolveNumberLocale(numberFormat, language));
}

/**
 * The default-locale formatter, for a template rendered without a recipient
 * (a unit test, or a caller with no preferences to hand). Deliberately built
 * from {@link DEFAULT_LOCALE} rather than hardcoding `en-US`, so it tracks the
 * documented default if that ever moves.
 */
export const defaultNumberT: NumberT = numberFormatterForLocale(DEFAULT_LOCALE);
