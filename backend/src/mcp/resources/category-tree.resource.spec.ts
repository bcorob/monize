import { McpCategoryTreeResource } from "./category-tree.resource";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpCategoryTreeResource", () => {
  let resource: McpCategoryTreeResource;
  let categoriesService: Record<string, jest.Mock>;
  let server: { registerResource: jest.Mock };
  let ctx: McpTestContext;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    categoriesService = {
      getTree: jest.fn(),
    };

    resource = new McpCategoryTreeResource(categoriesService as any);

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
      "categories",
      "monize://categories",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return error when no user context", async () => {
    ctx.setUser(undefined);
    const result = await handler("monize://categories", ctx);
    expect(result.contents[0].text).toContain("Error");
  });

  it("should return error when scope check fails", async () => {
    ctx.setUser({ userId: "u1", scopes: "write" });
    const result = await handler("monize://categories", ctx);
    expect(result.contents[0].text).toContain("Insufficient scope");
  });

  it("should return category tree", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    categoriesService.getTree.mockResolvedValue([
      { id: "c1", name: "Food", children: [{ id: "c2", name: "Groceries" }] },
    ]);

    const result = await handler("monize://categories", ctx);
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed[0].name).toBe("Food");
    expect(parsed[0].children).toHaveLength(1);
  });
});
