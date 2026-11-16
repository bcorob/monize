import { z } from "zod";
import {
  createMcpHandler,
  InMemoryTransport,
  McpServer,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  callerKey,
  resolveUserContext,
  toAuthInfo,
  toolError,
  toolResult,
} from "./mcp-context";
import {
  ConfirmMismatchError,
  confirmWrite,
  installConfirmSupport,
  isAsk,
} from "./mcp-confirm";
import { McpRequestStateCodec } from "./mcp-request-state";

/**
 * One server definition, two protocol eras, in process.
 *
 * The transport serves 2026-07-28 through `createMcpHandler` and 2025-era
 * traffic through the sessionful path, from the SAME factory. What that buys is
 * only worth anything if both eras really reach the same tools with the same
 * identity, and neither a unit test of a handler nor a mocked transport can
 * show it -- so this drives the real SDK on both wires and asserts the answers
 * agree.
 */

const AUTH = toAuthInfo(
  { userId: "u1", scopes: "read,write", credentialId: "pat:t1" },
  "tok",
) as AuthInfo;

const codec = new McpRequestStateCodec({
  get: () => "unit-test-secret",
} as any);

/** Rows a "write" put away, so a test can ask whether one actually happened. */
const written: string[] = [];

/** The definition under test: one read tool and one confirmed write. */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "monize", version: "9.9.9" },
    {
      instructions: "Monize test server.",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      inputRequired: { maxRounds: 2, legacyShim: false },
      requestState: { verify: codec.verify },
    },
  );
  installConfirmSupport(server, codec);
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "The caller this request resolved to.",
      inputSchema: z.object({}),
    },
    (_args, ctx) => {
      const user = resolveUserContext(ctx);
      return toolResult({
        userId: user?.userId ?? null,
        callerKey: callerKey(ctx) ?? null,
      });
    },
  );
  server.registerTool(
    "delete_thing",
    {
      title: "Delete a thing",
      description: "Deletes a thing, once the user has confirmed it.",
      inputSchema: z.object({ id: z.string() }),
    },
    async (args, ctx) => {
      const user = resolveUserContext(ctx);
      if (!user) return toolError("No user context");
      try {
        const confirmation = await confirmWrite(
          server,
          ctx,
          `Delete ${args.id}?`,
          { id: args.id },
        );
        if (isAsk(confirmation)) return confirmation.ask;
        if (confirmation === "declined") {
          return toolError("Cancelled: the confirmation was declined.");
        }
        written.push(args.id);
        return toolResult({ deleted: args.id });
      } catch (err) {
        if (err instanceof ConfirmMismatchError) return toolError(err.message);
        throw err;
      }
    },
  );
  return server;
}

describe("MCP protocol eras", () => {
  describe("a 2026-07-28 client", () => {
    let handler: ReturnType<typeof createMcpHandler>;
    let client: Client;

    beforeEach(async () => {
      written.length = 0;
      handler = createMcpHandler(() => buildServer(), { legacy: "reject" });
      client = new Client(
        { name: "test-client", version: "0.0.0" },
        {
          // Declared on every request's envelope; the server reads it there
          // before deciding whether a dialog can be shown at all.
          capabilities: { elicitation: { form: {} } },
          versionNegotiation: { mode: { pin: "2026-07-28" } },
        },
      );
      // The transport never dials the URL: handler.fetch serves every request
      // in process, with the authInfo the Nest controller would have attached.
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
          fetch: (url: string | URL | Request, init?: RequestInit) =>
            handler.fetch(new Request(url as never, init), { authInfo: AUTH }),
        }),
      );
    });

    afterEach(async () => {
      await client.close();
      await handler.close();
    });

    it("negotiates the modern era", () => {
      expect(client.getProtocolEra()).toBe("modern");
    });

    // The whole point of the revision, end to end: no session, no server-side
    // wait, and the write happens only on the round the user answered.
    it("writes only after the user accepts, in two rounds", async () => {
      const elicit = jest.fn().mockResolvedValue({ action: "accept" });
      client.setRequestHandler("elicitation/create", elicit);

      const result = await client.callTool({
        name: "delete_thing",
        arguments: { id: "row-1" },
      });

      expect(result.structuredContent).toEqual({ deleted: "row-1" });
      expect(written).toEqual(["row-1"]);
      // One dialog, fulfilled by the client between the two calls.
      expect(elicit).toHaveBeenCalledTimes(1);
      expect(elicit.mock.calls[0][0].params.message).toBe("Delete row-1?");
    });

    it("writes nothing when the user declines", async () => {
      client.setRequestHandler("elicitation/create", async () => ({
        action: "decline",
      }));

      const result = await client.callTool({
        name: "delete_thing",
        arguments: { id: "row-2" },
      });

      expect(result.isError).toBe(true);
      expect(written).not.toContain("row-2");
    });

    // What is actually on the wire between the rounds: the question, the keys
    // it asks under, and the sealed state the client must echo back. A client
    // that never answers simply never calls again, and nothing is written.
    it("returns the question, sealed, and writes nothing until it is answered", async () => {
      const manual = new Client(
        { name: "manual-client", version: "0.0.0" },
        {
          capabilities: { elicitation: { form: {} } },
          versionNegotiation: { mode: { pin: "2026-07-28" } },
          inputRequired: { autoFulfill: false },
        },
      );
      await manual.connect(
        new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
          fetch: (url: string | URL | Request, init?: RequestInit) =>
            handler.fetch(new Request(url as never, init), { authInfo: AUTH }),
        }),
      );
      try {
        const raw = (await manual.callTool(
          { name: "delete_thing", arguments: { id: "row-3" } },
          { allowInputRequired: true },
        )) as unknown as {
          resultType: string;
          inputRequests: Record<string, unknown>;
          requestState: string;
        };

        expect(raw.resultType).toBe("input_required");
        expect(Object.keys(raw.inputRequests)).toEqual(["confirm"]);
        expect(raw.requestState).toEqual(expect.any(String));
        expect(written).not.toContain("row-3");
      } finally {
        await manual.close();
      }
    });

    it("serves the same tool, resolving the caller from the request", async () => {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual([
        "whoami",
        "delete_thing",
      ]);

      const result = await client.callTool({ name: "whoami", arguments: {} });
      // No session exists on this era, so the caller key is the credential.
      expect(result.structuredContent).toEqual({
        userId: "u1",
        callerKey: "pat:t1",
      });
    });
  });

  describe("a 2025-era client", () => {
    let server: McpServer;
    let client: Client;

    beforeEach(async () => {
      server = buildServer();
      client = new Client({ name: "test-client", version: "0.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      // The sessionful transport attaches the validated AuthInfo to every
      // inbound message, exactly as the Nest controller does through req.auth.
      const send = clientTransport.send.bind(clientTransport);
      clientTransport.send = (message, options) =>
        send(message, { ...options, authInfo: AUTH });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    });

    afterEach(async () => {
      await client.close();
    });

    it("negotiates the legacy era", () => {
      expect(client.getProtocolEra()).toBe("legacy");
    });

    it("serves the same tool, resolving the same caller", async () => {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual([
        "whoami",
        "delete_thing",
      ]);

      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect((result.structuredContent as { userId: string }).userId).toBe(
        "u1",
      );
    });
  });
});
