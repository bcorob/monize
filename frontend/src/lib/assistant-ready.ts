import { aiApi } from '@/lib/ai';

/**
 * Whether the assistant in the chat can answer RIGHT NOW: an AI provider is
 * configured AND, when the user's top provider is the MCP relay (their own agent
 * over MCP), that agent is connected. Both facts already have endpoints
 * (`GET /ai/status`: `configured`, `relayActive`; `GET /ai/relay/status`:
 * `state`), and the second one changes by the minute, so it is read fresh at the
 * moment of the decision instead of from the cached status.
 *
 * Why not just `configured`: a relay that is configured but whose agent is not
 * connected fails the chat with "Your MCP relay agent is not connected". A
 * surface that stages a chat for the assistant must offer the queue instead when
 * the answer is no.
 *
 * "We could not ask" is not "yes": a failed read of either endpoint is `false`,
 * the same rule `useAiConfigured` keeps, so the fallback (the request waits in the
 * AI review inbox for an agent) is the one a failure lands on.
 */
export async function assistantCanAnswerNow(): Promise<boolean> {
  let status;
  try {
    status = await aiApi.getStatus();
  } catch {
    return false;
  }
  if (!status.configured) return false;
  if (!status.relayActive) return true;
  try {
    const relay = await aiApi.getRelayStatus();
    // `busy` is an agent working on another prompt: connected, and it will get to this one.
    return relay.state === 'listening' || relay.state === 'busy';
  } catch {
    return false;
  }
}
