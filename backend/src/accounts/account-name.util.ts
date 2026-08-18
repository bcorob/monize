import { escapeRegExp } from "../common/escape-regexp.util";
import { tr } from "../i18n/translate";
import { AccountSubType } from "./entities/account.entity";

/**
 * Localized suffix words appended to the two halves of a linked investment
 * account pair (e.g. "TFSA - Cash" / "TFSA - Brokerage"). Resolved against the
 * current request locale so generated names read naturally in the user's
 * language; outside an HTTP context they fall back to English.
 */
export function cashSuffix(): string {
  return tr("common.accountSuffix.cash", "Cash");
}

export function brokerageSuffix(): string {
  return tr("common.accountSuffix.brokerage", "Brokerage");
}

/**
 * Strip a trailing " - <Brokerage>" suffix from a brokerage account name to
 * recover the main account name. Removes both the current locale's translated
 * word and the English original, so accounts created in any language (or before
 * localization) resolve correctly.
 */
export function stripBrokerageSuffix(name: string): string {
  return stripSuffixes(name, ["Brokerage", brokerageSuffix()]);
}

/**
 * Strip either half's trailing suffix to recover the name the user thinks of
 * the account by, so a client that sends back the stored name rather than the
 * base does not stack a second suffix onto it.
 *
 * Recognises the current request locale's words and the English originals --
 * the same pair the client strips with. A name stored under some *third*
 * locale is not recognised and stays part of the base, which is why the
 * server, not the client, owns suffix generation: the round trip through this
 * function is what keeps the two halves agreeing.
 */
export function stripPairSuffix(name: string): string {
  return stripSuffixes(name, [
    "Brokerage",
    "Cash",
    brokerageSuffix(),
    cashSuffix(),
  ]);
}

/**
 * The stored name for one half of a pair: the shared base plus that half's
 * suffix. The server owns suffix generation, at creation and at rename, so a
 * client only ever sends the base.
 */
export function pairHalfName(
  baseName: string,
  subType: AccountSubType | null,
): string {
  const suffix =
    subType === AccountSubType.INVESTMENT_CASH
      ? cashSuffix()
      : brokerageSuffix();
  return `${baseName} - ${suffix}`;
}

function stripSuffixes(name: string, words: string[]): string {
  const suffixes = [...new Set(words)].filter(Boolean).map(escapeRegExp);
  return name.replace(new RegExp(` - (${suffixes.join("|")})$`), "");
}
