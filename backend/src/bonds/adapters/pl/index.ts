import { todayInTimezone } from "../../../common/date-utils";
import {
  BenchmarkFetchError,
  BondAdapter,
  BondFetch,
  BondProgramDefinition,
} from "../../bond-adapter";
import { isValidYMD } from "../../domain/calendar-date";
import { registerCalendar } from "../../domain/calendar-registry";
import type { CalendarRegistry } from "../../domain/calendar-registry";
import { fetchGusCpi, GUS_CPI_LANDING_URL, GUS_HOST } from "./pl-gus-cpi";
import {
  fetchNbpReference,
  NBP_ARCHIVE_URL,
  NBP_HOST,
} from "./pl-nbp-reference";
import { PL_CPI_GUS_YOY, PL_NBP_REFERENCE } from "./pl-benchmarks";
import { plCalendar } from "./pl-calendar";
import { backfillCodes, SERIES_VALID_FROM } from "./series/backfill-codes";
import {
  parseSeriesCode,
  PolishProduct,
  PRODUCT_TENOR_MONTHS,
  seriesCodeFor as polishSeriesCodeFor,
} from "./series/series-code";
import { productPageUrl } from "./series/series-source";
import { fetchCurrentSeries } from "./series/current-offer";
import { fetchSeries } from "./series/fetch-series";
import { manualSeries } from "./series/manual-series";
import { SERIES_TEMPLATES } from "./series/templates";

export { plBenchmarks } from "./pl-benchmarks";
export { plCalendar } from "./pl-calendar";

const PL_TIMEZONE = "Europe/Warsaw";

/** The registry plus the Polish calendar, for the caller to pass to the engine. */
export function registerPolishCalendars(
  registry: CalendarRegistry,
): CalendarRegistry {
  return registerCalendar(registry, plCalendar);
}

/** One program per product template: the structure is the template's, the series are a person's. */
const programs: readonly BondProgramDefinition[] = Object.values(
  SERIES_TEMPLATES,
).map(({ structure: { instrument } }) => ({
  issuerCountryCode: instrument.issuerCountryCode as string,
  issuerCode: instrument.issuerCode as string,
  programCode: instrument.programCode as string,
  currency: instrument.currency as string,
  faceValue: instrument.faceValue as string,
  infoUrl: productPageUrl(instrument.programCode as PolishProduct),
}));

export const POLISH_BOND_ADAPTER: BondAdapter = {
  countryCode: "PL",
  specDoc: "docs/specs/polish-retail-bonds.md",
  timezone: PL_TIMEZONE,
  registerCalendars: registerPolishCalendars,
  benchmarks: [
    {
      code: PL_NBP_REFERENCE,
      kind: "STEP",
      publisher: "NBP",
      sourceUrl: NBP_ARCHIVE_URL,
      hosts: [NBP_HOST],
      unit: "RATE_FRACTION",
      providerId: "nbp",
    },
    {
      code: PL_CPI_GUS_YOY,
      kind: "MONTHLY",
      publisher: "GUS",
      sourceUrl: GUS_CPI_LANDING_URL,
      hosts: [GUS_HOST],
      unit: "RATE_FRACTION",
      providerId: "gus",
    },
  ],
  programs,
  fetchSeries: (seriesCode: string, fetch: BondFetch) =>
    fetchSeries(seriesCode, fetch),
  manualSeries,
  seriesProviderId: "obligacjeskarbowe",
  currentSeries: fetchCurrentSeries,
  backfillCodes,
  programOf: (seriesCode: string) => {
    try {
      return parseSeriesCode(seriesCode).product;
    } catch {
      return null;
    }
  },
  seriesValidFrom: SERIES_VALID_FROM,
  seriesCodeFor: (programCode: string, saleDate: string) =>
    Object.prototype.hasOwnProperty.call(PRODUCT_TENOR_MONTHS, programCode) &&
    isValidYMD(saleDate)
      ? polishSeriesCodeFor(programCode as PolishProduct, saleDate.slice(0, 7))
      : null,
  async fetchBenchmark(code: string, fetch: BondFetch) {
    switch (code) {
      case PL_NBP_REFERENCE:
        return fetchNbpReference(fetch, todayInTimezone(PL_TIMEZONE) as string);
      case PL_CPI_GUS_YOY:
        return fetchGusCpi(fetch, todayInTimezone(PL_TIMEZONE) as string);
      default:
        throw new BenchmarkFetchError(
          `The Polish adapter has no benchmark ${code}`,
        );
    }
  },
};
