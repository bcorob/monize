/**
 * How to run a turn that serves a prompt from the Monize web chat.
 *
 * This used to live in the server `instructions` and in the three relay tool
 * descriptions, so every MCP client -- Claude Desktop, an IDE agent, anything
 * that never relays -- carried roughly 4 KB of it in context on every request.
 * It is returned with a CLAIMED prompt instead: the only turn it applies to,
 * and the only turn that pays for it.
 *
 * Keep it as instructions to the agent handling this prompt, not as a
 * description of the relay.
 */
export const RELAY_TURN_GUIDANCE = [
  "You are answering a prompt from the Monize web chat. The chat shows the user a 'your assistant went quiet' message when it hears nothing from you for a few minutes, and your own thinking time is silent to it.",
  "- Send report_progress IMMEDIATELY, before reading attachments or planning, with a brief plan and a rough estimate. Then send one at least every minute or two.",
  "- Think briefly, then act. The relay sees only your tool calls, progress updates and final answer -- never your reasoning -- so a long silent think is indistinguishable from a dead agent, and the answer is dropped once the turn times out. Break analysis into small tool calls and narrate decisions instead of deliberating.",
  "- Make each update say what you just did, what is left and a rough estimate.",
  "- Batch large work: about 25 items per manage_* call, with a report_progress before each. Do not compose one enormous call.",
  "- delivered:false is not a reason to stop. Confirmation cards and your final post_response are buffered and shown when the chat reconnects.",
  "- Always finish with post_response, even after the last confirmation card: say that every batch has been sent, ask the user to review and approve the cards, and tell them you are waiting. A card is a pending approval, not a reply.",
  "",
  "Entity links: markdown links with these URIs render as in-app links in the web chat, and nowhere else.",
  "- [Name](monize://account/<id>), monize://payee/<id>, monize://category/<id>, monize://transaction/<id>, monize://security/<securityId>, monize://scheduled/<id>",
  "- Use securityId from get_portfolio_summary holdings (not the ticker) and the id from list_upcoming_bills items. Only ids copied verbatim from a tool result in this conversation; never construct one. A row with no id (an aggregated 'Other', 'Uncategorized', a free-text payee) is mentioned as plain text.",
  "- Never print a raw monize:// URI: always give the link a human-readable label. Do not link brokerage accounts.",
].join("\n");
