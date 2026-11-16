import { SeriesFetchError } from "../../../bond-adapter";
import {
  dottedDateToIso,
  formatError,
  percentToFraction,
  plnToDecimal,
} from "./series-values";

export interface ParsedPage {
  /** The series the page names in its "Seria:" field. */
  readonly seriesCode: string;
  /** A fraction string: "0.0655". */
  readonly firstPeriodRate: string;
  /** "margin" or "spread" with its value, null when the rate is fixed. */
  readonly addend: {
    readonly kind: "margin" | "spread";
    readonly value: string;
  } | null;
  readonly saleWindow: { readonly from: string; readonly to: string };
  /** "100.00". */
  readonly price: string;
  /** The href of the "Zobacz list emisyjny" link, as written on the page. */
  readonly letterHref: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  oacute: "ó",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

/**
 * The page's visible text: scripts, styles and comments dropped, tags to spaces, one space between words.
 * An end tag may carry whitespace and junk before its `>` (`</script foo>`), which a browser still
 * reads as the end of the block, so the block patterns accept it too.
 */
export function pageText(html: string): string {
  const withoutCode = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script(?:\s+[^>]*)?\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style(?:\s+[^>]*)?\s*>/gi, " ");
  return decodeEntities(withoutCode.replace(/<[^>]*>/g, " "))
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

/** The `href` of the first link whose text is "Zobacz list emisyjny". */
function letterHref(html: string): string | null {
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (let m = anchor.exec(html); m !== null; m = anchor.exec(html)) {
    if (!/Zobacz\s+list\s+emisyjny/i.test(pageText(m[2]))) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1]);
    const value = href ? (href[1] ?? href[2]) : null;
    if (value) return decodeEntities(value).trim();
  }
  return null;
}

const LABELS = [
  "Seria:",
  "Oprocentowanie:",
  "Kapitalizacja odsetek:",
  "Wypłata odsetek:",
  "Okres oprocentowania:",
  "Sprzedaż:",
  "Cena sprzedaży jednej obligacji:",
  "Cena zamiany jednej obligacji:",
  "Odsetki:",
];

/** The text after `label` up to the next known label, or null when the label is absent. */
function fieldValue(text: string, label: string): string | null {
  const start = text.indexOf(label);
  if (start < 0) return null;
  const from = start + label.length;
  let end = text.length;
  for (const other of LABELS) {
    const at = text.indexOf(other, from);
    if (at >= 0 && at < end) end = at;
  }
  return text.slice(from, end).trim();
}

function required(text: string, label: string, field: string): string {
  const value = fieldValue(text, label);
  if (value === null || value === "") {
    throw formatError("SOURCE_FORMAT_CHANGED", { field });
  }
  return value;
}

function percentIn(text: string, pattern: RegExp, field: string): string {
  const m = pattern.exec(text);
  const fraction = m ? percentToFraction(m[1]) : null;
  if (fraction === null) throw formatError("SOURCE_FORMAT_CHANGED", { field });
  return fraction;
}

/**
 * Reads the series page (spec bond-series-fetch 4.3): "Seria:", "Oprocentowanie:",
 * "Sprzedaż:", "Cena sprzedaży jednej obligacji:" and the link to the issue
 * letter. A page with no "Seria:" is a series the issuer has not published.
 */
export function parseSeriesPage(html: string): ParsedPage {
  const text = pageText(html);
  const series = fieldValue(text, "Seria:");
  const seriesMatch =
    series === null ? null : /^([A-Z]{3}\d{4})(?![A-Za-z0-9])/.exec(series);
  if (!seriesMatch) throw new SeriesFetchError("SERIES_NOT_PUBLISHED");

  const interest = required(text, "Oprocentowanie:", "rate");
  const firstPeriodRate = percentIn(
    interest,
    /^(\d{1,3},\d{1,4})\s*%/,
    "firstPeriodRate",
  );
  const marginMatch = /mar[żz]a\s+(\d{1,3},\d{1,4})\s*%\s*\+\s*inflacja/i.exec(
    interest,
  );
  const spreadMatch =
    /stopa\s+referencyjna\s+NBP\s*\+\s*(\d{1,3},\d{1,4})\s*%/i.exec(interest);
  if (marginMatch && spreadMatch) {
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "addend" });
  }
  let addend: ParsedPage["addend"] = null;
  if (marginMatch) {
    addend = {
      kind: "margin",
      value: percentIn(marginMatch[0], /(\d{1,3},\d{1,4})/, "margin"),
    };
  } else if (spreadMatch) {
    addend = {
      kind: "spread",
      value: percentIn(spreadMatch[0], /\+\s*(\d{1,3},\d{1,4})/, "spread"),
    };
  }

  const sale = required(text, "Sprzedaż:", "saleWindow");
  const saleMatch = /^(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/.exec(
    sale,
  );
  const from = saleMatch ? dottedDateToIso(saleMatch[1]) : null;
  const to = saleMatch ? dottedDateToIso(saleMatch[2]) : null;
  if (from === null || to === null) {
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "saleWindow" });
  }

  const priceText = required(text, "Cena sprzedaży jednej obligacji:", "price");
  const priceMatch = /^(\d{1,6},\d{2})\s*zł/.exec(priceText);
  const price = priceMatch ? plnToDecimal(priceMatch[1]) : null;
  if (price === null)
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "price" });

  const href = letterHref(html);
  if (href === null)
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "letterLink" });

  return {
    seriesCode: seriesMatch[1],
    firstPeriodRate,
    addend,
    saleWindow: { from, to },
    price,
    letterHref: href,
  };
}
