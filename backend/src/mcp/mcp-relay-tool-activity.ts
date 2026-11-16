import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { callerKey, resolveUserContext } from "./mcp-context";
import type { AiRelayService } from "../ai/relay/ai-relay.service";
import { withMcpCaller } from "./mcp-session-context";

// Relay control tools are infrastructure (the long-poll and answer channel),
// not work the user should see as progress.
export const RELAY_CONTROL_TOOLS = new Set([
  "get_next_prompt",
  "post_response",
  "report_progress",
]);

type ToolHandler = (
  args: unknown,
  ctx: ServerContext,
) => unknown | Promise<unknown>;

/**
 * Wrap a tool handler so that, when the call is serving a relayed browser
 * prompt, it streams `tool_start` before and `tool_result` after to the web
 * chat. The agent (Claude CLI/Desktop) does not reliably narrate progress via
 * report_progress, but it always invokes the actual data tools -- and those
 * calls reach us -- so surfacing them gives the web chat live "Looking up ..."
 * progress automatically. Outside relay context `reportToolActivity` finds no
 * in-flight prompt and is a no-op.
 *
 * The `result` report is awaited inside a `finally`, where a throw would
 * replace the handler's own return value or mask its error -- so a successful
 * write would surface to the agent as a failure it then retries.
 * `reportToolActivity` therefore swallows its own failures by contract
 * (`ai-relay.service.ts`); this call site depends on that and must not be
 * changed to a bare call that leaves a rejection unhandled instead.
 */
export function wrapToolHandlerForRelay(
  name: string,
  handler: ToolHandler,
  relayService: AiRelayService,
): ToolHandler {
  return async (args, ctx) => {
    const key = callerKey(ctx);
    const userId = resolveUserContext(ctx)?.userId;
    // Every tool handler runs inside its caller's ambient context, so a write
    // deep inside one can tell whether it is serving this caller's relay turn
    // or is a direct MCP client's own call (see mcp-session-context.ts).
    return withMcpCaller(key, async () => {
      if (userId) {
        await relayService.reportToolActivity(
          userId,
          name,
          "start",
          false,
          key,
        );
      }
      let isError = false;
      try {
        const result = await handler(args, ctx);
        isError = Boolean(
          (result as { isError?: boolean } | undefined)?.isError,
        );
        return result;
      } catch (err) {
        isError = true;
        throw err;
      } finally {
        if (userId) {
          await relayService.reportToolActivity(
            userId,
            name,
            "result",
            isError,
            key,
          );
        }
      }
    });
  };
}

/**
 * Monkeypatch `server.registerTool` so every tool registered afterwards is
 * wrapped with `wrapToolHandlerForRelay` (relay control tools excepted). Must
 * run before the tool providers register their tools.
 */
export function installRelayToolActivity(
  server: McpServer,
  relayService: AiRelayService,
): void {
  const baseRegister = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    handler: ToolHandler,
  ) => unknown;

  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    handler: ToolHandler,
  ) => {
    if (RELAY_CONTROL_TOOLS.has(name)) {
      return baseRegister(name, config, handler);
    }
    return baseRegister(
      name,
      config,
      wrapToolHandlerForRelay(name, handler, relayService),
    );
  };
}
