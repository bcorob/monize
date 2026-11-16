/**
 * The number grammar of a trade confirmation (design "Trade confirmations"):
 * a share count, a per-share price, an executed total or a commission, as a
 * broker prints it. Pure, integer arithmetic only.
 *
 * It differs from the receipt amount grammar (`receipt-amount.ts`) on purpose:
 * a price or a share count has more than two decimals ("26.3201", "75,9878"),
 * which the receipt grammar reads as a thousand group, and a debit total is
 * often printed with a sign ("-$2,000.00", "($2,000.00)"), which is a
 * magnitude here because the action says which way the money went.
 */

const MAX_TEXT = 40;
const MAX_INTEGER_DIGITS = 12;
/** A currency symbol or code, and the space around it; what is left is the number. */
const CURRENCY_NOISE = /[A-Za-z$\u20ac\u00a3\u00a5\u00a0\u202f]/g;
/** Characters that make the text an expression or a quantity line, not one number. */
const OPERATOR = /[*+=\u00d7x/@:%]/i;
const LOOKALIKE_MINUS = /[\u2212\u2012\u2013\u2014]/g;

/**
 * Read one number as an integer count of `10^-maxDecimals` units, or null.
 *
 * - A currency symbol or code before or after it is ignored; a sign (`-`,
 *   a unicode minus) or a surrounding pair of parentheses is dropped.
 * - With both `.` and `,`, the later one is the decimal point and the other
 *   groups thousands. With one kind used twice or more, it groups thousands.
 *   Used once, it is the decimal point unless it is a `,` followed by exactly
 *   three digits ("1,234" is a thousand and more; "75,9878" and "26.320" are
 *   decimals).
 * - Spaces and apostrophes group thousands ("1 234,56", "1'234.56"); every
 *   group after the first has exactly three digits.
 * - More decimals than `maxDecimals` are refused unless the extra ones are 0.
 *
 * `decimals` is how many decimals the text was written with (trailing zeros
 * counted), which is what bounds the rounding of a printed price.
 */
export function parseTradeNumber(
  text: string,
  maxDecimals: number,
): { units: bigint; decimals: number } | null {
  if (typeof text !== "string") return null;
  let raw = text.trim();
  if (raw === "" || raw.length > MAX_TEXT) return null;
  // A letter between two digits is an expression or a quantity ("2 x 26.32").
  if (/\d\s*[A-Za-z]+\s*\d/.test(raw)) return null;
  raw = raw.replace(CURRENCY_NOISE, " ").trim();
  if (OPERATOR.test(raw)) return null;
  if (/^\(.*\)$/.test(raw)) raw = raw.slice(1, -1).trim();
  raw = raw.replace(LOOKALIKE_MINUS, "-");
  raw = raw.replace(/^-\s*/, "").replace(/\s*-$/, "").trim();
  if (raw.includes("-") || raw.includes("(") || raw.includes(")")) {
    return null;
  }

  // Thousand groups written with a space or an apostrophe.
  const spaced = raw.split(/[\s']+/);
  if (spaced.length > 1) {
    for (let i = 1; i < spaced.length; i++) {
      const head = spaced[i].split(/[.,]/)[0];
      if (!/^\d{3}$/.test(head)) return null;
    }
    raw = spaced.join("");
  }
  if (!/^[0-9.,]+$/.test(raw) || !/[0-9]/.test(raw)) return null;

  const dots = raw.split(".").length - 1;
  const commas = raw.split(",").length - 1;
  let decimal: "." | "," | null = null;
  if (dots > 0 && commas > 0) {
    decimal = raw.lastIndexOf(".") > raw.lastIndexOf(",") ? "." : ",";
    if ((decimal === "." ? dots : commas) !== 1) return null;
  } else if (dots === 1 || commas === 1) {
    const sep = dots === 1 ? "." : ",";
    const tail = raw.slice(raw.indexOf(sep) + 1);
    decimal = sep === "," && tail.length === 3 ? null : sep;
  }

  const at = decimal === null ? -1 : raw.lastIndexOf(decimal);
  const integerText = at < 0 ? raw : raw.slice(0, at);
  const fraction = at < 0 ? "" : raw.slice(at + 1);
  if (!/^[0-9]*$/.test(fraction)) return null;

  const groups = integerText.split(/[.,]/);
  for (let i = 1; i < groups.length; i++) {
    if (!/^[0-9]{3}$/.test(groups[i])) return null;
  }
  if (groups.length > 1 && !/^[0-9]{1,3}$/.test(groups[0])) return null;
  const digits = groups.join("");
  if (digits === "" && fraction === "") return null;
  if (digits.replace(/^0+/, "").length > MAX_INTEGER_DIGITS) return null;
  if (
    fraction.length > maxDecimals &&
    /[^0]/.test(fraction.slice(maxDecimals))
  ) {
    return null;
  }

  const scale = 10n ** BigInt(maxDecimals);
  const kept = fraction.slice(0, maxDecimals).padEnd(maxDecimals, "0");
  return {
    units: BigInt(digits === "" ? "0" : digits) * scale + BigInt(kept || "0"),
    decimals: fraction.length,
  };
}

const SYMBOL_CURRENCY: Readonly<Record<string, string>> = {
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

/**
 * The dollar signs that say whose dollar they are ("US$2,000.00", "C$ 26.32").
 * Read before the 3-letter codes, so "CDN$" is CAD rather than a code "CDN".
 * The receipt amount grammar takes the same prefixes as a currency mark
 * (`DOLLAR_PREFIXES`).
 */
const PREFIXED_DOLLAR: Readonly<Record<string, string>> = {
  US: "USD",
  C: "CAD",
  CA: "CAD",
  CAD: "CAD",
  CDN: "CAD",
  A: "AUD",
  AU: "AUD",
  NZ: "NZD",
  HK: "HKD",
};

/** The country prefixes of a dollar sign ("US" of "US$"), for the receipt amount grammar. */
export const DOLLAR_PREFIXES: readonly string[] = Object.keys(PREFIXED_DOLLAR);

/**
 * The currency an amount names, when it names one unambiguously: a dollar
 * sign with its country prefix ("US$", "C$", "CDN$"), a 3-letter code
 * ("USD 2,000.00", "2 000,00 CAD") or a symbol only one currency uses. A bare
 * `$` names no currency (it is the CAD and the USD sign alike).
 */
export function tradeAmountCurrency(text: string): string | null {
  const dollar = /(?:^|[^A-Za-z])([A-Z]{1,3})\s?\$/.exec(text);
  if (dollar && PREFIXED_DOLLAR[dollar[1]]) return PREFIXED_DOLLAR[dollar[1]];
  const code = /(?:^|[^A-Za-z])([A-Z]{3})(?:[^A-Za-z]|$)/.exec(text);
  if (code) return code[1];
  for (const [symbol, currency] of Object.entries(SYMBOL_CURRENCY)) {
    if (text.includes(symbol)) return currency;
  }
  return null;
}
