import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { RELAY_PREVIEW_SHOWN, emitRelayCard } from "./mcp-relay-confirm";
import { withMcpCaller } from "./mcp-session-context";
import type { AiRelayService } from "../ai/relay/ai-relay.service";
import type { PendingAiAction } from "../ai/actions/ai-action.types";

const TOOLS_DIR = join(__dirname, "tools");

describe("emitRelayCard", () => {
  const action = { actionId: "a1" } as PendingAiAction;

  function relayDouble() {
    return {
      emitPendingAction: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<Pick<AiRelayService, "emitPendingAction">>;
  }

  it("passes the ambient MCP session id through to the relay", async () => {
    const relay = relayDouble();

    await withMcpCaller("session-abc", () =>
      emitRelayCard(relay as unknown as AiRelayService, "user-1", action),
    );

    expect(relay.emitPendingAction).toHaveBeenCalledWith(
      "user-1",
      action,
      "session-abc",
    );
  });

  it("passes undefined when there is no ambient session (cannot prove a relay turn)", async () => {
    const relay = relayDouble();

    await emitRelayCard(relay as unknown as AiRelayService, "user-1", action);

    expect(relay.emitPendingAction).toHaveBeenCalledWith(
      "user-1",
      action,
      undefined,
    );
  });

  it("returns whatever the relay decided", async () => {
    const relay = relayDouble();
    (relay.emitPendingAction as jest.Mock).mockResolvedValue(true);
    await expect(
      emitRelayCard(relay as unknown as AiRelayService, "user-1", action),
    ).resolves.toBe(true);
  });

  it("exposes the preview_shown status that says the write has NOT happened", () => {
    expect(RELAY_PREVIEW_SHOWN.status).toBe("preview_shown");
  });
});

/**
 * A write tool that calls `relayService.emitPendingAction` directly drops the
 * ambient session id, and the relay then cannot tell this user's relay turn
 * from a second, direct MCP client of the same user -- which is how a direct
 * client's confirmation card ended up in a web chat nobody was watching. The
 * rule is mechanical, so it is checked mechanically rather than left in prose.
 */
describe("MCP tools use the shared card emitter", () => {
  const toolFiles = readdirSync(TOOLS_DIR).filter(
    (f) => f.endsWith(".tool.ts") && !f.endsWith(".spec.ts"),
  );

  it("finds the tool sources to scan", () => {
    expect(toolFiles.length).toBeGreaterThan(0);
  });

  it.each(toolFiles)("%s never calls emitPendingAction directly", (file) => {
    const source = readFileSync(join(TOOLS_DIR, file), "utf8");
    expect(source).not.toMatch(/\.emitPendingAction\s*\(/);
  });

  // The relay's answer now comes from a row, so emitRelayCard returns a
  // promise. An unawaited call is always truthy, which reads as "the relay took
  // the card" everywhere -- so the write is skipped, no card is shown, and the
  // user's request silently does nothing. Mechanical mistake, mechanical check.
  it.each(toolFiles)("%s awaits every emitRelayCard call", (file) => {
    const source = readFileSync(join(TOOLS_DIR, file), "utf8");
    for (const match of source.matchAll(/(.{0,10})emitRelayCard\s*\(/g)) {
      // The import line names it without calling it.
      if (match[0].startsWith("import")) continue;
      expect(match[1]).toMatch(/await $/);
    }
  });
});
