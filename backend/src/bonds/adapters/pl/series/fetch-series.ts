import { extractPdfText } from "../../../../common/pdf-text";
import {
  BondFetch,
  CatalogEntry,
  FetchedSeries,
  SeriesFetchError,
} from "../../../bond-adapter";
import { parseLetter, ParsedLetter } from "./letter-parser";
import { ParsedPage, parseSeriesPage } from "./page-parser";
import { ParsedSeriesCode, parseSeriesCode } from "./series-code";
import { assertTemplateCovers, buildSeriesEntry } from "./series-entry";
import {
  getFromIssuer,
  MAX_PAGE_BYTES,
  MAX_PDF_BYTES,
  resolveLetterUrl,
  SERIES_PROVIDER,
  seriesPageUrl,
} from "./series-source";
import { SeriesValues } from "./series-values";
import { SeriesTemplate, SERIES_TEMPLATES } from "./templates";

const PDF_MAGIC = "%PDF-";

/** A letter is a few dozen pages at most; refuse a document that claims more. */
const MAX_LETTER_PAGES = 60;

function disagree(
  field: string,
  page: string,
  letter: string,
): SeriesFetchError {
  return new SeriesFetchError("SOURCE_INCONSISTENT", { field, page, letter });
}

/** Each field the page and the letter both state must agree (spec 4.3). */
function crossCheck(
  code: ParsedSeriesCode,
  template: SeriesTemplate,
  page: ParsedPage,
  letter: ParsedLetter,
): void {
  if (!letter.seriesCodes.includes(code.code)) {
    throw disagree("seriesCode", code.code, letter.seriesCodes.join(","));
  }
  if (page.price !== letter.faceValue || page.price !== "100.00") {
    throw disagree("faceValue", page.price, letter.faceValue);
  }
  // The shape of the rate is part of the template: a letter or page that says
  // otherwise is a product this template does not describe.
  const fixed = template.addend === null;
  if (
    letter.fixed !== fixed ||
    (page.addend?.kind ?? null) !== template.addend
  ) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "rateRule" });
  }
  if (page.firstPeriodRate !== letter.firstPeriodRate) {
    throw disagree(
      "firstPeriodRate",
      page.firstPeriodRate,
      letter.firstPeriodRate,
    );
  }
  if ((page.addend?.value ?? null) !== letter.addend) {
    throw disagree(
      template.addend ?? "addend",
      page.addend?.value ?? "none",
      letter.addend ?? "none",
    );
  }
  // The letter is the legal act and its sale window is the one stored. The page
  // is a summary that has been seen a day short (EDO0734: page 30.07.2024,
  // letter and the other July 2024 pages 31.07.2024), so it must only lie
  // inside the letter's window; a page window reaching outside it is a misread.
  const { from, to } = page.saleWindow;
  if (from < letter.saleWindow.from || to > letter.saleWindow.to || from > to) {
    throw disagree(
      "saleWindow",
      `${from}/${to}`,
      `${letter.saleWindow.from}/${letter.saleWindow.to}`,
    );
  }
}

async function readLetter(bytes: Uint8Array): Promise<ParsedLetter> {
  const magic = new TextDecoder("latin1").decode(
    bytes.subarray(0, PDF_MAGIC.length),
  );
  if (magic !== PDF_MAGIC) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "letterPdf" });
  }
  let text: string;
  try {
    text = await extractPdfText(bytes, MAX_LETTER_PAGES);
  } catch (error) {
    throw new SeriesFetchError(
      "SOURCE_FORMAT_CHANGED",
      { field: "letterText" },
      { cause: error },
    );
  }
  return parseLetter(text);
}

/**
 * Reads one series from the issuer's own site: the series page and the issue
 * letter it links, cross-checked field by field, filled into the product's
 * template and passed through the strict terms parser. Nothing is returned
 * unless every check holds (INV-BOND-006: refuse before writing).
 */
export async function fetchSeries(
  seriesCode: string,
  get: BondFetch,
  now: () => Date = () => new Date(),
): Promise<FetchedSeries> {
  const code = parseSeriesCode(seriesCode);
  const template = SERIES_TEMPLATES[code.product];
  assertTemplateCovers(code, template);

  const pageUrl = seriesPageUrl(code);
  const pageRetrievedAt = now().toISOString();
  const pageBytes = await getFromIssuer(
    get,
    pageUrl,
    MAX_PAGE_BYTES,
    "SERIES_NOT_PUBLISHED",
  );
  const page = parseSeriesPage(new TextDecoder("utf-8").decode(pageBytes));
  if (page.seriesCode !== code.code) {
    throw new SeriesFetchError("SERIES_NOT_PUBLISHED");
  }

  const letterUrl = resolveLetterUrl(page.letterHref, pageUrl);
  const letterRetrievedAt = now().toISOString();
  const pdf = await getFromIssuer(
    get,
    letterUrl,
    MAX_PDF_BYTES,
    "SOURCE_DOCUMENT_MISSING",
  );
  const letter = await readLetter(pdf);

  crossCheck(code, template, page, letter);
  if (template.hasFee && letter.fee === null) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "fee" });
  }

  const values: SeriesValues = {
    firstPeriodRate: letter.firstPeriodRate,
    addend: letter.addend,
    fee: letter.fee,
    saleWindow: letter.saleWindow,
    letterNumber: letter.number,
    letterDate: letter.date,
  };
  const entry: CatalogEntry = buildSeriesEntry(code, template, values, {
    provider: SERIES_PROVIDER,
    url: pageUrl,
  });
  return {
    entry,
    sources: [
      { provider: SERIES_PROVIDER, url: pageUrl, retrievedAt: pageRetrievedAt },
      {
        provider: SERIES_PROVIDER,
        url: letterUrl,
        retrievedAt: letterRetrievedAt,
      },
    ],
  };
}
