import { ConflictException, NotFoundException } from "@nestjs/common";
import { McpEmailReceiptParserTools } from "./email-receipt-parsers.tool";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";
import { EMAIL_RECEIPT_PARSER_TOOL_DESCRIPTION } from "../../email-receipts/parsers/parser-tool.guide";

const R1 = "30000000-0000-4000-8000-000000000001";
const R2 = "30000000-0000-4000-8000-000000000002";
const REQ = "30000000-0000-4000-8000-000000000009";
const DEFINITION = { version: 2, total: ["Order total: {amount}"] };

describe("McpEmailReceiptParserTools", () => {
  let tool: McpEmailReceiptParserTools;
  let parsers: Record<string, jest.Mock>;
  let ctx: McpTestContext;
  let config: any;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    parsers = {
      listCategories: jest.fn().mockResolvedValue({
        categories: [{ id: "c1", name: "Books" }],
        totalCount: 1,
        truncated: false,
      }),
      testDefinition: jest.fn(),
      saveDraft: jest.fn(),
      listParsers: jest.fn().mockResolvedValue([{ id: R1, name: "Shop" }]),
      getParser: jest.fn().mockResolvedValue({ id: R1, name: "Shop" }),
    };
    tool = new McpEmailReceiptParserTools(parsers as never);
    const server = {
      registerTool: jest.fn((_name, opts, h) => {
        config = opts;
        handler = h;
      }),
    };
    tool.register(server as never);
    ctx = mcpTestCtx({ userId: "u1", scopes: "read,write" });
  });

  const call = (args: Record<string, unknown>, scopes = "read,write") => {
    ctx.setUser({ userId: "u1", scopes });
    return handler(args, ctx);
  };

  it("declares the five required fields, the shared description and a non-destructive write annotation", () => {
    expect(config.title).toEqual(expect.any(String));
    expect(config.description).toBe(EMAIL_RECEIPT_PARSER_TOOL_DESCRIPTION);
    expect(config.inputSchema).toBeDefined();
    expect(config.outputSchema).toBeDefined();
    expect(config.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("teaches the loop: test every email, fix, then save a draft", () => {
    expect(config.description).toMatch(/Test every email/);
    expect(config.description).toMatch(/save_draft/);
    expect(config.description).toMatch(/approve the draft/);
  });

  it("refuses without a user context", async () => {
    ctx.setUser(undefined);
    expect((await handler({ operation: "categories" }, ctx)).isError).toBe(
      true,
    );
  });

  describe("categories", () => {
    it("needs only the read scope", async () => {
      const result = await call({ operation: "categories" }, "read");

      expect(parsers.listCategories).toHaveBeenCalledWith("u1");
      expect(result.structuredContent.categories).toEqual([
        { id: "c1", name: "Books" },
      ]);
    });

    it("refuses without the read scope", async () => {
      expect((await call({ operation: "categories" }, "write")).isError).toBe(
        true,
      );
    });
  });

  describe("get", () => {
    it("lists the saved parsers with the read scope only", async () => {
      const result = await call({ operation: "get" }, "read");

      expect(parsers.listParsers).toHaveBeenCalledWith("u1");
      expect(parsers.getParser).not.toHaveBeenCalled();
      expect(result.structuredContent).toEqual({
        parsers: [{ id: R1, name: "Shop" }],
      });
    });

    it("reads one parser in full with the read scope only", async () => {
      const result = await call({ operation: "get", parserId: R1 }, "read");

      expect(parsers.getParser).toHaveBeenCalledWith("u1", R1);
      expect(parsers.listParsers).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ id: R1 });
      expect(parsers.saveDraft).not.toHaveBeenCalled();
    });

    it("refuses without the read scope", async () => {
      expect((await call({ operation: "get" }, "write")).isError).toBe(true);
      expect(parsers.listParsers).not.toHaveBeenCalled();
    });

    it("returns a missing parser as a tool error", async () => {
      parsers.getParser.mockRejectedValue(new NotFoundException("gone"));

      expect(
        (await call({ operation: "get", parserId: R2 }, "read")).isError,
      ).toBe(true);
    });
  });

  describe("test", () => {
    it("reads with the read scope only and writes nothing", async () => {
      parsers.testDefinition.mockResolvedValue({
        valid: true,
        errors: [],
        unknownCategoryIds: [],
        emails: [{ receiptId: R1 }],
        allComplete: true,
      });

      const result = await call(
        {
          operation: "test",
          definition: DEFINITION,
          receiptIds: [R1],
          payeeName: "<b>Shop</b>",
        },
        "read",
      );

      expect(parsers.testDefinition).toHaveBeenCalledWith("u1", {
        definition: DEFINITION,
        receiptIds: [R1],
        payeeName: "bShop/b",
      });
      expect(parsers.saveDraft).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        valid: true,
        allComplete: true,
      });
    });

    it("returns an invalid definition as data, not an error", async () => {
      parsers.testDefinition.mockResolvedValue({
        valid: false,
        errors: [{ path: "total[0]", code: "capture_missing" }],
        unknownCategoryIds: [],
        emails: [],
        allComplete: false,
      });

      const result = await call({
        operation: "test",
        definition: { total: ["x"] },
        receiptIds: [R1],
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.errors).toEqual([
        { path: "total[0]", code: "capture_missing" },
      ]);
    });

    it.each([
      ["a definition", { operation: "test", receiptIds: [R1] }],
      ["emails", { operation: "test", definition: DEFINITION }],
    ])("needs %s", async (_name, args) => {
      expect((await call(args)).isError).toBe(true);
      expect(parsers.testDefinition).not.toHaveBeenCalled();
    });

    it("hides an internal failure", async () => {
      parsers.testDefinition.mockRejectedValue(
        new Error("db password=hunter2"),
      );

      const result = await call({
        operation: "test",
        definition: DEFINITION,
        receiptIds: [R1, R2],
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("hunter2");
    });
  });

  describe("save_draft", () => {
    const args = {
      operation: "save_draft",
      requestId: REQ,
      name: "<i>Shop</i>",
      fromDomains: ["shop.example.com"],
      subjectContains: ["order"],
      payeeName: "Shop",
      definition: DEFINITION,
    };

    it("saves a draft under the MCP caller key and says it is not applied", async () => {
      parsers.saveDraft.mockResolvedValue({
        parserId: "p1",
        name: "iShop/i",
        status: "draft",
        fromDomains: ["shop.example.com"],
        payee: null,
        requestProposed: true,
      });

      const result = await call(args);

      expect(parsers.saveDraft).toHaveBeenCalledWith("u1", "s1", {
        requestId: REQ,
        name: "iShop/i",
        fromDomains: ["shop.example.com"],
        subjectContains: ["order"],
        payeeName: "Shop",
        definition: DEFINITION,
      });
      expect(result.structuredContent).toMatchObject({
        parserId: "p1",
        requestProposed: true,
        message: expect.stringContaining("Do not say it was applied"),
      });
    });

    it("keys a 2026-07-28 request, which has no session, on the credential", async () => {
      parsers.saveDraft.mockResolvedValue({ parserId: "p1" });
      const modern = Object.assign(
        mcpTestCtx({ userId: "u1", scopes: "write" }),
        { sessionId: undefined },
      );

      await handler(args, modern);

      expect(parsers.saveDraft.mock.calls[0][1]).toBe("pat:t1");
    });

    it("needs the write scope", async () => {
      expect((await call(args, "read")).isError).toBe(true);
      expect(parsers.saveDraft).not.toHaveBeenCalled();
    });

    it("a draft with no request needs no caller key", async () => {
      parsers.saveDraft.mockResolvedValue({ parserId: "p1" });
      const { requestId: _omit, ...withoutRequest } = args;

      const result = await call(withoutRequest);

      expect(result.isError).toBeFalsy();
      expect(parsers.saveDraft.mock.calls[0][2].requestId).toBeUndefined();
    });

    it.each([
      ["a definition", { ...args, definition: undefined }],
      ["a name", { ...args, name: " " }],
      ["domains", { ...args, fromDomains: undefined }],
    ])("needs %s", async (_name, bad) => {
      expect((await call(bad as Record<string, unknown>)).isError).toBe(true);
      expect(parsers.saveDraft).not.toHaveBeenCalled();
    });

    it("passes a refusal (a request this caller did not claim) on to the model", async () => {
      parsers.saveDraft.mockRejectedValue(
        new ConflictException("not claimed by you"),
      );

      const result = await call(args);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("not claimed by you");
    });
  });
});
