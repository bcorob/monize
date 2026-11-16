import { Logger } from "@nestjs/common";
import {
  DeutscheBoerseFinanceService,
  WebSocketLike,
  boerseSecurityHeaders,
} from "./deutsche-boerse-finance.service";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { createTestProviderHealth } from "../test-helpers/provider-health-testing";

function jsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

const TOKEN = { token: "header.payload.sig" };
const CURRENCY = [{ currency: "EUR", isin: "IE00B6R52259" }];
// The global search wraps hits in nested arrays, exactly as the site returns.
const SEARCH = [
  [
    {
      isin: "IE00B6R52259",
      wkn: null,
      symbol: "IUSQ",
      name: {
        originalValue: "iShares MSCI All Country World UCITS ETF USD (Acc)",
      },
      type: "ETP",
      typeName: { originalValue: "ETP" },
      currency: "EUR",
    },
  ],
];

// The data sheet is ISIN-keyed and carries the ticker (exchangeSymbol).
const DATA_SHEET = {
  exchangeSymbol: "IUSQ",
  instrumentName: {
    originalValue: "iShares MSCI All Country World UCITS ETF USD (Acc)",
  },
  instrumentTypeKey: "etf",
  isin: "IE00B6R52259",
};
const FRAMES = [
  {
    date: "2025-09-23",
    open: 89.24,
    high: 89.44,
    low: 89.18,
    close: 89.27,
    quantity: 120499,
  },
  {
    date: "2025-09-24",
    open: 89.04,
    high: 89.36,
    low: 88.9,
    close: 89.13,
    quantity: 72774,
  },
];

function routeFetch(
  overrides: Partial<Record<string, () => Response>> = {},
): jest.Mock {
  return jest.fn((url: string) => {
    if (url.includes("/mdstokenservice/token")) {
      return Promise.resolve(
        (overrides.token ?? (() => jsonResponse(TOKEN)))(),
      );
    }
    if (url.includes("/v1/data/currency")) {
      return Promise.resolve(
        (overrides.currency ?? (() => jsonResponse(CURRENCY)))(),
      );
    }
    if (url.includes("/v1/global_search/")) {
      return Promise.resolve(
        (overrides.search ?? (() => jsonResponse(SEARCH)))(),
      );
    }
    if (url.includes("/v1/data/data_sheet_header")) {
      return Promise.resolve(
        (overrides.dataSheet ?? (() => jsonResponse(DATA_SHEET)))(),
      );
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

/**
 * A fake socket that drives the listTimeseries exchange to completion without a
 * real connection: it opens, answers the auth message with `dataAuthentication`,
 * streams the frames it was given for the timeseries request, then closes.
 */
class FakeSocket implements WebSocketLike {
  private readonly listeners: Record<
    string,
    Array<(e: { data?: unknown }) => void>
  > = {};
  sent: string[] = [];

  constructor(private readonly frames: unknown[]) {
    setTimeout(() => this.emit("open", {}), 0);
  }

  addEventListener(
    type: string,
    listener: (e: { data?: unknown }) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const l of this.listeners[type] ?? []) l(event);
  }

  send(data: string): void {
    this.sent.push(data);
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.subscribeAuthentication) {
      setTimeout(
        () =>
          this.emit("message", {
            data: JSON.stringify({
              requestId: "monize-auth",
              dataAuthentication: { validUntil: "2026-01-01T00:00:00Z" },
            }),
          }),
        0,
      );
      return;
    }
    if (parsed.listTimeseries) {
      setTimeout(() => {
        for (const frame of this.frames) {
          this.emit("message", {
            data: JSON.stringify({
              requestId: "monize-ts",
              dataTimeseries: frame,
            }),
          });
        }
        // A non-timeseries frame and a garbage frame are both ignored.
        this.emit("message", { data: JSON.stringify({ other: true }) });
        this.emit("message", { data: "not json" });
        this.emit("close", {});
      }, 0);
    }
  }

  close(): void {
    // Nothing to tear down for the fake.
  }
}

/** A socket that opens and then errors, exercising the error path. */
class ErrorSocket implements WebSocketLike {
  private readonly listeners: Record<
    string,
    Array<(e: { data?: unknown }) => void>
  > = {};

  constructor() {
    setTimeout(() => {
      this.emit("open");
      this.emit("error");
    }, 0);
  }

  addEventListener(
    type: string,
    listener: (e: { data?: unknown }) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }

  private emit(type: string): void {
    for (const l of this.listeners[type] ?? []) l({});
  }

  send(): void {
    // Ignored; this socket errors before it can answer.
  }

  close(): void {
    // Nothing to tear down.
  }
}

describe("DeutscheBoerseFinanceService", () => {
  let service: DeutscheBoerseFinanceService;
  let health: ProviderHealthService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    health = createTestProviderHealth();
    service = new DeutscheBoerseFinanceService(health);
    originalFetch = global.fetch;
    service.wsFactory = () => new FakeSocket(FRAMES);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("names itself deutsche_boerse", () => {
    expect(service.name).toBe("deutsche_boerse");
  });

  describe("boerseSecurityHeaders", () => {
    // Verified byte-for-byte against the captured token request: the site sent
    // Client-Date 2026-09-24T09:21:48+02:00 for the instant 07:21:48.596Z, and
    // the two md5 headers below.
    it("reproduces the site's request signature exactly", () => {
      const h = boerseSecurityHeaders(
        "https://api.live.deutsche-boerse.com/v1/mdstokenservice/token",
        new Date("2026-09-24T07:21:48.596Z"),
      );
      expect(h["Client-Date"]).toBe("2026-09-24T09:21:48+02:00");
      expect(h["X-Client-TraceId"]).toBe("e602e743bed34421319a627d3b0d14cc");
      expect(h["X-Security"]).toBe("df1c4e51a6b948acabe9b4d593f1d361");
    });

    it("uses the winter (CET) offset out of daylight saving", () => {
      const h = boerseSecurityHeaders(
        "https://x/",
        new Date("2026-01-15T08:00:00.000Z"),
      );
      expect(h["Client-Date"]).toBe("2026-01-15T09:00:00+01:00");
    });

    it("folds the salt into the trace id but not X-Security", () => {
      const at = new Date("2026-09-24T07:21:48.596Z");
      const a = boerseSecurityHeaders("https://x/", at, "salt-a");
      const b = boerseSecurityHeaders("https://x/", at, "salt-b");
      expect(a["X-Client-TraceId"]).not.toBe(b["X-Client-TraceId"]);
      // X-Security is salt-independent, so it stays identical.
      expect(a["X-Security"]).toBe(b["X-Security"]);
    });
  });

  describe("fetchHistoricalWindowSeries", () => {
    it("streams the daily series with the instrument currency", async () => {
      global.fetch = routeFetch();
      const series = await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series).not.toBeNull();
      expect(series!.currencyCode).toBe("EUR");
      expect(series!.symbol).toBe("IE00B6R52259");
      expect(series!.prices).toHaveLength(2);
      expect(series!.prices[0]).toMatchObject({
        date: new Date("2025-09-23T00:00:00.000Z"),
        open: 89.24,
        high: 89.44,
        low: 89.18,
        close: 89.27,
        volume: 120499,
        adjClose: null,
      });
    });

    it("passes the ISIN and currency into the marketstate id", async () => {
      global.fetch = routeFetch();
      let captured: FakeSocket | undefined;
      service.wsFactory = () => {
        captured = new FakeSocket(FRAMES);
        return captured;
      };
      await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      const listMsg = captured!.sent.find((m) => m.includes("listTimeseries"));
      expect(listMsg).toContain("DELAYED[IE00B6R52259,EUR@ETR>STX]");
    });

    it("returns null when the token request fails", async () => {
      global.fetch = routeFetch({ token: () => jsonResponse({}, false, 401) });
      const series = await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series).toBeNull();
    });

    it("returns null when the currency is unknown", async () => {
      global.fetch = routeFetch({ currency: () => jsonResponse([]) });
      const series = await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series).toBeNull();
    });

    it("returns null when the socket cannot be opened", async () => {
      global.fetch = routeFetch();
      service.wsFactory = () => {
        throw new Error("no socket");
      };
      const series = await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series).toBeNull();
    });

    it("treats an empty window (authenticated, no frames) as an empty answer", async () => {
      global.fetch = routeFetch();
      service.wsFactory = () => new FakeSocket([]);
      const series = await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      // A holiday-only or just-listed window is an answer with no bars, not a
      // failure: a series with empty prices, never null.
      expect(series).not.toBeNull();
      expect(series!.prices).toHaveLength(0);
      expect(series!.currencyCode).toBe("EUR");
    });

    it("prices a ticker symbol by resolving it to an ISIN", async () => {
      global.fetch = routeFetch();
      service.wsFactory = () => new FakeSocket(FRAMES);
      const series = await service.fetchHistoricalWindowSeries(
        "IUSQ",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series).not.toBeNull();
      expect(series!.symbol).toBe("IUSQ");
      expect(series!.prices).toHaveLength(2);
    });

    it("returns null for a symbol the search cannot resolve", async () => {
      global.fetch = routeFetch({ search: () => jsonResponse([[]]) });
      const series = await service.fetchHistoricalWindowSeries(
        "NOPE",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series).toBeNull();
    });

    it("skips frames with no date or no close", async () => {
      global.fetch = routeFetch();
      service.wsFactory = () =>
        new FakeSocket([
          { date: "2025-09-23", close: 89.27 },
          { date: "2025-09-24", close: null },
          { close: 90 },
        ]);
      const series = await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series!.prices).toHaveLength(1);
      expect(series!.prices[0].open).toBeNull();
    });

    it("resolves on a socket error event", async () => {
      global.fetch = routeFetch();
      service.wsFactory = () => new ErrorSocket();
      const series = await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series).toBeNull();
    });
  });

  describe("fetchQuote", () => {
    it("returns the newest bar as a delayed quote", async () => {
      global.fetch = routeFetch();
      const quote = await service.fetchQuote("IE00B6R52259");
      expect(quote).toMatchObject({
        symbol: "IE00B6R52259",
        regularMarketPrice: 89.13,
        currencyCode: "EUR",
        provider: "deutsche_boerse",
        exchangeTimezone: "Europe/Berlin",
      });
    });

    it("returns null when there is no data", async () => {
      global.fetch = routeFetch({ currency: () => jsonResponse([]) });
      expect(await service.fetchQuote("IE00B6R52259")).toBeNull();
    });
  });

  describe("fetchHistoricalSeries", () => {
    it.each(["max", "5d", "6mo", "2y", "garbage"])(
      "maps the %s range onto a window",
      async (range) => {
        global.fetch = routeFetch();
        const series = await service.fetchHistoricalSeries(
          "IE00B6R52259",
          null,
          range,
        );
        expect(series!.prices.length).toBe(2);
      },
    );
  });

  describe("token lifecycle", () => {
    it("caches the token to its JWT expiry across calls", async () => {
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString("base64url");
      const exp = Math.floor(Date.now() / 1000) + 600;
      const jwt = `${b64({ alg: "HS256" })}.${b64({ exp })}.sig`;
      const fetchMock = routeFetch({
        token: () => jsonResponse({ token: jwt }),
      });
      global.fetch = fetchMock;

      await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      const tokenCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/mdstokenservice/token"),
      );
      expect(tokenCalls).toHaveLength(1);
    });

    it("returns null when the token endpoint is unreachable", async () => {
      global.fetch = jest.fn((url: string) =>
        String(url).includes("/mdstokenservice/token")
          ? Promise.reject(new Error("network down"))
          : Promise.resolve(jsonResponse(CURRENCY)),
      );
      const series = await service.fetchHistoricalWindowSeries(
        "IE00B6R52259",
        null,
        new Date("2025-09-01T00:00:00Z"),
        new Date("2025-10-01T00:00:00Z"),
      );
      expect(series).toBeNull();
    });
  });

  describe("currency lookup", () => {
    it("treats a 5xx currency response as unknown", async () => {
      global.fetch = routeFetch({
        currency: () => jsonResponse({}, false, 500),
      });
      expect(await service.fetchQuote("IE00B6R52259")).toBeNull();
    });

    it("treats a currency network failure as unknown", async () => {
      global.fetch = jest.fn((url: string) =>
        String(url).includes("/v1/data/currency")
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(jsonResponse(TOKEN)),
      );
      expect(await service.fetchQuote("IE00B6R52259")).toBeNull();
    });
  });

  describe("lookupSecurity", () => {
    it("finds an instrument by its Börse Frankfurt ticker through global search", async () => {
      global.fetch = routeFetch();
      // Searching by the venue ticker returns the ticker as the symbol.
      const result = await service.lookupSecurity("IUSQ");
      expect(result).toMatchObject({
        symbol: "IUSQ",
        name: "iShares MSCI All Country World UCITS ETF USD (Acc)",
        securityType: "ETP",
        currencyCode: "EUR",
        provider: "deutsche_boerse",
      });
    });

    it("enriches the ticker and currency when search omits them (ISIN query)", async () => {
      // An ISIN query returns the hit without a symbol or currency; the data
      // sheet supplies the ticker and the currency endpoint the currency.
      global.fetch = routeFetch({
        search: () =>
          jsonResponse([
            [
              {
                isin: "IE00B6R52259",
                name: {
                  originalValue:
                    "iShares MSCI All Country World UCITS ETF USD (Acc)",
                },
              },
            ],
          ]),
      });
      const result = await service.lookupSecurity("IE00B6R52259");
      expect(result).toMatchObject({
        symbol: "IUSQ",
        securityType: "ETF",
        currencyCode: "EUR",
        provider: "deutsche_boerse",
      });
    });

    it("returns nothing when search has no match", async () => {
      global.fetch = routeFetch({ search: () => jsonResponse([[]]) });
      expect(await service.lookupSecurityMany("ZZZ")).toEqual([]);
      expect(await service.lookupSecurity("ZZZ")).toBeNull();
    });

    it("drops a search hit without a valid ISIN", async () => {
      global.fetch = routeFetch({
        search: () => jsonResponse([[{ symbol: "IUSQ", isin: "not-an-isin" }]]),
      });
      expect(await service.lookupSecurityMany("IUSQ")).toEqual([]);
    });
  });

  it("has no sector information", async () => {
    expect(await service.fetchStockSectorInfo()).toBeNull();
    expect(await service.fetchEtfSectorWeightings()).toBeNull();
  });

  it("derives the trading date from the quote", async () => {
    global.fetch = routeFetch();
    const quote = await service.fetchQuote("IE00B6R52259");
    expect(service.getTradingDate(quote!)).toBeInstanceOf(Date);
  });
});
