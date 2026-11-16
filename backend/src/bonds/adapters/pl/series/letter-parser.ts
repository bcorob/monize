import {
  formatError,
  longDateToIso,
  percentToFraction,
  plnToDecimal,
} from "./series-values";

export interface ParsedLetter {
  /** "96/2024". */
  readonly number: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  /** The series the letter issues (the names after "nazwie skróconej" in its opening). */
  readonly seriesCodes: readonly string[];
  /** True when the letter gives one rate for the whole life of the bond. */
  readonly fixed: boolean;
  /** The first period's rate, or the fixed rate: a fraction string. */
  readonly firstPeriodRate: string;
  /** The margin or spread of the later periods; null for a fixed rate. */
  readonly addend: string | null;
  readonly saleWindow: { readonly from: string; readonly to: string };
  /** The early redemption fee cap per bond, "3.00"; null when the letter names none. */
  readonly fee: string | null;
  /** The nominal of one bond, "100.00". */
  readonly faceValue: string;
}

const MONTH = "[a-ząćęłńóśźż]+";

/** One line of text: soft hyphens and zero-width marks dropped, every run of white space one space. */
export function letterText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\u00ad|\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function find(text: string, pattern: RegExp, field: string): RegExpExecArray {
  const match = pattern.exec(text);
  if (!match) throw formatError("SOURCE_FORMAT_CHANGED", { field });
  return match;
}

function percent(match: RegExpExecArray, field: string): string {
  const fraction = percentToFraction(match[1]);
  if (fraction === null) throw formatError("SOURCE_FORMAT_CHANGED", { field });
  return fraction;
}

/**
 * Reads the text of an issue letter (spec bond-series-fetch 4.3). Line breaks
 * inside a phrase are white space. Every field that cannot be found is
 * `SOURCE_FORMAT_CHANGED` naming it.
 */
export function parseLetter(raw: string): ParsedLetter {
  const text = letterText(raw);

  const header = find(
    text,
    /LIST EMISYJNY nr (\d{1,4})\/(\d{4})\b/i,
    "letterNumber",
  );
  const afterHeader = text.slice(header.index + header[0].length);
  const dateMatch = find(
    afterHeader,
    new RegExp(`\\bz dnia (\\d{1,2}) (${MONTH}) (\\d{4}) r\\.`, "i"),
    "letterDate",
  );
  const date = longDateToIso(dateMatch[1], dateMatch[2], dateMatch[3]);
  if (date === null)
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "letterDate" });

  // The opening sentence ends where the numbered paragraphs begin; the series
  // named later (the ones a bond may be exchanged from) are not the issue.
  const paragraphs = text.indexOf(" 1. Do sprzedaży");
  const opening = text.slice(0, paragraphs > 0 ? paragraphs : 2000);
  const seriesCodes = [
    ...opening.matchAll(/nazwie skróconej ([A-Z]{3}\d{4})(?![A-Za-z0-9])/g),
  ].map((m) => m[1]);
  if (seriesCodes.length === 0) {
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "letterSeries" });
  }

  const face = find(
    text,
    /Nominał jednej obligacji wynosi (\d{1,6}) zł/i,
    "faceValue",
  );
  const faceValue = plnToDecimal(face[1]);
  if (faceValue === null)
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "faceValue" });

  const window = find(
    text,
    new RegExp(
      `do sprzedaży w dniach od (\\d{1,2}) do (?:dnia )?(\\d{1,2}) (${MONTH}) (\\d{4}) r\\.`,
      "i",
    ),
    "saleWindow",
  );
  const from = longDateToIso(window[1], window[3], window[4]);
  const to = longDateToIso(window[2], window[3], window[4]);
  if (from === null || to === null) {
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "saleWindow" });
  }

  // "wynos" is a typo that the January 2024 EDO letter really carries.
  const first =
    /W pierwszym okresie odsetkowym stopa procentowa wynos\w* (\d{1,3},\d{1,4})% w skali roku/i.exec(
      text,
    );
  const fixedMatch = first
    ? null
    : /Oprocentowanie obligacji (?:jest stałe i )?wynosi (\d{1,3},\d{1,4})% w stosunku rocznym/i.exec(
        text,
      );
  if (!first && !fixedMatch) {
    throw formatError("SOURCE_FORMAT_CHANGED", { field: "firstPeriodRate" });
  }
  const firstPeriodRate = percent(
    (first ?? fixedMatch) as RegExpExecArray,
    "firstPeriodRate",
  );

  let addend: string | null = null;
  if (first) {
    const marginMatch = find(
      text.slice(first.index),
      /\bmarż\S* w wysokości (\d{1,3},\d{1,4})%/i,
      "margin",
    );
    addend = percent(marginMatch, "margin");
  }

  const feeMatch =
    /nie wyższą niż (\d{1,3}(?:,\d{2})?) zł/i.exec(text) ??
    /przedterminowego wykupu[^.;]{0,160}?pomniejszana[^.;]{0,160}?w wysokości (\d{1,3}(?:,\d{2})?) zł/i.exec(
      text,
    );
  const fee = feeMatch ? plnToDecimal(feeMatch[1]) : null;

  return {
    number: `${header[1]}/${header[2]}`,
    date,
    seriesCodes,
    fixed: !first,
    firstPeriodRate,
    addend,
    saleWindow: { from, to },
    fee,
    faceValue,
  };
}
