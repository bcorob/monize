import type { ServerContext } from "@modelcontextprotocol/server";
import type { McpUserContext } from "../mcp-context";
import { toAuthInfo } from "../mcp-context";

/**
 * Test helper: the `ServerContext` the SDK hands a tool, resource or prompt
 * handler.
 *
 * Identity reaches a handler as the request's own `AuthInfo` (`toAuthInfo` ->
 * `resolveUserContext`), so a spec builds the context rather than mocking a
 * resolver. `setUser` swaps the caller mid-test, which is what the old
 * `resolve.mockReturnValue(...)` did.
 *
 * The default carries a `sessionId`, i.e. a 2025-era connection: that is the
 * era where a server-initiated elicitation exists, and the era whose caller key
 * is the session id. Pass `sessionId: undefined` for a 2026-07-28 request.
 */
export interface McpTestContext extends ServerContext {
  setUser(user?: McpUserContext): void;
}

export interface McpTestContextOptions {
  /** Session id, i.e. a 2025-era connection. Pass undefined for 2026-07-28. */
  sessionId?: string;
  /** The `ctx.mcpReq.elicitInput` a write confirmation goes out through. */
  elicitInput?: jest.Mock;
  /** Multi-round-trip state already verified for this round. */
  requestState?: unknown;
  /** Multi-round-trip answers carried by a retried request. */
  inputResponses?: Record<string, unknown>;
  /** The per-request `_meta` envelope; presence marks a 2026-07-28 request. */
  envelope?: Record<string, unknown>;
}

export function mcpTestCtx(
  user?: McpUserContext,
  options: McpTestContextOptions = {},
): McpTestContext {
  const { sessionId = "s1", elicitInput = jest.fn() } = options;
  // Every real request carries a credential (the transport refuses one it
  // cannot identify), so a spec that only states a user and scopes still gets a
  // bindable context.
  const withCredential = (u?: McpUserContext) =>
    u ? { credentialId: "pat:t1", ...u } : undefined;
  const authInfoFor = (u?: McpUserContext) => {
    const resolved = withCredential(u);
    return resolved ? toAuthInfo(resolved, "tok") : undefined;
  };
  const ctx = {
    sessionId,
    mcpReq: {
      id: "req-1",
      method: "tools/call",
      envelope: options.envelope,
      inputResponses: options.inputResponses,
      requestState: () => options.requestState,
      signal: new AbortController().signal,
      send: jest.fn(),
      notify: jest.fn(),
      log: jest.fn(),
      elicitInput,
      requestSampling: jest.fn(),
    },
    http: { authInfo: authInfoFor(user) },
    setUser(next?: McpUserContext) {
      ctx.http = { authInfo: authInfoFor(next) };
    },
  };
  return ctx as unknown as McpTestContext;
}
