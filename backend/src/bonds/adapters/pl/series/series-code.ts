import { SeriesFetchError } from "../../../bond-adapter";

/**
 * Months from sale to maturity, per product (spec bond-series-fetch 4.1). The
 * code `EDO1036` names the maturity month and year; the sale month is that minus
 * the tenor.
 */
export const PRODUCT_TENOR_MONTHS = {
  OTS: 3,
  ROR: 12,
  DOR: 24,
  TOS: 36,
  COI: 48,
  ROS: 72,
  EDO: 120,
  ROD: 144,
} as const;

export type PolishProduct = keyof typeof PRODUCT_TENOR_MONTHS;

/** The product's path segment under /oferta-obligacji/ on the issuer's site. */
export const PRODUCT_SLUGS: Readonly<Record<PolishProduct, string>> = {
  OTS: "obligacje-3-miesieczne-ots",
  ROR: "obligacje-roczne-ror",
  DOR: "obligacje-2-letnie-dor",
  TOS: "obligacje-3-letnie-tos",
  COI: "obligacje-4-letnie-coi",
  ROS: "obligacje-6-letnie-ros",
  EDO: "obligacje-10-letnie-edo",
  ROD: "obligacje-12-letnie-rod",
};

export interface ParsedSeriesCode {
  /** Upper case, e.g. `EDO1036`. */
  readonly code: string;
  readonly product: PolishProduct;
  /** The sale month as `YYYY-MM`. */
  readonly saleMonth: string;
  /** First and last day of the sale month, as the issuer sells monthly. */
  readonly saleWindow: { readonly from: string; readonly to: string };
}

const CODE_PATTERN = /^([A-Z]{3})(\d{2})(\d{2})$/;

/** A code echoed back in an error: letters and digits only, never free text. */
function safeEcho(raw: unknown): string {
  return typeof raw === "string" && /^[A-Za-z0-9]{1,12}$/.test(raw) ? raw : "";
}

function isProduct(value: string): value is PolishProduct {
  return Object.prototype.hasOwnProperty.call(PRODUCT_TENOR_MONTHS, value);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The code is upper-cased, then checked: three letters naming a product, the
 * maturity month 01..12 and a two-digit maturity year (20YY).
 */
export function parseSeriesCode(raw: unknown): ParsedSeriesCode {
  const invalid = () =>
    new SeriesFetchError("SERIES_CODE_INVALID", { seriesCode: safeEcho(raw) });
  if (typeof raw !== "string" || raw.length > 12) throw invalid();
  const code = raw.trim().toUpperCase();
  const match = CODE_PATTERN.exec(code);
  if (!match || !isProduct(match[1])) throw invalid();
  const maturityMonth = parseInt(match[2], 10);
  if (maturityMonth < 1 || maturityMonth > 12) throw invalid();
  const maturityYear = 2000 + parseInt(match[3], 10);

  const product = match[1];
  const saleIndex =
    maturityYear * 12 + (maturityMonth - 1) - PRODUCT_TENOR_MONTHS[product];
  const saleYear = Math.floor(saleIndex / 12);
  const month = (saleIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(saleYear, month, 0)).getUTCDate();
  return {
    code,
    product,
    saleMonth: `${saleYear}-${pad(month)}`,
    saleWindow: {
      from: `${saleYear}-${pad(month)}-01`,
      to: `${saleYear}-${pad(month)}-${pad(lastDay)}`,
    },
  };
}

/**
 * The code of the series of `product` sold in `saleMonth` (`YYYY-MM`): the
 * maturity month and year are the sale month plus the product's tenor. The
 * inverse of `parseSeriesCode`.
 */
export function seriesCodeFor(
  product: PolishProduct,
  saleMonth: string,
): string {
  const [year, month] = saleMonth.split("-").map((part) => parseInt(part, 10));
  const maturityIndex = year * 12 + (month - 1) + PRODUCT_TENOR_MONTHS[product];
  const maturityYear = Math.floor(maturityIndex / 12);
  return `${product}${pad((maturityIndex % 12) + 1)}${pad(maturityYear % 100)}`;
}
