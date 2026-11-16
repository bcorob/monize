import {
  BenchmarkFetchError,
  BenchmarkFetchResult,
  BenchmarkObservation,
  BondFetch,
} from "../../bond-adapter";
import { isValidYMD } from "../../domain/calendar-date";
import { ExactDecimal } from "../../domain/exact-decimal";

/** The only host the NBP fetch talks to. */
export const NBP_HOST = "static.nbp.pl";
export const NBP_ARCHIVE_URL =
  "https://static.nbp.pl/dane/stopy/stopy_procentowe_archiwum.xml";
export const NBP_CURRENT_URL =
  "https://static.nbp.pl/dane/stopy/stopy_procentowe.xml";

const REFERENCE_ID = "ref";

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([A-Za-z_]+)\s*=\s*"([^"]*)"/g)) {
    found.set(match[1], match[2]);
  }
  return found;
}

/** "5,75" (percent, comma decimal) as the fraction "0.0575". */
function percentToFraction(text: string, where: string): string {
  if (!/^\d+(,\d+)?$/.test(text)) {
    throw new BenchmarkFetchError(`NBP ${where}: malformed rate "${text}"`);
  }
  return ExactDecimal.parse(text.replace(",", "."))
    .div(ExactDecimal.fromInt(100))
    .toTrimmedString(10, 4);
}

function checkedDate(text: string | undefined, where: string): string {
  if (!isValidYMD(text)) {
    throw new BenchmarkFetchError(
      `NBP ${where}: malformed date "${String(text)}"`,
    );
  }
  return text;
}

function referenceTag(inner: string): Map<string, string> | null {
  for (const tag of inner.matchAll(/<pozycja\b([^>]*?)\/?>/g)) {
    const attrs = attributes(tag[1]);
    if (attrs.get("id") === REFERENCE_ID) return attrs;
  }
  return null;
}

/**
 * The archive: one `<pozycje obowiazuje_od="...">` block per decision, holding
 * the rates it set. Only the reference rate (`id="ref"`) is kept.
 */
export function parseNbpArchive(xml: string): BenchmarkObservation[] {
  const text = xml.replace(/^\uFEFF/, "");
  if (!/<stopy_procentowe_archiwum\b/.test(text)) {
    throw new BenchmarkFetchError(
      "NBP archive: not a stopy_procentowe_archiwum document",
    );
  }
  const observations: BenchmarkObservation[] = [];
  for (const block of text.matchAll(
    /<pozycje\b([^>]*)>([\s\S]*?)<\/pozycje>/g,
  )) {
    const reference = referenceTag(block[2]);
    if (!reference) continue;
    observations.push({
      observationDate: checkedDate(
        attributes(block[1]).get("obowiazuje_od"),
        "archive",
      ),
      value: percentToFraction(
        reference.get("oprocentowanie") ?? "",
        "archive",
      ),
      publishedOn: null,
    });
  }
  if (observations.length === 0) {
    throw new BenchmarkFetchError("NBP archive: no reference rate rows");
  }
  return observations;
}

/** The current table: the reference rate carries its own `obowiazuje_od`. */
export function parseNbpCurrent(xml: string): BenchmarkObservation[] {
  const text = xml.replace(/^\uFEFF/, "");
  if (!/<stopy_procentowe\b/.test(text)) {
    throw new BenchmarkFetchError(
      "NBP current table: not a stopy_procentowe document",
    );
  }
  const publication =
    /<stopy_procentowe\b[^>]*data_publikacji\s*=\s*"([^"]*)"/.exec(text);
  const reference = referenceTag(text);
  if (!reference) {
    throw new BenchmarkFetchError("NBP current table: no reference rate row");
  }
  return [
    {
      observationDate: checkedDate(
        reference.get("obowiazuje_od"),
        "current table",
      ),
      value: percentToFraction(
        reference.get("oprocentowanie") ?? "",
        "current table",
      ),
      publishedOn:
        publication && isValidYMD(publication[1]) ? publication[1] : null,
    },
  ];
}

/** One row per effective date; the current table wins over the archive. */
export function mergeObservations(
  ...sets: readonly BenchmarkObservation[][]
): BenchmarkObservation[] {
  const byDate = new Map<string, BenchmarkObservation>();
  for (const set of sets) for (const o of set) byDate.set(o.observationDate, o);
  return [...byDate.values()].sort((a, b) =>
    a.observationDate.localeCompare(b.observationDate),
  );
}

async function download(get: BondFetch, url: string): Promise<string> {
  const response = await get(url);
  if (response.status !== 200) {
    throw new BenchmarkFetchError(
      `NBP ${url} answered HTTP ${response.status}`,
    );
  }
  return new TextDecoder("utf-8").decode(response.body);
}

/**
 * The reference rate history. When both documents agree the feed is
 * authoritative for every day up to today, so `coveredThrough` is the fetch
 * date: a later decision shows up in the current table, and a day with no newer
 * change is genuinely unchanged.
 *
 * When the current table holds a decision the archive does not, the archive is
 * behind and nothing here proves it has not missed a decision before that one
 * as well (the current table carries only the newest). Coverage is then the
 * archive's newest date: the days after it are unknown, not derived from a rate
 * that may have been replaced, until the archive catches up.
 */
export async function fetchNbpReference(
  get: BondFetch,
  today: string,
): Promise<BenchmarkFetchResult> {
  // Each row records the document it came from: the current table may carry a
  // decision the archive file does not hold yet.
  const archive = parseNbpArchive(await download(get, NBP_ARCHIVE_URL)).map(
    (o) => ({ ...o, sourceUrl: NBP_ARCHIVE_URL }),
  );
  const current = parseNbpCurrent(await download(get, NBP_CURRENT_URL)).map(
    (o) => ({ ...o, sourceUrl: NBP_CURRENT_URL }),
  );
  const archiveDates = new Set(archive.map((o) => o.observationDate));
  const archiveNewest = archive.reduce(
    (newest, o) => (o.observationDate > newest ? o.observationDate : newest),
    "",
  );
  const archiveBehind = current.some(
    (o) =>
      !archiveDates.has(o.observationDate) && o.observationDate > archiveNewest,
  );
  return {
    observations: mergeObservations(archive, current),
    coveredThrough: archiveBehind ? archiveNewest : today,
    sourceUrl: NBP_ARCHIVE_URL,
  };
}
