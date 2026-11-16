import type { AiRelayService } from "../ai/relay/ai-relay.service";
import type { PendingAiAction } from "../ai/actions/ai-action.types";
import { currentMcpCallerKey } from "./mcp-session-context";

/**
 * The ONE way an MCP write tool offers its confirmation card to the web chat.
 *
 * Returns true when the relay took the card (it is shown in the browser and
 * committed via `/ai/actions/confirm` on approval, so the tool must NOT write);
 * false when this call is not part of a relay turn, so the tool falls back to
 * `confirmWrite` in the calling MCP client.
 *
 * Tools must not call `relayService.emitPendingAction` directly: the decision
 * depends on the *calling client*, which lives in the ambient MCP caller
 * context, and a call site that forgets to pass it sends a direct client's
 * confirmation to a web chat nobody is watching. `mcp-relay-confirm.spec.ts`
 * scans the tool sources and fails on a direct call.
 */
export function emitRelayCard(
  relayService: AiRelayService,
  userId: string,
  action: PendingAiAction,
): Promise<boolean> {
  return relayService.emitPendingAction(userId, action, currentMcpCallerKey());
}

/**
 * LLM-facing result returned by an MCP write tool when it is serving a relayed
 * browser prompt and has handed the confirmation off to the web chat as a
 * `pending_action` card. It mirrors the AI Assistant's own `preview_shown`
 * status: the write has NOT happened (the browser commits it via
 * `/ai/actions/confirm` on approval), so the agent must not retry or claim
 * success -- it should ask the user to review and approve the card.
 */
export const RELAY_PREVIEW_SHOWN = {
  status: "preview_shown",
  message:
    "A confirmation card was shown to the user in the Monize web chat. The action has NOT been performed yet -- it is applied only when the user approves the card there. Do not retry or say it is done; tell the user to review and approve the card.",
} as const;
