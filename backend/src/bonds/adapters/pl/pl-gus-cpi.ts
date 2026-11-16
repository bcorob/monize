import {
  BenchmarkFetchError,
  BenchmarkFetchResult,
  BenchmarkObservation,
  BondFetch,
} from "../../bond-adapter";
import { ExactDecimal } from "../../domain/exact-decimal";

/**
 * GUS publishes the table as a numbered file whose suffix (`_8`) is bumped when
 * the file is replaced; the old URL may keep answering with the old data. The
 * landing page always links the current file, so it is read first and this
 * constant is only the fallback.
 */
export const GUS_CPI_CSV_URL =
  "https://stat.gov.pl/download/gfx/portalinformacyjny/pl/defaultstronaopisowa/4741/1/1/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_8.csv";
export const GUS_CPI_LANDING_URL =
  "https://stat.gov.pl/obszary-tematyczne/ceny-handel/wskazniki-cen/wskazniki-cen-towarow-i-uslug-konsumpcyjnych-pot-inflacja-/miesieczne-wskazniki-cen-towarow-i-uslug-konsumpcyjnych-od-1982-roku/";

/** The only host the CPI fetch talks to: the landing page and the file it links. */
export const GUS_HOST = "stat.gov.pl";
const NATION = "Polska";
const YEAR_ON_YEAR = "Analogiczny miesiąc poprzedniego roku = 100";

const nfc = (text: string) => text.normalize("NFC");

/** The index "103,4" (previous year = 100) as the fraction "0.034". */
function indexToFraction(text: string, where: string): string {
  if (!/^\d+(,\d+)?$/.test(text)) {
    throw new BenchmarkFetchError(
      `GUS CPI ${where}: malformed value "${text}"`,
    );
  }
  return ExactDecimal.parse(text.replace(",", "."))
    .sub(ExactDecimal.fromInt(100))
    .div(ExactDecimal.fromInt(100))
    .toTrimmedString(10, 4);
}

/**
 * Year-on-year CPI for Poland, one observation per reference month, dated the
 * first of the month. A month GUS has not published has an empty value and is
 * skipped, never read as zero.
 */
export function parseGusCpiCsv(text: string): BenchmarkObservation[] {
  const [header, ...lines] = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const columns = (header ?? "").split(";").map((c) => nfc(c.trim()));
  const at = (name: string) => columns.indexOf(nfc(name));
  const [territory, presentation, year, month, value] = [
    at("Jednostka terytorialna"),
    at("Sposób prezentacji"),
    at("Rok"),
    at("Miesiąc"),
    at("Wartość"),
  ];
  if ([territory, presentation, year, month, value].includes(-1)) {
    throw new BenchmarkFetchError("GUS CPI: unexpected CSV header");
  }

  const byDate = new Map<string, BenchmarkObservation>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const cells = line.split(";").map((c) => nfc(c.trim()));
    if (cells[territory] !== NATION || cells[presentation] !== YEAR_ON_YEAR)
      continue;
    if (cells[value] === "") continue;
    const y = Number(cells[year]);
    const m = Number(cells[month]);
    if (
      !Number.isInteger(y) ||
      y < 1982 ||
      !Number.isInteger(m) ||
      m < 1 ||
      m > 12
    ) {
      throw new BenchmarkFetchError(
        `GUS CPI: malformed period "${cells[year]}-${cells[month]}"`,
      );
    }
    const observationDate = `${y}-${String(m).padStart(2, "0")}-01`;
    if (byDate.has(observationDate)) {
      throw new BenchmarkFetchError(
        `GUS CPI: duplicate row for ${observationDate}`,
      );
    }
    byDate.set(observationDate, {
      observationDate,
      value: indexToFraction(cells[value], observationDate),
      publishedOn: null,
    });
  }
  if (byDate.size === 0)
    throw new BenchmarkFetchError("GUS CPI: no usable rows");
  return [...byDate.values()].sort((a, b) =>
    a.observationDate.localeCompare(b.observationDate),
  );
}

/** Only the publisher's own host, over TLS: a link anywhere else is not GUS data. */
function isGusHttps(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    (url.hostname === GUS_HOST || url.hostname.endsWith(`.${GUS_HOST}`))
  );
}

/**
 * The monthly CPI file on the landing page, as an absolute https URL on
 * stat.gov.pl (or one of its subdomains). The values are written to global
 * reference data every user's valuation reads, so a link to another host, to
 * plain http or to a malformed target is ignored rather than followed.
 */
export function findCsvLink(html: string): string | null {
  const links = [...html.matchAll(/href="([^"]+\.csv)"/gi)].map((m) => m[1]);
  for (const href of links) {
    if (!/wskaznikicentowarowiuslugkonsumpcyjnychod1982/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, GUS_CPI_LANDING_URL);
    } catch {
      continue;
    }
    if (isGusHttps(url)) return url.toString();
  }
  return null;
}

/** A file whose newest observation is older than this many months is a stale feed. */
export const GUS_MAX_STALE_MONTHS = 3;

/** `today` minus whole calendar months, as YYYY-MM-DD (the day clamped to the month's end). */
function monthsBefore(today: string, months: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The CPI file the landing page links now, or null when the page cannot be read
 * or links none. Always asked first: GUS replaces the numbered file without
 * retiring the old URL, which keeps answering 200 with the old data.
 */
async function discoverCsvLink(get: BondFetch): Promise<string | null> {
  const page = await get(GUS_CPI_LANDING_URL);
  if (page.status !== 200) return null;
  return findCsvLink(new TextDecoder("utf-8").decode(page.body));
}

/**
 * Year-on-year CPI from GUS. The file is found on the landing page every time;
 * `GUS_CPI_CSV_URL` is only the fallback for a page that cannot be read. A file
 * whose newest observation is more than `GUS_MAX_STALE_MONTHS` months before
 * `today` is a failure, not a success: storing it would stamp the series as
 * freshly fetched while every later month is missing.
 */
export async function fetchGusCpi(
  get: BondFetch,
  today: string,
): Promise<BenchmarkFetchResult> {
  const url = (await discoverCsvLink(get)) ?? GUS_CPI_CSV_URL;
  const response = await get(url);
  if (response.status !== 200) {
    throw new BenchmarkFetchError(
      `GUS CPI ${url} answered HTTP ${response.status}`,
    );
  }
  const observations = parseGusCpiCsv(
    new TextDecoder("windows-1250").decode(response.body),
  );
  const newest = observations[observations.length - 1].observationDate;
  const oldestAcceptable = monthsBefore(today, GUS_MAX_STALE_MONTHS);
  if (newest < oldestAcceptable) {
    throw new BenchmarkFetchError(
      `GUS CPI ${url}: the newest observation is ${newest}, older than ${GUS_MAX_STALE_MONTHS} months before ${today}; the feed is stale`,
    );
  }
  return { observations, coveredThrough: newest, sourceUrl: url };
}
