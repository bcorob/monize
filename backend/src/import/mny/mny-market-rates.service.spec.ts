import { ExchangeRateService } from "../../currencies/exchange-rate.service";
import { FxRateResolution } from "../../common/time-series/fx-rate-resolver";
import { readMnyFixture } from "./__fixtures__/mny-fixtures";
import { MnyMarketRateService } from "./mny-market-rates.service";
import { MnyParsedFile, MnyParserService } from "./mny-parser.service";

function resolution(rate: number | null): FxRateResolution {
  return {
    status: rate === null ? "unknown" : "resolved",
    rate,
    observedRate: rate,
    observedOn: null,
    direction: rate === null ? null : "direct",
    ageDays: null,
    reason: rate === null ? "no_observation" : null,
  };
}

describe("MnyMarketRateService", () => {
  let rates: {
    resolveStoredRate: jest.Mock;
    fillRateWindow: jest.Mock;
  };

  beforeEach(() => {
    rates = {
      resolveStoredRate: jest.fn().mockResolvedValue(resolution(null)),
      fillRateWindow: jest
        .fn()
        .mockResolvedValue({ stored: 0, answered: true }),
    };
  });

  const service = (parser: MnyParserService = new MnyParserService()) => {
    const instance = new MnyMarketRateService(
      parser,
      rates as unknown as ExchangeRateService,
    );
    jest.spyOn(instance["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(instance["logger"], "warn").mockImplementation(() => undefined);
    return instance;
  };

  describe("lookUp", () => {
    it("answers from stored history without asking the provider", async () => {
      rates.resolveStoredRate.mockResolvedValue(resolution(1.0812345678912));

      const result = await service().lookUp([
        { from: "USD", to: "EUR", date: "2012-02-16" },
      ]);

      expect(result.rates).toEqual([
        { from: "USD", to: "EUR", date: "2012-02-16", rate: 1.0812345679 },
      ]);
      expect(rates.fillRateWindow).not.toHaveBeenCalled();
    });

    it("fetches one window per pair spanning every date it is missing", async () => {
      const filled = new Set<string>();
      rates.fillRateWindow.mockImplementation(async () => {
        filled.add("done");
        return { stored: 40, answered: true };
      });
      rates.resolveStoredRate.mockImplementation(async () =>
        resolution(filled.size > 0 ? 0.9 : null),
      );

      const result = await service().lookUp([
        { from: "USD", to: "EUR", date: "2006-01-27" },
        { from: "USD", to: "EUR", date: "2005-12-23" },
        { from: "USD", to: "EUR", date: "2005-12-23" },
      ]);

      expect(rates.fillRateWindow).toHaveBeenCalledTimes(1);
      expect(rates.fillRateWindow).toHaveBeenCalledWith(
        "USD",
        "EUR",
        "2005-11-08",
        "2006-01-27",
      );
      expect(result.rates.map((rate) => rate.date)).toEqual([
        "2005-12-23",
        "2006-01-27",
      ]);
      expect(result.unanswered.size).toBe(0);
    });

    it("values a date after today at today's rate", async () => {
      await service().lookUp([{ from: "USD", to: "EUR", date: "2999-01-01" }]);

      const [, , date] = rates.resolveStoredRate.mock.calls[0];
      expect(date < "2999-01-01").toBe(true);
    });

    it("names a pair the provider did not answer, and does not throw", async () => {
      rates.fillRateWindow.mockRejectedValue(new Error("timeout"));

      const result = await service().lookUp([
        { from: "USD", to: "EUR", date: "2012-02-16" },
      ]);

      expect(result.rates).toEqual([]);
      expect([...result.unanswered]).toEqual(["USD->EUR"]);
    });
  });

  describe("parse", () => {
    it("parses once when the file converts every trade itself", async () => {
      const parser = new MnyParserService();
      const parse = jest.spyOn(parser, "parse");

      await service(parser).parse({
        buffer: readMnyFixture("money2008"),
        userDefaultCurrency: "USD",
      });

      expect(parse).toHaveBeenCalledTimes(1);
    });

    it("parses again with the rates, on the bytes the first parse decrypted", async () => {
      const gaps = [{ from: "USD", to: "EUR", date: "2012-02-16" }];
      const first = {
        investments: { rateGaps: gaps },
      } as unknown as MnyParsedFile;
      const parser = {
        parse: jest.fn().mockReturnValueOnce(first).mockReturnValue(first),
      };
      rates.resolveStoredRate.mockResolvedValue(resolution(0.75));
      const buffer = Buffer.from("x");

      await service(parser as unknown as MnyParserService).parse({
        buffer,
        password: "secret",
        userDefaultCurrency: "USD",
      });

      expect(parser.parse).toHaveBeenCalledTimes(2);
      expect(parser.parse.mock.calls[1][0]).toMatchObject({
        buffer,
        password: undefined,
        alreadyDecrypted: true,
        marketRates: {
          rates: [{ ...gaps[0], rate: 0.75 }],
          unanswered: new Set(),
        },
      });
    });

    it("converts a Money 99 file's foreign-quoted trades at market rates", async () => {
      rates.resolveStoredRate.mockResolvedValue(resolution(0.92));

      const parsed = await service().parse({
        buffer: readMnyFixture("money99Investments"),
        userDefaultCurrency: "USD",
        asOf: "2099-12-31",
      });
      const codes = parsed.warnings.map((warning) => warning.code);

      expect(codes).not.toContain("crossCurrencyTradeUnconverted");
      expect(
        codes.filter((code) => code === "crossCurrencyTradeMarketRate"),
      ).toHaveLength(9);
      expect(parsed.investments.rateGaps).toEqual([]);
      const amazon = parsed.investments.transactions.filter(
        (trade) => trade.securityCurrencyCode === "USD",
      );
      expect(amazon.length).toBeGreaterThan(0);
      expect(amazon.every((trade) => trade.exchangeRate === 0.92)).toBe(true);
    });
  });
});
