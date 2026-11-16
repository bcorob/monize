import { HttpException } from "@nestjs/common";
import { SeriesFetchError } from "../../bonds/bond-adapter";
import { AuthAttemptCounterService } from "../../auth/auth-attempt-counter.service";
import { createAuthAttemptCounterMock } from "../../test-helpers/auth-attempt-counter-testing";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";
import { McpBondSeriesTools } from "./bond-series.tool";

const RESULT = {
  id: "i1",
  issuerCountryCode: "PL",
  issuerCode: "PL_MF",
  programCode: "EDO",
  seriesCode: "EDO1036",
  currencyCode: "PLN",
  termsProvider: "obligacjeskarbowe.pl",
  created: true,
};
const VALUES = {
  firstPeriodRate: "0.0535",
  addend: "0.0200",
  fee: "2.00",
  saleWindow: { from: "2026-10-01", to: "2026-10-31" },
  letter: { number: "12/2026", date: "2026-09-21" },
};
const MANUAL = { countryCode: "pl", seriesCode: "edo1036", values: VALUES };

describe("McpBondSeriesTools", () => {
  let series: Record<string, jest.Mock>;
  let limiter: McpWriteLimiter;
  let handlers: Record<string, (...args: any[]) => any>;
  let configs: Record<string, any>;
  let elicitInput: jest.Mock;
  let server: any;
  let ctx: McpTestContext;

  beforeEach(() => {
    series = {
      fetchSeries: jest.fn().mockResolvedValue(RESULT),
      enterManually: jest.fn().mockResolvedValue(RESULT),
      checkManual: jest.fn(),
      isAdministrator: jest.fn().mockResolvedValue(true),
    };
    limiter = new McpWriteLimiter(
      createAuthAttemptCounterMock() as unknown as AuthAttemptCounterService,
    );
    jest.spyOn(limiter, "record");
    handlers = {};
    configs = {};
    elicitInput = jest.fn();
    server = {
      registerTool: jest.fn((name, opts, handler) => {
        configs[name] = opts;
        handlers[name] = handler;
      }),
      server: { getClientCapabilities: jest.fn().mockReturnValue({}) },
    };
    new McpBondSeriesTools(series as never, limiter).register(server);
    ctx = mcpTestCtx({ userId: "u1", scopes: "read,write" }, { elicitInput });
  });

  it("registers the two tools with the required fields and a non-destructive write annotation", () => {
    expect(Object.keys(handlers)).toEqual([
      "fetch_bond_series",
      "enter_bond_series_manually",
    ]);
    for (const config of Object.values(configs)) {
      expect(config.title).toEqual(expect.any(String));
      expect(config.description).toEqual(expect.any(String));
      expect(config.inputSchema).toBeDefined();
      expect(config.outputSchema).toBeDefined();
    }
  });

  it("annotates the fetch as open-world (it reads the issuer's site) and idempotent (a repeat returns created=false), the manual entry as closed", () => {
    expect(configs.fetch_bond_series.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(configs.enter_bond_series_manually.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  describe("fetch_bond_series", () => {
    const args = { countryCode: "PL", seriesCode: "EDO1036" };

    it("takes only a country and a series code", () => {
      const schema = configs.fetch_bond_series.inputSchema;
      expect(Object.keys(schema.shape)).toEqual(["countryCode", "seriesCode"]);
      expect(
        schema.safeParse({ ...args, firstPeriodRate: "0.99" }).data,
      ).toEqual(args);
      expect(
        schema.safeParse({ countryCode: "PL", seriesCode: "x/y" }).success,
      ).toBe(false);
    });

    it("calls the service for the caller and counts a stored series as a write", async () => {
      const result = await handlers.fetch_bond_series(args, ctx);
      expect(series.fetchSeries).toHaveBeenCalledWith("u1", "PL", "EDO1036");
      expect(result.structuredContent).toMatchObject({
        id: "i1",
        created: true,
      });
      expect(limiter.record).toHaveBeenCalledWith("u1", "fetch_bond_series");
    });

    it("relays the per-user rate limit (429) as a tool error with its translated message", async () => {
      series.fetchSeries.mockRejectedValue(
        new HttpException(
          {
            message: "At most 10 bond series can be fetched per minute.",
            errorCode: "SERIES_FETCH_RATE_LIMITED",
          },
          429,
        ),
      );
      const result = await handlers.fetch_bond_series(args, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "At most 10 bond series can be fetched per minute.",
      );
      expect(limiter.record).not.toHaveBeenCalled();
    });

    it("asks for no confirmation", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      await handlers.fetch_bond_series(args, ctx);
      expect(elicitInput).not.toHaveBeenCalled();
    });

    it("does not count a series that was already stored", async () => {
      series.fetchSeries.mockResolvedValue({ ...RESULT, created: false });
      await handlers.fetch_bond_series(args, ctx);
      expect(limiter.record).not.toHaveBeenCalled();
    });

    it("needs the write scope and a user", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      expect((await handlers.fetch_bond_series(args, ctx)).isError).toBe(true);
      ctx.setUser(undefined);
      expect((await handlers.fetch_bond_series(args, ctx)).isError).toBe(true);
      expect(series.fetchSeries).not.toHaveBeenCalled();
    });

    it("tells the model why a series was refused, in the refusal's own words", async () => {
      series.fetchSeries.mockRejectedValue(
        new SeriesFetchError("SERIES_NOT_PUBLISHED", {
          series: "EDO1036",
          country: "PL",
        }),
      );
      const result = await handlers.fetch_bond_series(args, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Series EDO1036 is not published on the official source",
      );
    });

    it("never leaks an internal failure", async () => {
      series.fetchSeries.mockRejectedValue(new Error("password=hunter2"));
      const result = await handlers.fetch_bond_series(args, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain("hunter2");
    });
  });

  describe("enter_bond_series_manually", () => {
    it("refuses a caller who is not an administrator, before asking or writing", async () => {
      series.isAdministrator.mockResolvedValue(false);
      const result = await handlers.enter_bond_series_manually(MANUAL, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/administrator/);
      expect(series.isAdministrator).toHaveBeenCalledWith("u1");
      expect(series.checkManual).not.toHaveBeenCalled();
      expect(series.enterManually).not.toHaveBeenCalled();
    });

    it("needs the write scope and a user", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      expect(
        (await handlers.enter_bond_series_manually(MANUAL, ctx)).isError,
      ).toBe(true);
      ctx.setUser(undefined);
      expect(
        (await handlers.enter_bond_series_manually(MANUAL, ctx)).isError,
      ).toBe(true);
      expect(series.isAdministrator).not.toHaveBeenCalled();
    });

    it("validates the values before it asks anybody to confirm", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      series.checkManual.mockImplementation(() => {
        throw new SeriesFetchError("SOURCE_INCONSISTENT", {
          series: "EDO1036",
          field: "fee",
          value: "99.00",
        });
      });
      const result = await handlers.enter_bond_series_manually(MANUAL, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("fee");
      expect(elicitInput).not.toHaveBeenCalled();
      expect(series.enterManually).not.toHaveBeenCalled();
    });

    it("confirms with the user and stores what was confirmed", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "accept" });
      const result = await handlers.enter_bond_series_manually(MANUAL, ctx);
      expect(elicitInput).toHaveBeenCalledTimes(1);
      expect(elicitInput.mock.calls[0][0].message).toContain("EDO1036");
      expect(series.enterManually).toHaveBeenCalledWith("pl", "edo1036", {
        ...VALUES,
      });
      expect(result.structuredContent).toMatchObject({ created: true });
      expect(limiter.record).toHaveBeenCalledWith(
        "u1",
        "enter_bond_series_manually",
      );
    });

    it("writes nothing when the confirmation is declined", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });
      const result = await handlers.enter_bond_series_manually(MANUAL, ctx);
      expect(result.isError).toBe(true);
      expect(series.enterManually).not.toHaveBeenCalled();
      expect(limiter.record).not.toHaveBeenCalled();
    });

    it("passes an absent addend and fee to the service as null", async () => {
      await handlers.enter_bond_series_manually(
        {
          ...MANUAL,
          values: { ...VALUES, addend: undefined, fee: null },
        },
        ctx,
      );
      expect(series.enterManually).toHaveBeenCalledWith(
        "pl",
        "edo1036",
        expect.objectContaining({ addend: null, fee: null }),
      );
    });

    it("bounds every value in its input schema", () => {
      const schema = configs.enter_bond_series_manually.inputSchema;
      expect(schema.safeParse(MANUAL).success).toBe(true);
      expect(
        schema.safeParse({
          ...MANUAL,
          values: { ...VALUES, firstPeriodRate: "5,35%" },
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...MANUAL,
          values: {
            ...VALUES,
            letter: { number: "1".repeat(33), date: "2026-09-21" },
          },
        }).success,
      ).toBe(false);
    });
  });
});
