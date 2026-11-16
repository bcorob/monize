import { SeriesFetchError } from "../../../bond-adapter";
import { POLISH_BOND_ADAPTER } from "..";
import coi from "../fixtures/series/coi1030.terms.json";
import dor from "../fixtures/series/dor1028.terms.json";
import edo from "../fixtures/series/edo1036.terms.json";
import ots from "../fixtures/series/ots0127.terms.json";
import rod from "../fixtures/series/rod1038.terms.json";
import ror from "../fixtures/series/ror1027.terms.json";
import ros from "../fixtures/series/ros1032.terms.json";
import tos from "../fixtures/series/tos1029.terms.json";
import {
  fakeFetch,
  fakePdfText,
  letterFixture,
  letterHref,
  PDF_PREFIX,
  pageFixture,
  SITE,
  SLUGS,
  seriesRoutes,
} from "./fixture-helpers";
import { fetchSeries } from "./fetch-series";
import { extractPdfText } from "../../../../common/pdf-text";

jest.mock("../../../../common/pdf-text", () => ({ extractPdfText: jest.fn() }));

const NOW = new Date("2026-10-11T08:00:00.000Z");
const now = () => NOW;

beforeEach(() => {
  (extractPdfText as jest.Mock).mockImplementation(async (b: Uint8Array) =>
    fakePdfText(b),
  );
});

const slugOf = (code: string) => SLUGS[code.slice(0, 3)];
const pageUrl = (code: string) =>
  `${SITE}/oferta-obligacji/${slugOf(code)}/${code.toLowerCase()}/`;

async function failureOf(promise: Promise<unknown>): Promise<SeriesFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SeriesFetchError);
    return error as SeriesFetchError;
  }
  throw new Error("expected a SeriesFetchError");
}

function serve(
  code: string,
  overrides: { page?: string; letter?: string } = {},
) {
  return fakeFetch(seriesRoutes(code, slugOf(code), overrides));
}

const withoutSource = (terms: unknown) => {
  const { source: _source, ...rest } = terms as Record<string, unknown>;
  return rest;
};

describe("fetchSeries: equivalence with the curated October 2026 manifests", () => {
  it.each([
    ["EDO1036", edo],
    ["ROR1027", ror],
    ["TOS1029", tos],
    ["OTS0127", ots],
    ["COI1030", coi],
    ["DOR1028", dor],
    ["ROS1032", ros],
    ["ROD1038", rod],
  ])(
    "%s fetched from saved sources equals its manifest except source",
    async (code, manifest) => {
      const { entry, sources } = await fetchSeries(code, serve(code), now);
      expect(withoutSource(entry.terms)).toEqual(withoutSource(manifest));
      expect(entry.termsVersion).toBe(1);
      expect(entry.publishedAt).toBe("2026-09-21");
      expect((entry.terms as { source: unknown }).source).toEqual({
        provider: "obligacjeskarbowe.pl",
        url: pageUrl(code),
        document: (manifest.source as { document: string }).document,
      });
      expect(sources).toEqual([
        {
          provider: "obligacjeskarbowe.pl",
          url: pageUrl(code),
          retrievedAt: NOW.toISOString(),
        },
        {
          provider: "obligacjeskarbowe.pl",
          url: `${SITE}${letterHref(pageFixture(code))}`,
          retrievedAt: NOW.toISOString(),
        },
      ]);
    },
  );

  it("is what the Polish adapter exposes", async () => {
    const result = await POLISH_BOND_ADAPTER.fetchSeries!(
      "ror1027",
      serve("ROR1027"),
    );
    expect(result.entry.termsVersion).toBe(1);
    expect(POLISH_BOND_ADAPTER.manualSeries).toBeDefined();
  });

  it("reads an older series of the same product: EDO0934", async () => {
    const { entry } = await fetchSeries("EDO0934", serve("EDO0934"), now);
    const terms = entry.terms as {
      saleWindow: unknown;
      rateRule: Record<string, unknown>;
      redemption: { penalties: unknown[] };
      source: { document: string };
    };
    expect(entry.publishedAt).toBe("2024-08-22");
    expect(terms.saleWindow).toEqual({ from: "2024-09-01", to: "2024-09-30" });
    expect(terms.rateRule).toMatchObject({
      firstPeriodRate: "0.0655",
      margin: "0.0200",
    });
    expect(terms.redemption.penalties).toEqual([
      { type: "FIXED_FEE_PER_UNIT", amount: "3.00" },
    ]);
    expect(terms.source.document).toBe("List emisyjny nr 96/2024");
  });
});

describe("fetchSeries: refusals", () => {
  it("refuses a malformed code before any request", async () => {
    const get = serve("EDO1036");
    const error = await failureOf(fetchSeries("EDO1336", get, now));
    expect(error.code).toBe("SERIES_CODE_INVALID");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses a series older than the template was checked for, before any request", async () => {
    const get = serve("EDO1036");
    const error = await failureOf(fetchSeries("EDO0123", get, now));
    expect(error.code).toBe("TEMPLATE_NOT_VALIDATED");
    expect(error.params).toEqual({
      product: "EDO",
      saleMonth: "2013-01",
      validFrom: "2024-01",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("says a 404 is a series that is not published", async () => {
    const get = fakeFetch({
      [pageUrl("EDO1036")]: { status: 404, body: new Uint8Array() },
    });
    expect((await failureOf(fetchSeries("EDO1036", get, now))).code).toBe(
      "SERIES_NOT_PUBLISHED",
    );
  });

  it("says a page that names another series is not the requested one", async () => {
    const other = pageFixture("EDO1036").replace("EDO1036", "EDO1136");
    const error = await failureOf(
      fetchSeries("EDO1036", serve("EDO1036", { page: other }), now),
    );
    expect(error.code).toBe("SERIES_NOT_PUBLISHED");
  });

  it("says a page without a Seria field is not published", async () => {
    const error = await failureOf(
      fetchSeries(
        "EDO1036",
        serve("EDO1036", {
          page: "<html><body>Strona nie istnieje</body></html>",
        }),
        now,
      ),
    );
    expect(error.code).toBe("SERIES_NOT_PUBLISHED");
  });

  it.each([
    ["a server error", { status: 503, body: new Uint8Array() }, "status"],
    ["a redirect status", { status: 302, body: new Uint8Array() }, "status"],
  ])(
    "treats %s as the source being unavailable",
    async (_name, served, reason) => {
      const get = fakeFetch({ [pageUrl("EDO1036")]: served });
      const error = await failureOf(fetchSeries("EDO1036", get, now));
      expect(error.code).toBe("SOURCE_UNAVAILABLE");
      expect(error.params.reason).toBe(reason);
    },
  );

  it("treats a network failure as the source being unavailable", async () => {
    const get = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const error = await failureOf(fetchSeries("EDO1036", get, now));
    expect(error.code).toBe("SOURCE_UNAVAILABLE");
    expect(error.params.reason).toBe("network");
    expect((error.cause as Error).message).toBe("ECONNRESET");
  });

  it("gives up on a request that does not answer within 30 seconds", async () => {
    jest.useFakeTimers();
    try {
      const get = jest.fn(() => new Promise<never>(() => undefined));
      const pending = failureOf(fetchSeries("EDO1036", get, now));
      await jest.advanceTimersByTimeAsync(30_001);
      const error = await pending;
      expect(error.code).toBe("SOURCE_UNAVAILABLE");
      expect(error.params.reason).toBe("network");
    } finally {
      jest.useRealTimers();
    }
  });

  // Deliberately changed: this test used to pin a letter 404 as
  // SOURCE_UNAVAILABLE, which stopped the whole backfill pass on one missing
  // letter. A permanent 4xx on a series' own document refuses that series only.
  it("refuses a series whose letter answers a permanent 4xx, as its own refusal", async () => {
    const routes = seriesRoutes("EDO1036", slugOf("EDO1036"));
    routes[`${SITE}${letterHref(pageFixture("EDO1036"))}`] = {
      status: 404,
      body: new Uint8Array(),
    };
    const error = await failureOf(
      fetchSeries("EDO1036", fakeFetch(routes), now),
    );
    expect(error.code).toBe("SOURCE_DOCUMENT_MISSING");
    expect(error.params).toEqual({ document: "letter", status: "404" });
  });

  it.each([503, 429])(
    "keeps a letter answering %s as the source being unavailable",
    async (status) => {
      const routes = seriesRoutes("EDO1036", slugOf("EDO1036"));
      routes[`${SITE}${letterHref(pageFixture("EDO1036"))}`] = {
        status,
        body: new Uint8Array(),
      };
      const error = await failureOf(
        fetchSeries("EDO1036", fakeFetch(routes), now),
      );
      expect(error.code).toBe("SOURCE_UNAVAILABLE");
      expect(error.params.status).toBe(String(status));
    },
  );

  it("refuses a series page answering 403 as a missing document, not as the source being down", async () => {
    const get = fakeFetch({
      [pageUrl("EDO1036")]: { status: 403, body: new Uint8Array() },
    });
    const error = await failureOf(fetchSeries("EDO1036", get, now));
    expect(error.code).toBe("SOURCE_DOCUMENT_MISSING");
    expect(error.params).toEqual({ document: "page", status: "403" });
  });

  it("refuses a page over 2 MB and a letter over 5 MB", async () => {
    const big = (bytes: number) => new Uint8Array(bytes);
    const pageRoutes = seriesRoutes("EDO1036", slugOf("EDO1036"));
    pageRoutes[pageUrl("EDO1036")] = {
      status: 200,
      body: big(2 * 1024 * 1024 + 1),
    };
    const pageError = await failureOf(
      fetchSeries("EDO1036", fakeFetch(pageRoutes), now),
    );
    expect(pageError.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(pageError.params.field).toBe("size");

    const pdfRoutes = seriesRoutes("EDO1036", slugOf("EDO1036"));
    pdfRoutes[`${SITE}${letterHref(pageFixture("EDO1036"))}`] = {
      status: 200,
      body: big(5 * 1024 * 1024 + 1),
    };
    const pdfError = await failureOf(
      fetchSeries("EDO1036", fakeFetch(pdfRoutes), now),
    );
    expect(pdfError.params.field).toBe("size");
  });

  it("refuses a body that is not a PDF and a PDF whose text cannot be read", async () => {
    const routes = seriesRoutes("EDO1036", slugOf("EDO1036"));
    const letterUrl = `${SITE}${letterHref(pageFixture("EDO1036"))}`;
    routes[letterUrl] = {
      status: 200,
      body: new TextEncoder().encode("<html>login</html>"),
    };
    const notPdf = await failureOf(
      fetchSeries("EDO1036", fakeFetch(routes), now),
    );
    expect(notPdf.params.field).toBe("letterPdf");

    routes[letterUrl] = {
      status: 200,
      body: new TextEncoder().encode(PDF_PREFIX),
    };
    (extractPdfText as jest.Mock).mockRejectedValueOnce(new Error("bad xref"));
    const unreadable = await failureOf(
      fetchSeries("EDO1036", fakeFetch(routes), now),
    );
    expect(unreadable.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(unreadable.params.field).toBe("letterText");
  });
});

describe("fetchSeries: hosts", () => {
  const letterPath = letterHref(pageFixture("EDO1036"));

  it.each([
    ["another host", "https://evil.example/media_files/a.pdf"],
    ["a protocol-relative link", "//evil.example/media_files/a.pdf"],
    ["plain http", "http://www.obligacjeskarbowe.pl/media_files/a.pdf"],
    ["a subdomain", "https://zakup.obligacjeskarbowe.pl/media_files/a.pdf"],
    ["a port", "https://www.obligacjeskarbowe.pl:8443/media_files/a.pdf"],
    ["credentials", "https://user@www.obligacjeskarbowe.pl/media_files/a.pdf"],
    ["a path outside media_files", "/files/a.pdf"],
    ["a traversal out of media_files", "/media_files/../secret.pdf"],
    ["a file that is not a PDF", "/media_files/a.html"],
  ])("never follows a letter link to %s", async (_name, href) => {
    const page = pageFixture("EDO1036").replace(letterPath, href);
    const get = serve("EDO1036", { page });
    const error = await failureOf(fetchSeries("EDO1036", get, now));
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe("letterLink");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("accepts an absolute link on the issuer's host", async () => {
    const page = pageFixture("EDO1036").replace(
      letterPath,
      `${SITE}${letterPath}`,
    );
    const { entry } = await fetchSeries(
      "EDO1036",
      serve("EDO1036", { page }),
      now,
    );
    expect(entry.termsVersion).toBe(1);
  });

  it("refuses an answer that came from another host after a redirect", async () => {
    const get = fakeFetch({
      [pageUrl("EDO1036")]: {
        status: 200,
        body: new TextEncoder().encode(pageFixture("EDO1036")),
        url: "https://evil.example/oferta-obligacji/x/",
      },
    });
    const error = await failureOf(fetchSeries("EDO1036", get, now));
    expect(error.code).toBe("SOURCE_UNAVAILABLE");
    expect(error.params.reason).toBe("redirect");
  });

  it("accepts an answer that reports the requested address as its own", async () => {
    const routes = seriesRoutes("EDO1036", slugOf("EDO1036"));
    routes[pageUrl("EDO1036")] = {
      ...routes[pageUrl("EDO1036")],
      url: pageUrl("EDO1036"),
    };
    await expect(
      fetchSeries("EDO1036", fakeFetch(routes), now),
    ).resolves.toBeDefined();
  });
});

describe("fetchSeries: page and letter must agree", () => {
  const cases: Array<
    [
      string,
      (page: string, letter: string) => { page?: string; letter?: string },
      Record<string, string>,
    ]
  > = [
    [
      "the first-period rate",
      (page) => ({ page: page.replace("5,35%", "5,36%") }),
      { field: "firstPeriodRate", page: "0.0536", letter: "0.0535" },
    ],
    [
      "the margin",
      (page) => ({ page: page.replace("marża 2,00%", "marża 2,10%") }),
      { field: "margin", page: "0.0210", letter: "0.0200" },
    ],
    [
      "a page sale window reaching outside the letter's",
      (_page, letter) => ({
        letter: letter.replace(
          "od 1 do 31 października",
          "od 1 do 30 października",
        ),
      }),
      {
        field: "saleWindow",
        page: "2026-10-01/2026-10-31",
        letter: "2026-10-01/2026-10-30",
      },
    ],
    [
      "the series the letter issues",
      (_page, letter) => ({ letter: letter.replace("EDO1036", "EDO1136") }),
      { field: "seriesCode", page: "EDO1036", letter: "EDO1136" },
    ],
    [
      "the price against the nominal",
      (page) => ({ page: page.replace("100,00", "99,00") }),
      { field: "faceValue", page: "99.00", letter: "100.00" },
    ],
  ];

  it.each(cases)(
    "refuses a disagreement in %s with both values",
    async (_name, mutate, params) => {
      const overrides = mutate(
        pageFixture("EDO1036"),
        letterFixture("EDO1036"),
      );
      const error = await failureOf(
        fetchSeries("EDO1036", serve("EDO1036", overrides), now),
      );
      expect(error.code).toBe("SOURCE_INCONSISTENT");
      expect(error.params).toEqual(params);
    },
  );

  it("stores the letter's sale window when the page states a day short (EDO0734, July 2024)", async () => {
    const page = pageFixture("EDO1036").replace("31.10.2026", "30.10.2026");
    const { entry } = await fetchSeries(
      "EDO1036",
      serve("EDO1036", { page }),
      now,
    );
    expect((entry.terms as { saleWindow: unknown }).saleWindow).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  it("refuses a spread that differs between page and letter", async () => {
    const page = pageFixture("DOR1028").replace("NBP+0,15%", "NBP+0,25%");
    const error = await failureOf(
      fetchSeries("DOR1028", serve("DOR1028", { page }), now),
    );
    expect(error.params).toEqual({
      field: "spread",
      page: "0.0025",
      letter: "0.0015",
    });
  });

  it("refuses a letter dated on or after the first day of sale", async () => {
    const letter = letterFixture("EDO1036").replace(
      "z dnia 21 września 2026 r.",
      "z dnia 1 października 2026 r.",
    );
    const error = await failureOf(
      fetchSeries("EDO1036", serve("EDO1036", { letter }), now),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("letterDate");
  });

  it("refuses a rate over 25 percent on both sides", async () => {
    const error = await failureOf(
      fetchSeries(
        "EDO1036",
        serve("EDO1036", {
          page: pageFixture("EDO1036").replace("5,35%", "35,00%"),
          letter: letterFixture("EDO1036").replace("5,35%", "35,00%"),
        }),
        now,
      ),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params).toEqual({
      field: "firstPeriodRate",
      value: "0.3500",
      expected: "0<x<=0.25",
    });
  });

  it("refuses a margin over 5 percent and a fee over 10 zloty", async () => {
    const margin = await failureOf(
      fetchSeries(
        "EDO1036",
        serve("EDO1036", {
          page: pageFixture("EDO1036").replace("marża 2,00%", "marża 6,00%"),
          letter: letterFixture("EDO1036").replace(
            "marżę w wysokości 2,00%",
            "marżę w wysokości 6,00%",
          ),
        }),
        now,
      ),
    );
    expect(margin.params.field).toBe("margin");

    const fee = await failureOf(
      fetchSeries(
        "EDO1036",
        serve("EDO1036", {
          letter: letterFixture("EDO1036").replace(
            "nie wyższą niż 3,00 zł",
            "nie wyższą niż 30,00 zł",
          ),
        }),
        now,
      ),
    );
    expect(fee.params).toEqual({
      field: "fee",
      value: "30.00",
      expected: "0<=x<=10",
    });
  });

  it("names the fee when a product that charges one has none in its letter", async () => {
    const letter = letterFixture("EDO1036").replace(
      /nie wyższą niż/g,
      "nie większą niż",
    );
    const error = await failureOf(
      fetchSeries("EDO1036", serve("EDO1036", { letter }), now),
    );
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe("fee");
  });

  it("refuses a series whose rate is no longer of the template's shape", async () => {
    const page = pageFixture("EDO1036").replace(
      "marża 2,00% + inflacja",
      "stałe",
    );
    const error = await failureOf(
      fetchSeries("EDO1036", serve("EDO1036", { page }), now),
    );
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe("rateRule");
  });
});
