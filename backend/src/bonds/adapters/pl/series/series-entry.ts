import { CatalogEntry, SeriesFetchError } from "../../../bond-adapter";
import { BondTermsError, parseBondTerms } from "../../../domain/bond-terms";
import { ParsedSeriesCode } from "./series-code";
import { assertSeriesValues, SeriesValues } from "./series-values";
import { fillTemplate, SeriesTemplate } from "./templates";

/** The earlier of two `YYYY-MM` months is the smaller string. */
export function assertTemplateCovers(
  code: ParsedSeriesCode,
  template: SeriesTemplate,
): void {
  if (code.saleMonth < template.validFrom) {
    throw new SeriesFetchError("TEMPLATE_NOT_VALIDATED", {
      product: code.product,
      saleMonth: code.saleMonth,
      validFrom: template.validFrom,
    });
  }
}

/**
 * The catalog entry of a series from its template and values, after the bounds
 * and the strict terms parser: version 1, published on the letter's date. The
 * same path builds a fetched series and a manual one.
 */
export function buildSeriesEntry(
  code: ParsedSeriesCode,
  template: SeriesTemplate,
  values: SeriesValues,
  source: { readonly provider: string; readonly url: string },
): CatalogEntry {
  assertSeriesValues(code, template, values);
  const terms = fillTemplate(template, {
    seriesCode: code.code,
    firstPeriodRate: values.firstPeriodRate,
    addend: values.addend,
    fee: values.fee,
    saleWindow: values.saleWindow,
    source: {
      provider: source.provider,
      url: source.url,
      document: `List emisyjny nr ${values.letterNumber}`,
    },
  });
  try {
    parseBondTerms(terms);
  } catch (error) {
    if (error instanceof BondTermsError) {
      throw new SeriesFetchError(
        "SOURCE_FORMAT_CHANGED",
        { field: "terms" },
        { cause: error },
      );
    }
    throw error;
  }
  return { termsVersion: 1, publishedAt: values.letterDate, terms };
}
