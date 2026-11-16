import {
  RELAY_CONTROL_TOOLS,
  installRelayToolActivity,
  wrapToolHandlerForRelay,
} from "./mcp-relay-tool-activity";
import { currentMcpCallerKey } from "./mcp-session-context";
import { mcpTestCtx } from "./testing/mcp-test-context";
import type { AiRelayService } from "../ai/relay/ai-relay.service";

describe("wrapToolHandlerForRelay", () => {
  const relay = () =>
    ({ reportToolActivity: jest.fn() }) as unknown as AiRelayService & {
      reportToolActivity: jest.Mock;
    };
  const ctxFor = (sessionId?: string) =>
    mcpTestCtx({ userId: "u1", scopes: "read" }, { sessionId });

  it("brackets a successful call with start then result (no error)", async () => {
    const relayService = relay();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    const wrapped = wrapToolHandlerForRelay(
      "get_accounts",
      handler,
      relayService,
    );

    const result = await wrapped({}, ctxFor("s1"));

    expect(result).toEqual({ ok: true });
    // The calling session travels with every report: it is what lets the relay
    // tell this user's relay turn from a second, direct MCP client of theirs.
    expect((relayService as any).reportToolActivity.mock.calls).toEqual([
      ["u1", "get_accounts", "start", false, "s1"],
      ["u1", "get_accounts", "result", false, "s1"],
    ]);
  });

  it("makes the calling session ambient for the duration of the handler", async () => {
    // emitRelayCard reads this to decide whether a write belongs to a relay
    // turn; without it every confirmation looks session-less and a direct
    // client's card could be routed to the web chat.
    const relayService = relay();
    const seen: (string | undefined)[] = [];
    const wrapped = wrapToolHandlerForRelay(
      "manage_transactions",
      async () => {
        seen.push(currentMcpCallerKey());
        await Promise.resolve();
        // Still ambient after an await -- handlers are async throughout.
        seen.push(currentMcpCallerKey());
        return { ok: true };
      },
      relayService,
    );

    await wrapped({}, ctxFor("s1"));

    expect(seen).toEqual(["s1", "s1"]);
    // And it does not leak outside the call.
    expect(currentMcpCallerKey()).toBeUndefined();
  });

  it("reports isError:true when the tool result is an error", async () => {
    const relayService = relay();
    const wrapped = wrapToolHandlerForRelay(
      "create_transaction",
      jest.fn().mockResolvedValue({ isError: true }),
      relayService,
    );

    await wrapped({}, ctxFor("s1"));

    expect((relayService as any).reportToolActivity).toHaveBeenLastCalledWith(
      "u1",
      "create_transaction",
      "result",
      true,
      "s1",
    );
  });

  it("still reports a result when the handler throws, then rethrows", async () => {
    const relayService = relay();
    const boom = new Error("boom");
    const wrapped = wrapToolHandlerForRelay(
      "get_accounts",
      jest.fn().mockRejectedValue(boom),
      relayService,
    );

    await expect(wrapped({}, ctxFor("s1"))).rejects.toThrow("boom");
    expect((relayService as any).reportToolActivity).toHaveBeenLastCalledWith(
      "u1",
      "get_accounts",
      "result",
      true,
      "s1",
    );
  });

  it("does not report activity when there is no user context", async () => {
    const relayService = relay();
    const wrapped = wrapToolHandlerForRelay(
      "get_accounts",
      jest.fn().mockResolvedValue({}),
      relayService,
    );

    // A request whose credential the transport never validated: nothing on it
    // says who is calling, so no activity belongs to anyone.
    await wrapped({}, mcpTestCtx(undefined));

    expect((relayService as any).reportToolActivity).not.toHaveBeenCalled();
  });
});

describe("installRelayToolActivity", () => {
  it("wraps data tools but leaves relay control tools untouched", async () => {
    const relayService = {
      reportToolActivity: jest.fn(),
    } as unknown as AiRelayService;
    const registered: Record<string, any> = {};
    const server = {
      registerTool: (name: string, _config: unknown, handler: any) => {
        registered[name] = handler;
      },
    } as any;

    installRelayToolActivity(server, relayService);
    const callerCtx = mcpTestCtx({ userId: "u1", scopes: "read" });

    // Register one data tool and one control tool through the patched method.
    server.registerTool("get_accounts", {}, jest.fn().mockResolvedValue({}));
    server.registerTool(
      "get_next_prompt",
      {},
      jest.fn().mockResolvedValue({ hasPrompt: false }),
    );

    await registered["get_accounts"]({}, callerCtx);
    expect((relayService as any).reportToolActivity).toHaveBeenCalled();

    (relayService as any).reportToolActivity.mockClear();
    await registered["get_next_prompt"]({}, callerCtx);
    expect((relayService as any).reportToolActivity).not.toHaveBeenCalled();
    expect(RELAY_CONTROL_TOOLS.has("get_next_prompt")).toBe(true);
  });
});
