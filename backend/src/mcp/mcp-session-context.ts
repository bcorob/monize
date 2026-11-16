import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The caller key of the tool call currently executing, made ambient by the
 * per-call wrapper in `mcp-relay-tool-activity.ts` so code deep inside a tool
 * handler can tell WHICH client is calling without threading it through every
 * helper signature.
 *
 * This exists because "which client is this" is a correctness question, not a
 * diagnostic one: a reverse-relay turn belongs to the one caller that claimed
 * the prompt, and a write arriving from any other caller of the same user is a
 * direct MCP client's -- its confirmation belongs in that client, not in the
 * web chat. Keyed on userId alone, one abandoned web-chat turn captured every
 * direct write the user made afterwards.
 *
 * The key is the session id on a 2025-era connection and the credential id on a
 * 2026-07-28 request, which has no session (`callerKey` in `mcp-context.ts`).
 *
 * Absent means "cannot prove which client" -- callers must treat that as a
 * direct client (confirm locally), never as a relay turn.
 */
const callerStorage = new AsyncLocalStorage<{ callerKey?: string }>();

export function withMcpCaller<T>(
  callerKey: string | undefined,
  fn: () => T,
): T {
  return callerStorage.run({ callerKey }, fn);
}

export function currentMcpCallerKey(): string | undefined {
  return callerStorage.getStore()?.callerKey;
}
