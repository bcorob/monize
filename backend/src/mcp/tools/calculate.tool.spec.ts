import { McpServer } from "@modelcontextprotocol/server";
import { McpCalculateTools } from "./calculate.tool";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";

describe("McpCalculateTools", () => {
  let tools: McpCalculateTools;
  let mockServer: { registerTool: jest.Mock };
  let rates: { convertOnDate: jest.Mock };

  beforeEach(() => {
    rates = {
      convertOnDate: jest.fn().mockResolvedValue({
        amount: 1500,
        fromCurrency: "CAD",
        toCurrency: "USD",
        date: "2026-09-01",
        rate: 0.7325,
        convertedAmount: 1098.75,
      }),
    };
    tools = new McpCalculateTools(rates as unknown as ExchangeRateService);
    mockServer = {
      registerTool: jest.fn(),
    };
  });

  it("registers the calculate tool", () => {
    tools.register(mockServer as unknown as McpServer);

    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "calculate",
      expect.objectContaining({
        description: expect.stringContaining("Server-side arithmetic"),
      }),
      expect.any(Function),
    );
  });

  it("executes percentage calculation", async () => {
    tools.register(mockServer as unknown as McpServer);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler({
      operation: "percentage",
      values: [300, 5000],
    });

    expect(result.content).toBeDefined();
    const data = result.structuredContent as any;
    expect(data.result).toBe(6);
    expect(data.formattedResult).toBe("6%");
  });

  it("executes sum calculation", async () => {
    tools.register(mockServer as unknown as McpServer);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler({
      operation: "sum",
      values: [0.1, 0.2],
    });

    const data = result.structuredContent as any;
    expect(data.result).toBe(0.3);
  });

  it("returns error for division by zero", async () => {
    tools.register(mockServer as unknown as McpServer);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler({
      operation: "ratio",
      values: [100, 0],
    });

    expect(result.isError).toBe(true);
  });

  it("converts through ExchangeRateService.convertOnDate and returns both sides", async () => {
    tools.register(mockServer as unknown as McpServer);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler({
      operation: "convert",
      values: [1500],
      fromCurrency: "CAD",
      toCurrency: "USD",
      date: "2026-09-01",
    });

    expect(rates.convertOnDate).toHaveBeenCalledWith(
      1500,
      "CAD",
      "USD",
      "2026-09-01",
    );
    const data = result.structuredContent as any;
    expect(data).toEqual({
      result: 1098.75,
      formattedResult: "1098.75 USD",
      operation: "convert",
      amount: 1500,
      fromCurrency: "CAD",
      toCurrency: "USD",
      date: "2026-09-01",
      rate: 0.7325,
    });
  });

  it("returns an error, not a figure, when the pair has no rate", async () => {
    rates.convertOnDate.mockResolvedValue(null);
    tools.register(mockServer as unknown as McpServer);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler({
      operation: "convert",
      values: [100],
      fromCurrency: "CAD",
      toCurrency: "XXX",
    });

    expect(result.isError).toBe(true);
  });

  it("refuses a conversion missing its currency pair before touching the service", async () => {
    tools.register(mockServer as unknown as McpServer);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler({ operation: "convert", values: [100] });

    expect(result.isError).toBe(true);
    expect(rates.convertOnDate).not.toHaveBeenCalled();
  });
});
