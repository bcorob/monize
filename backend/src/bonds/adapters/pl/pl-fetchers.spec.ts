import { readFileSync } from "fs";
import { join } from "path";
import { BenchmarkFetchError, BondFetch } from "../../bond-adapter";
import { POLISH_BOND_ADAPTER } from ".";
import { templateFaceValueOf } from "../../bond-adapters";
import { ProviderHealthService } from "../../../provider-health/provider-health.service";
import { SeriesHttp } from "../../series-http";
import {
  findCsvLink,
  fetchGusCpi,
  GUS_CPI_CSV_URL,
  GUS_CPI_LANDING_URL,
  parseGusCpiCsv,
} from "./pl-gus-cpi";
import {
  fetchNbpReference,
  mergeObservations,
  NBP_ARCHIVE_URL,
  NBP_CURRENT_URL,
  parseNbpArchive,
  parseNbpCurrent,
} from "./pl-nbp-reference";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name));
const text = (name: string) => fixture(name).toString("utf8");
const bytes = (value: string) => new TextEncoder().encode(value);

function routes(
  table: Record<string, { status: number; body: Uint8Array }>,
): jest.MockedFunction<BondFetch> {
  return jest.fn(async (url: string) => {
    const hit = table[url];
    if (!hit) throw new Error(`unexpected url ${url}`);
    return hit;
  });
}

describe("NBP reference rate parsers", () => {
  it("reads the reference rows of the archive, BOM and comma decimals included", () => {
    expect(text("nbp-archive.xml").charCodeAt(0)).toBe(0xfeff);
    const rows = parseNbpArchive(text("nbp-archive.xml"));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      observationDate: "1998-02-26",
      value: "0.2400",
      publishedOn: null,
    });
    expect(rows[rows.length - 1]).toEqual({
      observationDate: "2026-03-05",
      value: "0.0375",
      publishedOn: null,
    });
  });

  it("reads the reference rate of the current table with its own date", () => {
    expect(parseNbpCurrent(text("nbp-current.xml"))).toEqual([
      {
        observationDate: "2026-03-05",
        value: "0.0375",
        publishedOn: "2026-03-05",
      },
    ]);
  });

  it("keeps only the reference rate, not the other rates of a decision", () => {
    const xml = `<stopy_procentowe_archiwum><pozycje obowiazuje_od="2020-05-29">
      <pozycja id="lom" oprocentowanie="1,00"/><pozycja id="ref" oprocentowanie="0,10"/></pozycje>
      <pozycje obowiazuje_od="2020-06-01"><pozycja id="lom" oprocentowanie="9,00"/></pozycje>
      </stopy_procentowe_archiwum>`;
    expect(parseNbpArchive(xml)).toEqual([
      { observationDate: "2020-05-29", value: "0.0010", publishedOn: null },
    ]);
  });

  it.each([
    [
      "no reference rows",
      "<stopy_procentowe_archiwum></stopy_procentowe_archiwum>",
    ],
    ["a different document", "<html></html>"],
    [
      "a malformed date",
      '<stopy_procentowe_archiwum><pozycje obowiazuje_od="2020-13-40"><pozycja id="ref" oprocentowanie="1,00"/></pozycje></stopy_procentowe_archiwum>',
    ],
    [
      "a missing date",
      '<stopy_procentowe_archiwum><pozycje><pozycja id="ref" oprocentowanie="1,00"/></pozycje></stopy_procentowe_archiwum>',
    ],
    [
      "a malformed number",
      '<stopy_procentowe_archiwum><pozycje obowiazuje_od="2020-05-29"><pozycja id="ref" oprocentowanie="n/a"/></pozycje></stopy_procentowe_archiwum>',
    ],
  ])("refuses an archive with %s", (_name, xml) => {
    expect(() => parseNbpArchive(xml)).toThrow(BenchmarkFetchError);
  });

  it("refuses a current table without a usable reference row", () => {
    expect(() => parseNbpCurrent("<x/>")).toThrow(BenchmarkFetchError);
    expect(() =>
      parseNbpCurrent("<stopy_procentowe></stopy_procentowe>"),
    ).toThrow(/no reference/);
    expect(() =>
      parseNbpCurrent(
        '<stopy_procentowe><pozycja id="ref" oprocentowanie="3,75" obowiazuje_od="x"/></stopy_procentowe>',
      ),
    ).toThrow(/malformed date/);
  });

  it("merges by date, the later set winning, in date order", () => {
    const merged = mergeObservations(
      [
        { observationDate: "2026-03-05", value: "0.0400", publishedOn: null },
        { observationDate: "2026-01-01", value: "0.0450", publishedOn: null },
      ],
      [{ observationDate: "2026-03-05", value: "0.0375", publishedOn: null }],
    );
    expect(merged.map((o) => [o.observationDate, o.value])).toEqual([
      ["2026-01-01", "0.0450"],
      ["2026-03-05", "0.0375"],
    ]);
  });

  it("fetches both documents and covers through the fetch date", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: { status: 200, body: fixture("nbp-current.xml") },
    });
    const result = await fetchNbpReference(fetch, "2026-10-10");
    expect(result.coveredThrough).toBe("2026-10-10");
    expect(result.observations).toHaveLength(5);
    expect(result.sourceUrl).toBe(NBP_ARCHIVE_URL);
  });

  it("refuses a non-200 answer", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 503, body: new Uint8Array() },
    });
    await expect(fetchNbpReference(fetch, "2026-10-10")).rejects.toThrow(
      /HTTP 503/,
    );
  });

  const currentTable = (date: string, rate: string) =>
    bytes(
      `<stopy_procentowe data_publikacji="${date}"><tabela id="stoproc"><pozycja id="ref" oprocentowanie="${rate}" obowiazuje_od="${date}" /></tabela></stopy_procentowe>`,
    );

  it("adds a decision only the current table holds as the newest observation, citing the current table", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: {
        status: 200,
        body: currentTable("2026-10-08", "4,00"),
      },
    });
    const result = await fetchNbpReference(fetch, "2026-10-10");
    expect(result.observations).toHaveLength(6);
    // The archive ends at 2026-03-05: it may be missing a decision between that
    // and 2026-10-08, so nothing after its newest date is covered.
    expect(result.coveredThrough).toBe("2026-03-05");
    expect(result.observations[result.observations.length - 1]).toEqual({
      observationDate: "2026-10-08",
      value: "0.0400",
      publishedOn: "2026-10-08",
      sourceUrl: NBP_CURRENT_URL,
    });
    // Every row that came from the archive says so.
    expect(result.observations[0].sourceUrl).toBe(NBP_ARCHIVE_URL);
  });

  it("does not claim coverage up to today when the archive is a decision behind (archive ends at A, current table holds C)", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: {
        status: 200,
        body: currentTable("2026-07-09", "3,25"),
      },
    });
    const result = await fetchNbpReference(fetch, "2026-10-10");
    expect(result.coveredThrough).toBe("2026-03-05");
  });

  it("lets the current table's value win on a date both documents carry", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: {
        status: 200,
        body: currentTable("2026-03-05", "3,50"),
      },
    });
    const result = await fetchNbpReference(fetch, "2026-10-10");
    expect(result.observations).toHaveLength(5);
    // The archive carries the current table's date: nothing can be missing.
    expect(result.coveredThrough).toBe("2026-10-10");
    const row = result.observations.find(
      (o) => o.observationDate === "2026-03-05",
    );
    expect(row?.value).toBe("0.0350");
    expect(row?.sourceUrl).toBe(NBP_CURRENT_URL);
  });

  it("refuses a non-200 answer", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 503, body: new Uint8Array() },
    });
    await expect(fetchNbpReference(fetch, "2026-10-10")).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("refuses when only the current table answers non-200", async () => {
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: { status: 503, body: new Uint8Array() },
    });
    await expect(fetchNbpReference(fetch, "2026-10-10")).rejects.toThrow(
      /HTTP 503/,
    );
  });
});

describe("GUS CPI parser", () => {
  it("decodes windows-1250 and turns the index into a fraction", () => {
    const decoded = new TextDecoder("windows-1250").decode(
      fixture("gus-cpi.csv"),
    );
    const rows = parseGusCpiCsv(decoded);
    expect(rows.map((r) => [r.observationDate, r.value])).toEqual([
      ["2025-10-01", "0.0280"],
      ["2025-11-01", "0.0250"],
      ["2025-12-01", "0.0240"],
      ["2026-07-01", "0.0300"],
      ["2026-08-01", "0.0340"],
    ]);
  });

  it("skips empty values (unpublished months) and other presentations", () => {
    const rows = parseGusCpiCsv(
      new TextDecoder("windows-1250").decode(fixture("gus-cpi.csv")),
    );
    expect(rows.some((r) => r.observationDate === "2026-09-01")).toBe(false);
    expect(rows).toHaveLength(5);
  });

  it("skips a territory other than Polska and handles a negative change", () => {
    const csv = [
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;",
      "W;Mazowieckie;Analogiczny miesiąc poprzedniego roku = 100;2026;1;110,0;;;",
      "W;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;1;99,8;;;",
    ].join("\r\n");
    expect(parseGusCpiCsv(csv)).toEqual([
      { observationDate: "2026-01-01", value: "-0.0020", publishedOn: null },
    ]);
  });

  it.each([
    ["a changed header", "a;b;c\r\n"],
    [
      "no usable rows",
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;9;;;;\r\n",
    ],
    [
      "a malformed value",
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;9;x;;;\r\n",
    ],
    [
      "a malformed month",
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;13;103,0;;;\r\n",
    ],
    [
      "a duplicate month",
      "Nazwa zmiennej;Jednostka terytorialna;Sposób prezentacji;Rok;Miesiąc;Wartość;Flaga;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;1;103,0;;;\r\nW;Polska;Analogiczny miesiąc poprzedniego roku = 100;2026;1;103,1;;;\r\n",
    ],
  ])("refuses %s", (_name, csv) => {
    expect(() => parseGusCpiCsv(csv)).toThrow(BenchmarkFetchError);
  });

  it("finds the CSV link on the landing page, absolute or relative", () => {
    const html = `<a href="/x/other.csv">o</a><a href="/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">c</a>`;
    expect(findCsvLink(html)).toBe(
      "https://stat.gov.pl/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv",
    );
    // A relative href without a leading slash resolves against the landing page.
    expect(
      findCsvLink(
        '<a href="miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">',
      ),
    ).toMatch(/^https:\/\/stat\.gov\.pl\/obszary-tematyczne\/.*_9\.csv$/);
    expect(
      findCsvLink(
        '<a href="https://dane.stat.gov.pl/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">',
      ),
    ).toBe(
      "https://dane.stat.gov.pl/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv",
    );
    expect(findCsvLink("<a href='/x'>")).toBeNull();
  });

  it("never follows a link off stat.gov.pl, over plain http, or with a look-alike host", () => {
    const file =
      "miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv";
    for (const href of [
      `https://cdn.example/${file}`,
      `http://stat.gov.pl/download/${file}`,
      `//cdn.example/${file}`,
      `https://stat.gov.pl.evil.example/${file}`,
      `https://evilstat.gov.pl/${file}`,
      `https://stat.gov.pl:8443/${file}`,
      `https://user@stat.gov.pl/${file}`,
    ]) {
      expect(findCsvLink(`<a href="${href}">`)).toBeNull();
    }
    // A foreign link is skipped; a later link on the publisher's host is used.
    expect(
      findCsvLink(
        `<a href="https://cdn.example/${file}"><a href="/d/${file}">`,
      ),
    ).toBe(`https://stat.gov.pl/d/${file}`);
  });

  const NEXT_FILE =
    "https://stat.gov.pl/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv";
  const landingLinking = (href: string) => ({
    [GUS_CPI_LANDING_URL]: {
      status: 200,
      body: bytes(`<a href="${href}">`),
    },
  });
  // The fixture's newest month is 2026-08.
  const TODAY = "2026-10-11";

  it("does not use a foreign link found on the landing page, and falls back to the constant", async () => {
    const fetch = routes({
      ...landingLinking(
        "http://stat.gov.pl/d/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv",
      ),
      [GUS_CPI_CSV_URL]: { status: 200, body: fixture("gus-cpi.csv") },
    });
    const result = await fetchGusCpi(fetch, TODAY);
    expect(result.sourceUrl).toBe(GUS_CPI_CSV_URL);
  });

  it("falls back to the constant URL when the landing page cannot be read", async () => {
    const fetch = routes({
      [GUS_CPI_LANDING_URL]: { status: 503, body: new Uint8Array() },
      [GUS_CPI_CSV_URL]: { status: 200, body: fixture("gus-cpi.csv") },
    });
    const result = await fetchGusCpi(fetch, TODAY);
    expect(result.sourceUrl).toBe(GUS_CPI_CSV_URL);
  });

  it("covers through the newest month of the file the landing page links", async () => {
    const fetch = routes({
      ...landingLinking(
        "/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv",
      ),
      [NEXT_FILE]: { status: 200, body: fixture("gus-cpi.csv") },
    });
    const result = await fetchGusCpi(fetch, TODAY);
    expect(result.coveredThrough).toBe("2026-08-01");
    expect(result.sourceUrl).toBe(NEXT_FILE);
  });

  it("prefers the linked file even while the old numbered file still answers 200", async () => {
    const fetch = routes({
      ...landingLinking(
        "/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv",
      ),
      [NEXT_FILE]: { status: 200, body: fixture("gus-cpi.csv") },
      [GUS_CPI_CSV_URL]: { status: 200, body: bytes("stale") },
    });
    const result = await fetchGusCpi(fetch, TODAY);
    expect(result.sourceUrl).toBe(NEXT_FILE);
    expect(fetch).not.toHaveBeenCalledWith(GUS_CPI_CSV_URL);
  });

  it("refuses a file whose newest observation is more than 3 months old", async () => {
    const fetch = routes({
      [GUS_CPI_LANDING_URL]: { status: 404, body: new Uint8Array() },
      [GUS_CPI_CSV_URL]: { status: 200, body: fixture("gus-cpi.csv") },
    });
    // 2026-08-01 is exactly 3 months before 2026-11-01: still acceptable.
    await expect(fetchGusCpi(fetch, "2026-11-01")).resolves.toMatchObject({
      coveredThrough: "2026-08-01",
    });
    await expect(fetchGusCpi(fetch, "2026-11-02")).rejects.toThrow(
      /newest observation is 2026-08-01.*stale/,
    );
  });

  it("fails clearly when the file cannot be read", async () => {
    await expect(
      fetchGusCpi(
        routes({
          [GUS_CPI_LANDING_URL]: { status: 200, body: bytes("<html></html>") },
          [GUS_CPI_CSV_URL]: { status: 500, body: new Uint8Array() },
        }),
        TODAY,
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("Polish adapter contract", () => {
  it("declares two series, each under its own tracked provider", () => {
    expect(POLISH_BOND_ADAPTER.countryCode).toBe("PL");
    expect(
      POLISH_BOND_ADAPTER.benchmarks.map((b) => [b.code, b.kind, b.providerId]),
    ).toEqual([
      ["PL_NBP_REFERENCE", "STEP", "nbp"],
      ["PL_CPI_GUS_YOY", "MONTHLY", "gus"],
    ]);
  });

  it("declares the eight programs and no series", () => {
    expect(
      POLISH_BOND_ADAPTER.programs.map((p) => [
        p.issuerCountryCode,
        p.issuerCode,
        p.programCode,
        p.currency,
      ]),
    ).toEqual(
      ["OTS", "ROR", "DOR", "TOS", "COI", "ROS", "EDO", "ROD"].map((code) => [
        "PL",
        "PL_MF",
        code,
        "PLN",
      ]),
    );
    expect(POLISH_BOND_ADAPTER).not.toHaveProperty("catalog");
  });

  it("declares each program's face value from its template, and templateFaceValueOf finds it by the stored program's key (INV-BOND-005)", () => {
    for (const program of POLISH_BOND_ADAPTER.programs) {
      expect(program.faceValue).toBe("100.00");
      expect(templateFaceValueOf(program)).toBe("100.00");
    }
    expect(
      templateFaceValueOf({
        issuerCountryCode: "XX",
        issuerCode: "XX_MF",
        programCode: "EDO",
      }),
    ).toBeNull();
  });

  it("routes each series to its fetcher and refuses an unknown one", async () => {
    // Only the clock is faked: the CPI file's freshness is judged against today.
    jest.useFakeTimers({
      now: new Date("2026-10-11T08:00:00Z"),
      doNotFake: [
        "nextTick",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "queueMicrotask",
        "performance",
        "hrtime",
      ],
    });
    const fetch = routes({
      [NBP_ARCHIVE_URL]: { status: 200, body: fixture("nbp-archive.xml") },
      [NBP_CURRENT_URL]: { status: 200, body: fixture("nbp-current.xml") },
      [GUS_CPI_LANDING_URL]: { status: 404, body: new Uint8Array() },
      [GUS_CPI_CSV_URL]: { status: 200, body: fixture("gus-cpi.csv") },
    });
    expect(
      (await POLISH_BOND_ADAPTER.fetchBenchmark("PL_NBP_REFERENCE", fetch))
        .observations,
    ).toHaveLength(5);
    expect(
      (await POLISH_BOND_ADAPTER.fetchBenchmark("PL_CPI_GUS_YOY", fetch))
        .observations,
    ).toHaveLength(5);
    await expect(
      POLISH_BOND_ADAPTER.fetchBenchmark("X", fetch),
    ).rejects.toThrow(/no benchmark X/);
    jest.useRealTimers();
  });
});

describe("the Polish benchmark fetchers through the hardened door", () => {
  const health = {
    assertAvailable: jest.fn().mockReturnValue("open-gate"),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn().mockReturnValue(false),
    releaseProbe: jest.fn(),
  };
  const door = (code: string, http: jest.Mock) => {
    const series = POLISH_BOND_ADAPTER.benchmarks.find((b) => b.code === code);
    if (!series) throw new Error(`no benchmark ${code}`);
    return new SeriesHttp(health as unknown as ProviderHealthService).gated(
      series.providerId,
      http as unknown as typeof fetch,
      { allowedHosts: series.hosts },
    );
  };
  const answer = (table: Record<string, Uint8Array>) =>
    jest.fn(async (url: string) =>
      table[url]
        ? new Response(table[url] as unknown as BodyInit, { status: 200 })
        : new Response("missing", { status: 404 }),
    );

  it("declares the one host each publisher serves from", () => {
    expect(
      Object.fromEntries(
        POLISH_BOND_ADAPTER.benchmarks.map((b) => [b.code, b.hosts]),
      ),
    ).toEqual({
      PL_NBP_REFERENCE: ["static.nbp.pl"],
      PL_CPI_GUS_YOY: ["stat.gov.pl"],
    });
  });

  it("reads the NBP archive and current table with every request on the declared host", async () => {
    const http = answer({
      [NBP_ARCHIVE_URL]: fixture("nbp-archive.xml"),
      [NBP_CURRENT_URL]: fixture("nbp-current.xml"),
    });
    const result = await fetchNbpReference(
      door("PL_NBP_REFERENCE", http),
      "2026-10-10",
    );
    expect(result.observations).toHaveLength(5);
    expect(http.mock.calls.map((c) => c[0])).toEqual([
      NBP_ARCHIVE_URL,
      NBP_CURRENT_URL,
    ]);
  });

  it("reads the GUS landing page and the CSV it links, both on the declared host", async () => {
    const linked =
      "https://stat.gov.pl/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv";
    const http = answer({
      [GUS_CPI_LANDING_URL]: new TextEncoder().encode(
        `<a href="/download/gfx/a/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">`,
      ),
      [linked]: fixture("gus-cpi.csv"),
    });
    const result = await fetchGusCpi(
      door("PL_CPI_GUS_YOY", http),
      "2026-10-11",
    );
    expect(result.sourceUrl).toBe(linked);
  });

  it("refuses a GUS link to a subdomain: the door allows the declared host only", async () => {
    const http = answer({
      [GUS_CPI_LANDING_URL]: new TextEncoder().encode(
        `<a href="https://www.stat.gov.pl/d/miesiecznewskaznikicentowarowiuslugkonsumpcyjnychod1982roku_9.csv">`,
      ),
    });
    await expect(
      fetchGusCpi(door("PL_CPI_GUS_YOY", http), "2026-10-11"),
    ).rejects.toMatchObject({ name: "FetchRefusedError", reason: "host" });
  });
});
