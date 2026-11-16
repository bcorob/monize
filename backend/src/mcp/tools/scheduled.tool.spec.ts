import { McpScheduledTools } from "./scheduled.tool";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpScheduledTools", () => {
  let tool: McpScheduledTools;
  let scheduledService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let ctx: McpTestContext;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    scheduledService = {
      getLlmUpcomingBillsAndDeposits: jest.fn(),
    };

    tool = new McpScheduledTools(scheduledService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    ctx = mcpTestCtx();
    tool.register(server as any);
  });

  it("should register 1 tool", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
  });

  describe("list_upcoming_bills", () => {
    it("returns error when no user context", async () => {
      ctx.setUser(undefined);
      const result = await handlers["list_upcoming_bills"]({}, ctx);
      expect(result.isError).toBe(true);
    });

    it("calls the shared LLM helper with default days=30", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      scheduledService.getLlmUpcomingBillsAndDeposits.mockResolvedValue({
        daysWindow: 30,
        itemCount: 1,
        overdueCount: 0,
        totalUpcomingBills: 1200,
        totalUpcomingDeposits: 0,
        totalsCurrency: "USD",
        amountsComplete: true,
        items: [
          {
            id: "s1",
            name: "Rent",
            accountId: "a1",
            accountName: "Checking",
            payeeName: "Landlord",
            categoryName: "Housing",
            amount: -1200,
            currency: "USD",
            frequency: "MONTHLY",
            nextDueDate: "2026-06-15",
            daysUntilDue: 13,
            isActive: true,
            autoPost: false,
            kind: "bill",
            description: null,
          },
        ],
      });

      const result = await handlers["list_upcoming_bills"]({}, ctx);

      expect(
        scheduledService.getLlmUpcomingBillsAndDeposits,
      ).toHaveBeenCalledWith("u1", {
        days: 30,
        kind: undefined,
        accountIds: undefined,
      });
      const parsed = result.structuredContent as any;
      expect(parsed.itemCount).toBe(1);
      expect(parsed.items[0].kind).toBe("bill");
    });

    it("passes through days, kind, and accountIds", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      scheduledService.getLlmUpcomingBillsAndDeposits.mockResolvedValue({
        daysWindow: 7,
        itemCount: 0,
        overdueCount: 0,
        totalUpcomingBills: 0,
        totalUpcomingDeposits: 0,
        totalsCurrency: "USD",
        amountsComplete: true,
        items: [],
      });

      await handlers["list_upcoming_bills"](
        { days: 7, kind: "deposit", accountIds: ["acc-1"] },
        ctx,
      );
      expect(
        scheduledService.getLlmUpcomingBillsAndDeposits,
      ).toHaveBeenCalledWith("u1", {
        days: 7,
        kind: "deposit",
        accountIds: ["acc-1"],
      });
    });

    it("returns error when service throws", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      scheduledService.getLlmUpcomingBillsAndDeposits.mockRejectedValue(
        new Error("DB error"),
      );
      const result = await handlers["list_upcoming_bills"]({}, ctx);
      expect(result.isError).toBe(true);
    });
  });
});
