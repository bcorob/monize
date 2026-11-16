import { BondFetch, SeriesFetchError } from "../../../bond-adapter";
import { PRODUCT_SLUGS, parseSeriesCode } from "./series-code";
import { getFromIssuer, MAX_PAGE_BYTES, SERIES_HOST } from "./series-source";

/**
 * The issuer's home page lists the series on sale this month, one card per
 * product, each linking to `/oferta-obligacji/<product slug>/<series>/`. The
 * offer index itself answers a redirect, which the caller never follows.
 */
export const OFFER_URL = `https://${SERIES_HOST}/`;

const OFFER_LINK =
  /href="\/oferta-obligacji\/([a-z0-9-]+)\/([a-z0-9]{3,12})\/"/gi;

/**
 * The series codes the offer page links, each checked against its product slug
 * and the series-code grammar. A link that names no known product or whose slug
 * disagrees with its code is not a series on sale and is skipped; a page that
 * yields none is `SOURCE_FORMAT_CHANGED`. Pure.
 */
export function parseCurrentOffer(html: string): string[] {
  const codes = new Set<string>();
  for (const match of html.matchAll(OFFER_LINK)) {
    const slug = match[1].toLowerCase();
    let code;
    try {
      code = parseSeriesCode(match[2]);
    } catch (error) {
      if (error instanceof SeriesFetchError) continue;
      throw error;
    }
    if (PRODUCT_SLUGS[code.product] === slug) codes.add(code.code);
  }
  if (codes.size === 0) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", {
      field: "currentOffer",
    });
  }
  return [...codes].sort();
}

/** The series codes currently on sale, read from the issuer's own site. */
export async function fetchCurrentSeries(get: BondFetch): Promise<string[]> {
  const bytes = await getFromIssuer(
    get,
    OFFER_URL,
    MAX_PAGE_BYTES,
    "SOURCE_UNAVAILABLE",
  );
  return parseCurrentOffer(new TextDecoder("utf-8").decode(bytes));
}
