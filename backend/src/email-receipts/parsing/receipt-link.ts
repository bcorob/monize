import {
  MAX_INSTALMENT_TEXT_LENGTH,
  MAX_LINK_VALUE_LENGTH,
} from "./receipt-parser.types";

/**
 * The link value of linked receipts (spec "linked receipts" 2.1): the text a
 * `{link}` capture read, with ALL whitespace removed (a no-break space too) and
 * lower-cased, so a component and a settlement that print one contract number
 * with different spacing agree. Null when nothing is left or the value is
 * longer than `MAX_LINK_VALUE_LENGTH`.
 */
export function normalizeLinkValue(raw: string): string | null {
  const value = raw.replace(/\s+/g, "").toLowerCase();
  return value === "" || value.length > MAX_LINK_VALUE_LENGTH ? null : value;
}

/**
 * The `{instalment}` text of a settlement part ("1. spłata z 3"): trimmed,
 * whitespace runs folded to one space, cut to `MAX_INSTALMENT_TEXT_LENGTH`.
 * Null when nothing is left.
 */
export function normalizeInstalmentText(raw: string): string | null {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value === "") return null;
  return value.slice(0, MAX_INSTALMENT_TEXT_LENGTH).trim();
}
