import { McpAccountListResource } from "./account-list.resource";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpAccountListResource", () => {
  let resource: McpAccountListResource;
  let accountsService: Record<string, jest.Mock>;
  let server: { registerResource: jest.Mock };
  let ctx: McpTestContext;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    accountsService = {
      findAll: jest.fn(),
      getSummary: jest.fn(),
    };

    resource = new McpAccountListResource(accountsService as any);

    server = {
      registerResource: jest.fn((_name, _uri, _opts, h) => {
        handler = h;
      }),
    };

    ctx = mcpTestCtx();
    resource.register(server as any);
  });

  it("should register the resource", () => {
    expect(server.registerResource).toHaveBeenCalledWith(
      "accounts",
      "monize://accounts",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return error when no user context", async () => {
    ctx.setUser(undefined);
    const result = await handler("monize://accounts", ctx);
    expect(result.contents[0].text).toContain("Error");
  });

  it("should return error when scope check fails", async () => {
    ctx.setUser({ userId: "u1", scopes: "write" });
    const result = await handler("monize://accounts", ctx);
    expect(result.contents[0].text).toContain("Insufficient scope");
  });

  it("should return accounts and summary", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    accountsService.findAll.mockResolvedValue([{ id: "a1", name: "Checking" }]);
    accountsService.getSummary.mockResolvedValue({ netWorth: 5000 });

    const result = await handler("monize://accounts", ctx);
    expect(result.contents[0].mimeType).toBe("application/json");
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.summary.netWorth).toBe(5000);
  });
});
