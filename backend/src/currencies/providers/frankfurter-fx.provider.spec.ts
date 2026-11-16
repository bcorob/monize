import { Logger } from "@nestjs/common";
import { ProviderHealthService } from "../../provider-health/provider-health.service";
import { ProviderUnavailableError } from "../../provider-health/provider-unavailable.error";
import { TRACKED_PROVIDERS } from "../../provider-health/providers";
import {
  DEFAULT_FRANKFURTER_BASE_URL,
  FRANKFURTER_CURRENCY_LIST_RETRY_MS,
  FRANKFURTER_CURRENCY_LIST_TTL_MS,
  FRANKFURTER_FALLBACK_CURRENCIES,
  FRANKFURTER_LATEST_TIMEOUT_MS,
  FRANKFURTER_PROVIDER,
  FRANKFURTER_SERIES_TIMEOUT_MS,
  FrankfurterFxProvider,
  resolveFrankfurterBaseUrl,
} from "./frankfurter-fx.provider";

/*
 * Fixtures. The first group is copied verbatim from section 6.1 of
 * `docs/specs/exchange-rate-providers.md`, recorded from the public
 * instance on 2026-10-07; the plan records only the shape or the date for
 * some cases, so the second group was recorded from the same instance on
 * 2026-10-12 for those, and is dated here. Neither group is edited by hand: a
 * fixture is evidence only while the producer could have written it.
 */

// 2026-10-07, section 6.1.
const LATEST_USD = JSON.parse(
  '{"amount":1.0,"base":"USD","date":"2026-10-07","rates":{"CAD":1.4253,"EUR":0.89469,"SGD":1.2804}}',
);
const RANGE_2024_01_01_TO_05 = JSON.parse(
  '{"amount":1.0,"base":"USD","start_date":"2023-12-29","end_date":"2024-01-05",' +
    '"rates":{"2023-12-29":{"CAD":1.3251},"2024-01-02":{"CAD":1.3294},"2024-01-03":{"CAD":1.3347},' +
    '"2024-01-04":{"CAD":1.3332},"2024-01-05":{"CAD":1.3369}}}',
);
const NOT_FOUND = JSON.parse('{"message":"not found"}');
/**
 * `GET {base}/currencies`. The plan records the codes (section 6.4) and the
 * first two names verbatim; the adapter reads only the keys.
 */
const CURRENCIES = JSON.parse(
  '{"AUD":"Australian Dollar","BRL":"Brazilian Real","CAD":"Canadian Dollar","CHF":"Swiss Franc",' +
    '"CNY":"Chinese Renminbi Yuan","CZK":"Czech Koruna","DKK":"Danish Krone","EUR":"Euro",' +
    '"GBP":"British Pound","HKD":"Hong Kong Dollar","HUF":"Hungarian Forint","IDR":"Indonesian Rupiah",' +
    '"ILS":"Israeli New Sheqel","INR":"Indian Rupee","ISK":"Icelandic Króna","JPY":"Japanese Yen",' +
    '"KRW":"South Korean Won","MXN":"Mexican Peso","MYR":"Malaysian Ringgit","NOK":"Norwegian Krone",' +
    '"NZD":"New Zealand Dollar","PHP":"Philippine Peso","PLN":"Polish Złoty","RON":"Romanian Leu",' +
    '"SEK":"Swedish Krona","SGD":"Singapore Dollar","THB":"Thai Baht","TRY":"Turkish Lira",' +
    '"USD":"United States Dollar","ZAR":"South African Rand"}',
);

// 2026-10-12, the second recording.
/** `latest?base=USD&symbols=CAD,TWD`: TWD silently dropped (the plan records only "rates has CAD only"). */
const LATEST_USD_CAD_TWD = JSON.parse(
  '{"amount":1.0,"base":"USD","date":"2026-10-09","rates":{"CAD":1.4226}}',
);
/** `2026-10-04?base=USD&symbols=CAD`, a Sunday (the plan records only the date). */
const SUNDAY_LATEST = JSON.parse(
  '{"amount":1.0,"base":"USD","date":"2026-10-02","rates":{"CAD":1.424}}',
);
/** `2026-10-04..2026-10-04?base=USD&symbols=CAD`: the start moved back to Friday. */
const SUNDAY_RANGE = JSON.parse(
  '{"amount":1.0,"base":"USD","start_date":"2026-10-02","end_date":"2026-10-02","rates":{"2026-10-02":{"CAD":1.424}}}',
);
/** `1998-01-01..1999-01-08?base=USD&symbols=CAD` (the plan records the start and the row count). */
const PRE_1999_RANGE = JSON.parse(
  '{"amount":1.0,"base":"USD","start_date":"1999-01-04","end_date":"1999-01-08",' +
    '"rates":{"1999-01-04":{"CAD":1.5272},"1999-01-05":{"CAD":1.5237},"1999-01-06":{"CAD":1.5082},' +
    '"1999-01-07":{"CAD":1.5132},"1999-01-08":{"CAD":1.5133}}}',
);

/** A `fetch failed` as undici raises it: the one shape the breaker counts by name alone. */
function transportFailure(): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(
    new Error("getaddrinfo EAI_AGAIN api.frankfurter.dev"),
    { code: "EAI_AGAIN" },
  );
  return error;
}

describe("FrankfurterFxProvider", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let health: jest.Mocked<
    Pick<
      ProviderHealthService,
      | "assertAvailable"
      | "recordSuccess"
      | "recordFailure"
      | "releaseProbe"
      | "logFailure"
    >
  >;
  let provider: FrankfurterFxProvider;
  let warn: jest.SpyInstance;
  let timeoutSpy: jest.SpyInstance;

  const respond = (status: number, payload: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  });
  const answer = (status: number, payload: unknown) =>
    fetchMock.mockResolvedValueOnce(respond(status, payload));
  const askedUrl = (call = 0): string => fetchMock.mock.calls[call][0];
  const askedInit = (call = 0): RequestInit => fetchMock.mock.calls[call][1];

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    health = {
      assertAvailable: jest.fn().mockReturnValue("open-gate"),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn().mockReturnValue(true),
      releaseProbe: jest.fn(),
      logFailure: jest.fn(),
    } as unknown as typeof health;
    provider = new FrankfurterFxProvider(
      health as unknown as ProviderHealthService,
    );
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    timeoutSpy = jest.spyOn(AbortSignal, "timeout");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("names itself as the chain, the row and the breaker know it", () => {
    expect(provider.name).toBe("frankfurter");
    expect(provider.source).toBe("frankfurter");
    expect(FRANKFURTER_PROVIDER).toBe("frankfurter");
    expect(TRACKED_PROVIDERS[FRANKFURTER_PROVIDER]).toBe("Frankfurter");
  });

  describe("fetchLatest", () => {
    it("answers rates[Q] under base=B as { from: B, to: Q } dated by the instance, no inversion", async () => {
      answer(200, LATEST_USD);

      const found = await provider.fetchLatest("USD", ["CAD", "EUR", "SGD"]);

      expect(found).not.toBeNull();
      expect([...found!.entries()]).toEqual([
        ["CAD", { from: "USD", to: "CAD", date: "2026-10-07", rate: 1.4253 }],
        ["EUR", { from: "USD", to: "EUR", date: "2026-10-07", rate: 0.89469 }],
        ["SGD", { from: "USD", to: "SGD", date: "2026-10-07", rate: 1.2804 }],
      ]);
      expect(askedUrl()).toBe(
        `${DEFAULT_FRANKFURTER_BASE_URL}/latest?base=USD&symbols=CAD,EUR,SGD`,
      );
    });

    it("sends the headers the instance operator can act on, under the latest timeout", async () => {
      answer(200, LATEST_USD);

      await provider.fetchLatest("USD", ["CAD"]);

      const headers = askedInit().headers as Record<string, string>;
      expect(headers["User-Agent"]).toContain("Monize");
      expect(headers.Accept).toBe("application/json");
      expect(timeoutSpy).toHaveBeenCalledWith(FRANKFURTER_LATEST_TIMEOUT_MS);
      expect(askedInit().signal).toBeInstanceOf(AbortSignal);
    });

    it("asks nothing for an empty quote list", async () => {
      const found = await provider.fetchLatest("USD", []);

      expect(found!.size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(health.assertAvailable).not.toHaveBeenCalled();
    });

    it("drops a symbol the instance silently left out of rates: answered, no rate for it", async () => {
      answer(200, LATEST_USD_CAD_TWD);

      const found = await provider.fetchLatest("USD", ["CAD", "TWD"]);

      expect([...found!.keys()]).toEqual(["CAD"]);
      expect(found!.get("CAD")).toEqual({
        from: "USD",
        to: "CAD",
        date: "2026-10-09",
        rate: 1.4226,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("dates a Sunday's answer by the Friday the instance names, not by today", async () => {
      answer(200, SUNDAY_LATEST);

      const found = await provider.fetchLatest("USD", ["CAD"]);

      expect(found!.get("CAD")).toEqual({
        from: "USD",
        to: "CAD",
        date: "2026-10-02",
        rate: 1.424,
      });
    });

    it.each([
      ["a symbol the instance does not carry", "USD", ["TWD"]],
      ["a base the instance does not carry", "TWD", ["USD"]],
    ])(
      "reads a 404 for %s as answered with nothing, recorded as an answer and warned about once",
      async (_label, base, quotes) => {
        answer(404, NOT_FOUND);

        const found = await provider.fetchLatest(base, quotes);

        expect(found).not.toBeNull();
        expect(found!.size).toBe(0);
        expect(health.recordSuccess).toHaveBeenCalledTimes(1);
        expect(health.recordSuccess).toHaveBeenCalledWith("frankfurter");
        expect(health.logFailure).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(`${base} against`);
      },
    );

    it("drops a rate that is not a positive finite number", async () => {
      answer(200, {
        amount: 1.0,
        base: "USD",
        date: "2026-10-07",
        rates: { CAD: 0, EUR: "0.89", SGD: -1, JPY: 150.12 },
      });

      const found = await provider.fetchLatest("USD", [
        "CAD",
        "EUR",
        "SGD",
        "JPY",
      ]);

      expect([...found!.keys()]).toEqual(["JPY"]);
    });
  });

  describe("fetchDailySeries", () => {
    it("asks one range for the pair and drops the observation the instance moved before start", async () => {
      answer(200, RANGE_2024_01_01_TO_05);

      const points = await provider.fetchDailySeries(
        "USD",
        "CAD",
        "2024-01-01",
        "2024-01-05",
      );

      expect(points).toEqual([
        { from: "USD", to: "CAD", date: "2024-01-02", rate: 1.3294 },
        { from: "USD", to: "CAD", date: "2024-01-03", rate: 1.3347 },
        { from: "USD", to: "CAD", date: "2024-01-04", rate: 1.3332 },
        { from: "USD", to: "CAD", date: "2024-01-05", rate: 1.3369 },
      ]);
      expect(askedUrl()).toBe(
        `${DEFAULT_FRANKFURTER_BASE_URL}/2024-01-01..2024-01-05?base=USD&symbols=CAD`,
      );
      expect(timeoutSpy).toHaveBeenCalledWith(FRANKFURTER_SERIES_TIMEOUT_MS);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
    });

    it("answers a Sunday-only window as answered with nothing, once Friday's row is clipped", async () => {
      answer(200, SUNDAY_RANGE);

      const points = await provider.fetchDailySeries(
        "USD",
        "CAD",
        "2026-10-04",
        "2026-10-04",
      );

      expect(points).toEqual([]);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
      expect(health.logFailure).not.toHaveBeenCalled();
    });

    it("keeps the rows a window starting before 1999 answers from 1999-01-04", async () => {
      answer(200, PRE_1999_RANGE);

      const points = await provider.fetchDailySeries(
        "USD",
        "CAD",
        "1998-01-01",
        "1999-01-08",
      );

      expect(points!.map((point) => [point.date, point.rate])).toEqual([
        ["1999-01-04", 1.5272],
        ["1999-01-05", 1.5237],
        ["1999-01-06", 1.5082],
        ["1999-01-07", 1.5132],
        ["1999-01-08", 1.5133],
      ]);
    });

    it("reads a 404 for a window wholly before the instance's history as answered with nothing", async () => {
      answer(404, NOT_FOUND);

      const points = await provider.fetchDailySeries(
        "USD",
        "CAD",
        "1998-01-01",
        "1998-12-31",
      );

      expect(points).toEqual([]);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
      expect(health.logFailure).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("orders the points by date whatever order the body lists them in, and drops an unusable one", async () => {
      answer(200, {
        amount: 1.0,
        base: "USD",
        start_date: "2024-01-02",
        end_date: "2024-01-04",
        rates: {
          "2024-01-04": { CAD: 1.3332 },
          "2024-01-03": { CAD: "n/a" },
          "2024-01-02": { CAD: 1.3294 },
        },
      });

      const points = await provider.fetchDailySeries(
        "USD",
        "CAD",
        "2024-01-01",
        "2024-01-05",
      );

      expect(points!.map((point) => point.date)).toEqual([
        "2024-01-02",
        "2024-01-04",
      ]);
    });

    it("refuses to build a path from bounds that are not calendar dates", async () => {
      await expect(
        provider.fetchDailySeries("USD", "CAD", "2024-01-01", "../currencies"),
      ).rejects.toThrow("YYYY-MM-DD");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(health.assertAvailable).not.toHaveBeenCalled();
    });
  });

  /**
   * Section 6.3 of the plan, row by row. The fake breaker is what makes each
   * row provable: the assertion is on which of its methods were called, and
   * with what, for each kind of response.
   */
  describe("status handling (plan section 6.3)", () => {
    it("200, body parsed: recorded as an answer once, after the body arrived", async () => {
      const response = respond(200, LATEST_USD);
      let recordedBeforeBody = false;
      response.json.mockImplementation(async () => {
        recordedBeforeBody = health.recordSuccess.mock.calls.length > 0;
        return LATEST_USD;
      });
      fetchMock.mockResolvedValueOnce(response);

      await provider.fetchLatest("USD", ["CAD"]);

      expect(health.assertAvailable).toHaveBeenCalledWith("frankfurter");
      expect(recordedBeforeBody).toBe(false);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
      expect(health.recordFailure).not.toHaveBeenCalled();
      expect(health.logFailure).not.toHaveBeenCalled();
    });

    it.each([429, 500, 502, 503])(
      "HTTP %i: null, recorded as an answer, logged once through logFailure",
      async (status) => {
        answer(status, { message: "busy" });

        const found = await provider.fetchLatest("USD", ["CAD"]);

        expect(found).toBeNull();
        expect(health.recordSuccess).toHaveBeenCalledTimes(1);
        expect(health.recordFailure).not.toHaveBeenCalled();
        expect(health.logFailure).toHaveBeenCalledTimes(1);
        const [, providerId, context, error] = health.logFailure.mock.calls[0];
        expect(providerId).toBe("frankfurter");
        expect(context).toContain("USD against CAD");
        expect((error as Error).message).toContain(`HTTP ${status}`);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it("transport failure: null, counted by recordFailure and logged with the same error", async () => {
      const failure = transportFailure();
      fetchMock.mockRejectedValueOnce(failure);

      const points = await provider.fetchDailySeries(
        "USD",
        "CAD",
        "2024-01-01",
        "2024-01-05",
      );

      expect(points).toBeNull();
      expect(health.recordSuccess).not.toHaveBeenCalled();
      expect(health.recordFailure).toHaveBeenCalledWith("frankfurter", failure);
      expect(health.logFailure).toHaveBeenCalledTimes(1);
      expect(health.logFailure.mock.calls[0][3]).toBe(failure);
      expect(health.releaseProbe).not.toHaveBeenCalled();
    });

    it("timeout: the abort the signal raises reaches the breaker as a failure", async () => {
      const timeout = Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError",
      });
      fetchMock.mockRejectedValueOnce(timeout);

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
      expect(health.recordFailure).toHaveBeenCalledWith("frankfurter", timeout);
      expect(health.logFailure.mock.calls[0][3]).toBe(timeout);
    });

    it("a probe holder whose failure the breaker did not count hands the slot back", async () => {
      health.assertAvailable.mockReturnValue("probe");
      health.recordFailure.mockReturnValue(false);
      fetchMock.mockRejectedValueOnce(new TypeError("Invalid URL"));

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
      expect(health.releaseProbe).toHaveBeenCalledWith("frankfurter");
    });

    it("an open-gate admission never releases, even when the failure was not counted", async () => {
      health.recordFailure.mockReturnValue(false);
      fetchMock.mockRejectedValueOnce(new TypeError("Invalid URL"));

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
      expect(health.releaseProbe).not.toHaveBeenCalled();
    });

    it("200 whose body never finishes: null, counted as a failure, never recorded as an answer", async () => {
      const stalled = Object.assign(new Error("Body Timeout Error"), {
        code: "UND_ERR_BODY_TIMEOUT",
      });
      const response = respond(200, null);
      response.json.mockRejectedValue(stalled);
      fetchMock.mockResolvedValueOnce(response);

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
      expect(health.recordSuccess).not.toHaveBeenCalled();
      expect(health.recordFailure).toHaveBeenCalledWith("frankfurter", stalled);
      expect(health.logFailure.mock.calls[0][3]).toBe(stalled);
    });

    it.each([
      ["an array", []],
      ["a string", "ok"],
      ["rates that are not a table", { date: "2026-10-07", rates: 1.4 }],
      ["a date that is not a calendar date", { date: "today", rates: {} }],
    ])(
      "200 with %s for latest: null, the answer recorded, one unreadable-response line through logFailure",
      async (_label, body) => {
        answer(200, body);

        expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
        expect(health.recordSuccess).toHaveBeenCalledTimes(1);
        expect(health.recordFailure).not.toHaveBeenCalled();
        expect(health.logFailure).toHaveBeenCalledTimes(1);
        expect((health.logFailure.mock.calls[0][3] as Error).message).toContain(
          "unreadable",
        );
      },
    );

    it("200 with no rates table for a series: null, one unreadable-response line", async () => {
      answer(200, { start_date: "2024-01-02", end_date: "2024-01-04" });

      expect(
        await provider.fetchDailySeries(
          "USD",
          "CAD",
          "2024-01-01",
          "2024-01-05",
        ),
      ).toBeNull();
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
      expect(health.logFailure).toHaveBeenCalledTimes(1);
    });

    it("a refusal by the breaker is null with nothing asked, and goes through logFailure to be counted as suppressed", async () => {
      const refusal = new ProviderUnavailableError("Frankfurter", 30_000, null);
      health.assertAvailable.mockImplementation(() => {
        throw refusal;
      });

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
      expect(
        await provider.fetchDailySeries(
          "USD",
          "CAD",
          "2024-01-01",
          "2024-01-05",
        ),
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(health.recordSuccess).not.toHaveBeenCalled();
      expect(health.recordFailure).not.toHaveBeenCalled();
      expect(health.logFailure).toHaveBeenCalledTimes(2);
      expect(health.logFailure.mock.calls[0][3]).toBe(refusal);
    });
  });

  describe("carries", () => {
    let now: number;

    beforeEach(() => {
      now = Date.parse("2026-10-12T09:00:00.000Z");
      jest.spyOn(Date, "now").mockImplementation(() => now);
    });

    it("reads the instance's list once through the breaker and answers every code from it", async () => {
      answer(200, CURRENCIES);

      expect(await provider.carries("CAD")).toBe(true);
      expect(await provider.carries("EUR")).toBe(true);
      expect(await provider.carries("TWD")).toBe(false);
      expect(await provider.carries("cad")).toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(askedUrl()).toBe(`${DEFAULT_FRANKFURTER_BASE_URL}/currencies`);
      expect(timeoutSpy).toHaveBeenCalledWith(FRANKFURTER_LATEST_TIMEOUT_MS);
      expect(health.assertAvailable).toHaveBeenCalledTimes(1);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
    });

    it("holds the list for 24 hours, then asks again", async () => {
      answer(200, CURRENCIES);
      await provider.carries("CAD");

      now += FRANKFURTER_CURRENCY_LIST_TTL_MS - 1;
      await provider.carries("CAD");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 1;
      answer(200, { CAD: "Canadian Dollar", TWD: "New Taiwan Dollar" });
      expect(await provider.carries("TWD")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("concurrent callers share one list request", async () => {
      answer(200, CURRENCIES);

      const answers = await Promise.all([
        provider.carries("CAD"),
        provider.carries("TWD"),
        provider.carries("JPY"),
      ]);

      expect(answers).toEqual([true, false, true]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stands the compiled-in list in when the list cannot be fetched, and asks again after a few minutes", async () => {
      fetchMock.mockRejectedValueOnce(transportFailure());

      expect(await provider.carries("CAD")).toBe(true);
      expect(await provider.carries("TWD")).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(health.logFailure).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("compiled-in list");

      now += FRANKFURTER_CURRENCY_LIST_RETRY_MS - 1;
      await provider.carries("CAD");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 1;
      answer(200, CURRENCIES);
      expect(await provider.carries("CAD")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The real list is held for the full day once it arrives.
      now += FRANKFURTER_CURRENCY_LIST_RETRY_MS + 1;
      await provider.carries("CAD");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["a 404 (a base URL that is not a Frankfurter instance)", 404, NOT_FOUND],
      ["a 503", 503, { message: "down" }],
      ["an empty list", 200, {}],
      ["a list of the wrong shape", 200, { currencies: ["CAD"] }],
    ])(
      "stands the compiled-in list in after %s",
      async (_label, status, body) => {
        answer(status, body);

        expect(await provider.carries("CAD")).toBe(true);
        expect(await provider.carries("TWD")).toBe(false);
        expect(
          warn.mock.calls.some((c) =>
            String(c[0]).includes("compiled-in list"),
          ),
        ).toBe(true);
      },
    );

    it("the compiled-in list is the 30 codes section 6.4 records, covering 28 of Monize's 44", () => {
      expect(FRANKFURTER_FALLBACK_CURRENCIES).toHaveLength(30);
      expect(new Set(FRANKFURTER_FALLBACK_CURRENCIES).size).toBe(30);
      expect([...FRANKFURTER_FALLBACK_CURRENCIES].sort()).toEqual(
        FRANKFURTER_FALLBACK_CURRENCIES,
      );
      expect(Object.keys(CURRENCIES).sort()).toEqual(
        FRANKFURTER_FALLBACK_CURRENCIES,
      );
      for (const code of [
        "RUB",
        "TWD",
        "CLP",
        "SAR",
        "AED",
        "COP",
        "PEN",
        "ARS",
        "NGN",
        "EGP",
        "VND",
        "PKR",
        "BDT",
        "KWD",
        "BHD",
        "OMR",
      ]) {
        expect(FRANKFURTER_FALLBACK_CURRENCIES).not.toContain(code);
      }
    });
  });

  describe("verifyCurrency", () => {
    it("answers from the instance's own list, without a call per code", async () => {
      answer(200, CURRENCIES);

      expect(await provider.verifyCurrency("CAD")).toBe(true);
      expect(await provider.verifyCurrency("cad")).toBe(true);
      expect(await provider.verifyCurrency("TWD")).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(askedUrl()).toBe(`${DEFAULT_FRANKFURTER_BASE_URL}/currencies`);
    });

    it("while the compiled-in list stands in, a code it does not name is no answer, not unknown", async () => {
      fetchMock.mockRejectedValueOnce(transportFailure());

      expect(await provider.verifyCurrency("CAD")).toBe(true);
      expect(await provider.verifyCurrency("TWD")).toBeNull();
    });
  });

  describe("the base URL", () => {
    it.each([
      [undefined, DEFAULT_FRANKFURTER_BASE_URL],
      [null, DEFAULT_FRANKFURTER_BASE_URL],
      ["", DEFAULT_FRANKFURTER_BASE_URL],
      ["   ", DEFAULT_FRANKFURTER_BASE_URL],
      ["https://api.frankfurter.dev/v1/", DEFAULT_FRANKFURTER_BASE_URL],
      [" https://fx.internal.example/ ", "https://fx.internal.example"],
      ["http://frankfurter:8080//", "http://frankfurter:8080"],
    ])("resolves %p to %s", (raw, expected) => {
      expect(resolveFrankfurterBaseUrl(raw)).toBe(expected);
    });

    it("is what every request is built on, with one slash before the path", async () => {
      const selfHosted = new FrankfurterFxProvider(
        health as unknown as ProviderHealthService,
        resolveFrankfurterBaseUrl("http://frankfurter:8080/"),
      );
      answer(200, LATEST_USD);

      await selfHosted.fetchLatest("USD", ["CAD"]);

      expect(askedUrl()).toBe(
        "http://frankfurter:8080/latest?base=USD&symbols=CAD",
      );
    });
  });
});
