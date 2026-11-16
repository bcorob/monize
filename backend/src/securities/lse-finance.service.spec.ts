import { Logger } from "@nestjs/common";
import { LseFinanceService } from "./lse-finance.service";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { createTestProviderHealth } from "../test-helpers/provider-health-testing";

/** A JSON response as the global `fetch` mock returns it. */
function jsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

const ALLDATA_USD = {
  tidm: "AGGU",
  isin: "IE00BZ043R46",
  description: "ISH GLOBAL AGG BOND ETF USD HEDGED ACC",
  name: "ISH GLOBAL AGG BOND ETF USD HEDGED ACC",
  currency: "USD",
  market: "MAINMARKET",
  instrumenttype: "ETF",
  lastprice: 5.748,
  openingprice: 5.745,
  high: 5.748,
  low: 5.745,
  volume: 10689,
  lastvolume: null,
  lastpricedate: "2026-09-24T07:07:54.000",
};

const AUTOCOMPLETE = {
  instruments: [
    {
      url: "https://www.londonstockexchange.com/stock/AGGU/ishares",
      code: "IE00BZ043R46",
      tidm: "AGGU",
      description: "ISHARES III PLC ISH GLOBAL AGG BOND ETF USD HEDGED ACC",
      category: "ETFS",
      islse: true,
    },
    {
      url: "https://www.londonstockexchange.com/turquoise-stock/E:AGGUL",
      code: "IE00BZ043R46",
      tidm: "AGGUL",
      description: "ISHARES CORE GLB AGG USD-H A",
      category: "TURQUOISE",
      islse: null,
    },
  ],
  issuers: [],
  news: [],
};

const SAML = { encodedToken: "ENCODED_SAML" };
const SESSION = { sid: "sid-1", token: "jwt-token", expiresAt: 4102444800 };
const TIMESERIES = {
  request: { ric: "AGGU.L" },
  data: [
    {
      _DATE_END: "2026-03-02",
      CLOSE_PRC: "5.874",
      OPEN_PRC: "5.87",
      HIGH_1: "5.88",
      LOW_1: "5.86",
    },
    { _DATE_END: "2026-05-04", CLOSE_PRC: "-" },
    { _DATE_END: "2026-07-01", CLOSE_PRC: "5.857" },
  ],
  status: "OK",
};

/**
 * A `fetch` that answers by URL substring, so one arrange covers the whole
 * translate/SAML/session/timeseries chain.
 */
function routeFetch(
  overrides: Partial<Record<string, () => Response>> = {},
): jest.Mock {
  return jest.fn((url: string) => {
    if (url.includes("/search/autocomplete")) {
      return Promise.resolve(
        (overrides.autocomplete ?? (() => jsonResponse(AUTOCOMPLETE)))(),
      );
    }
    if (url.includes("/instruments/alldata/")) {
      return Promise.resolve(
        (overrides.alldata ?? (() => jsonResponse(ALLDATA_USD)))(),
      );
    }
    if (url.includes("/feedhandler/token/saml")) {
      return Promise.resolve((overrides.saml ?? (() => jsonResponse(SAML)))());
    }
    if (url.includes("/sessions/samllogin")) {
      return Promise.resolve(
        (overrides.session ?? (() => jsonResponse(SESSION)))(),
      );
    }
    if (url.includes("/timeseries/historical")) {
      return Promise.resolve(
        (overrides.timeseries ?? (() => jsonResponse(TIMESERIES)))(),
      );
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

describe("LseFinanceService", () => {
  let service: LseFinanceService;
  let health: ProviderHealthService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    health = createTestProviderHealth();
    service = new LseFinanceService(health);
    originalFetch = global.fetch;
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("names itself lse", () => {
    expect(service.name).toBe("lse");
  });

  describe("fetchQuote", () => {
    it("maps the instrument master record to a quote", async () => {
      global.fetch = routeFetch();
      const quote = await service.fetchQuote("AGGU");
      expect(quote).toMatchObject({
        symbol: "AGGU",
        regularMarketPrice: 5.748,
        regularMarketOpen: 5.745,
        regularMarketDayHigh: 5.748,
        regularMarketDayLow: 5.745,
        regularMarketVolume: 10689,
        currencyCode: "USD",
        provider: "lse",
        exchangeTimezone: "Europe/London",
      });
      expect(quote?.regularMarketTime).toBeGreaterThan(0);
    });

    it("divides a GBX-quoted instrument into pounds and reports GBP", async () => {
      global.fetch = routeFetch({
        alldata: () =>
          jsonResponse({ ...ALLDATA_USD, currency: "GBX", lastprice: 550 }),
      });
      const quote = await service.fetchQuote("VOD");
      expect(quote?.regularMarketPrice).toBeCloseTo(5.5, 5);
      expect(quote?.currencyCode).toBe("GBP");
    });

    it("returns null when the instrument has no price", async () => {
      global.fetch = routeFetch({
        alldata: () => jsonResponse({ ...ALLDATA_USD, lastprice: null }),
      });
      expect(await service.fetchQuote("AGGU")).toBeNull();
    });

    it("returns null on a 404 instrument", async () => {
      global.fetch = routeFetch({
        alldata: () => jsonResponse({}, false, 404),
      });
      expect(await service.fetchQuote("NOPE")).toBeNull();
    });

    it("omits regularMarketTime when lastpricedate is unparseable", async () => {
      global.fetch = routeFetch({
        alldata: () =>
          jsonResponse({ ...ALLDATA_USD, lastpricedate: "24/09/2026 09:00" }),
      });
      const quote = await service.fetchQuote("AGGU");
      expect(quote).not.toBeNull();
      expect(quote?.regularMarketTime).toBeUndefined();
    });
  });

  describe("fetchHistoricalWindowSeries", () => {
    it("returns the daily OHLC bundle with the instrument currency", async () => {
      global.fetch = routeFetch();
      const series = await service.fetchHistoricalWindowSeries(
        "AGGU",
        null,
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-07-01T00:00:00Z"),
      );
      expect(series).not.toBeNull();
      expect(series!.currencyCode).toBe("USD");
      expect(series!.symbol).toBe("AGGU");
      // The "-" bar (2026-05-04) is dropped, not stored as a zero.
      expect(series!.prices).toHaveLength(2);
      expect(series!.prices[0]).toMatchObject({
        close: 5.874,
        open: 5.87,
        high: 5.88,
        low: 5.86,
        adjClose: null,
        volume: null,
      });
      expect(series!.prices[0].date.toISOString()).toBe(
        "2026-03-02T00:00:00.000Z",
      );
    });

    it("converts GBX bars to pounds", async () => {
      global.fetch = routeFetch({
        alldata: () => jsonResponse({ ...ALLDATA_USD, currency: "GBp" }),
        timeseries: () =>
          jsonResponse({
            data: [{ _DATE_END: "2026-07-01", CLOSE_PRC: "550" }],
            status: "OK",
          }),
      });
      const series = await service.fetchHistoricalWindowSeries(
        "VOD",
        null,
        new Date("2026-06-01T00:00:00Z"),
        new Date("2026-07-01T00:00:00Z"),
      );
      expect(series!.currencyCode).toBe("GBP");
      expect(series!.prices[0].close).toBeCloseTo(5.5, 5);
    });

    it("withholds the series when the instrument currency is unknown", async () => {
      // Timeseries answers, but the separate instrument fetch has no currency:
      // storing GBX bars unconverted would be a 100x error, so answer nothing.
      global.fetch = routeFetch({ alldata: () => jsonResponse({}) });
      const series = await service.fetchHistoricalWindowSeries(
        "AGGU",
        null,
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-07-01T00:00:00Z"),
      );
      expect(series).toBeNull();
    });

    it("returns null when the SAML session cannot be minted", async () => {
      global.fetch = routeFetch({
        session: () => jsonResponse({}, false, 500),
      });
      const series = await service.fetchHistoricalWindowSeries(
        "AGGU",
        null,
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-07-01T00:00:00Z"),
      );
      expect(series).toBeNull();
    });

    it("drops the cached token and returns null on a 401", async () => {
      global.fetch = routeFetch({
        timeseries: () => jsonResponse({}, false, 401),
      });
      const series = await service.fetchHistoricalWindowSeries(
        "AGGU",
        null,
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-07-01T00:00:00Z"),
      );
      expect(series).toBeNull();
      expect((service as unknown as { token: string | null }).token).toBeNull();
    });

    it("reuses a cached token across calls", async () => {
      const fetchMock = routeFetch();
      global.fetch = fetchMock;
      await service.fetchHistoricalWindowSeries(
        "AGGU",
        null,
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-07-01T00:00:00Z"),
      );
      await service.fetchHistoricalWindowSeries(
        "AGGU",
        null,
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-07-01T00:00:00Z"),
      );
      const samlCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/feedhandler/token/saml"),
      );
      expect(samlCalls).toHaveLength(1);
    });
  });

  describe("fetchHistoricalSeries", () => {
    it.each(["max", "5d", "6mo", "2y", "garbage"])(
      "maps the %s range onto a window and answers",
      async (range) => {
        global.fetch = routeFetch();
        const series = await service.fetchHistoricalSeries("AGGU", null, range);
        expect(series).not.toBeNull();
        expect(series!.prices.length).toBeGreaterThan(0);
      },
    );
  });

  describe("degraded upstreams", () => {
    it("returns null when the SAML artifact request fails", async () => {
      global.fetch = routeFetch({ saml: () => jsonResponse({}, false, 502) });
      const series = await service.fetchHistoricalSeries("AGGU", null, "1y");
      expect(series).toBeNull();
    });

    it("returns null when the SAML artifact is empty", async () => {
      global.fetch = routeFetch({ saml: () => jsonResponse({}) });
      const series = await service.fetchHistoricalSeries("AGGU", null, "1y");
      expect(series).toBeNull();
    });

    it("treats a 5xx instrument response as no quote", async () => {
      global.fetch = routeFetch({
        alldata: () => jsonResponse({}, false, 500),
      });
      expect(await service.fetchQuote("AGGU")).toBeNull();
    });

    it("returns null when the SAML chain throws", async () => {
      global.fetch = jest.fn((url: string) =>
        String(url).includes("/instruments/alldata/")
          ? Promise.resolve(jsonResponse(ALLDATA_USD))
          : Promise.reject(new Error("network down")),
      );
      expect(
        await service.fetchHistoricalSeries("AGGU", null, "1y"),
      ).toBeNull();
    });

    it("returns null when the timeseries request throws", async () => {
      global.fetch = jest.fn((url: string) => {
        const u = String(url);
        if (u.includes("/timeseries/historical")) {
          return Promise.reject(new Error("network down"));
        }
        if (u.includes("/instruments/alldata/")) {
          return Promise.resolve(jsonResponse(ALLDATA_USD));
        }
        if (u.includes("/feedhandler/token/saml")) {
          return Promise.resolve(jsonResponse(SAML));
        }
        if (u.includes("/sessions/samllogin")) {
          return Promise.resolve(jsonResponse(SESSION));
        }
        return Promise.resolve(jsonResponse({}, false, 404));
      });
      expect(
        await service.fetchHistoricalSeries("AGGU", null, "1y"),
      ).toBeNull();
    });
  });

  describe("lookupSecurity", () => {
    it("resolves an instrument to a lookup result", async () => {
      global.fetch = routeFetch();
      const result = await service.lookupSecurity("AGGU");
      expect(result).toMatchObject({
        symbol: "AGGU",
        exchange: "MAINMARKET",
        currencyCode: "USD",
        provider: "lse",
      });
    });

    it("returns null for an unknown instrument", async () => {
      global.fetch = routeFetch({
        autocomplete: () => jsonResponse({ instruments: [] }),
        alldata: () => jsonResponse({}, false, 404),
      });
      expect(await service.lookupSecurity("NOPE")).toBeNull();
    });

    it("finds the LSE listing by ISIN through search autocomplete", async () => {
      global.fetch = routeFetch();
      const results = await service.lookupSecurityMany("IE00BZ043R46");
      // Only the real LSE listing (islse true) is kept; the Turquoise mirror is
      // dropped, and the candidate carries the currency from its master record.
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        symbol: "AGGU",
        currencyCode: "USD",
        exchange: "MAINMARKET",
        provider: "lse",
      });
    });

    it("returns nothing when search has no LSE match", async () => {
      global.fetch = routeFetch({
        autocomplete: () => jsonResponse({ instruments: [] }),
      });
      expect(await service.lookupSecurityMany("ZZZ")).toEqual([]);
    });
  });

  it("has no sector information", async () => {
    expect(await service.fetchStockSectorInfo()).toBeNull();
    expect(await service.fetchEtfSectorWeightings()).toBeNull();
  });

  it("derives the trading date from the quote", async () => {
    global.fetch = routeFetch();
    const quote = await service.fetchQuote("AGGU");
    const date = service.getTradingDate(quote!);
    expect(date).toBeInstanceOf(Date);
  });

  it("returns no answer when the network fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    expect(await service.fetchQuote("AGGU")).toBeNull();
  });
});
