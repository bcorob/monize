import { Agent, fetch as undiciFetch } from "undici";
import {
  AiEgressPolicy,
  assertPublicIpLiteral,
  privateTargetAllowed,
  publicOnlyLookup,
} from "./provider-egress";

/**
 * Shared dispatcher used for long-running AI provider requests.
 *
 * Node's built-in fetch (undici under the hood) defaults `bodyTimeout` and
 * `headersTimeout` to 5 minutes. That's far too aggressive for CPU-only
 * inference on slow hardware (e.g. an Intel N100), where the gap between
 * the request and the first generated token can easily exceed 5 minutes
 * for a cold model with a long financial-context prompt. When the timer
 * fires, undici aborts the stream and the caller sees a generic
 * "fetch failed" error.
 *
 * Setting both timeouts to 0 disables them entirely. The provider code
 * still caps the total request time with its own AbortController, so a
 * runaway request can't hang forever.
 *
 * This agent places no restriction on the address it connects to; it serves
 * only a request whose egress policy allows a private target (see
 * `provider-egress.ts`).
 */
export const longRunningAgent = new Agent({
  bodyTimeout: 0,
  headersTimeout: 0,
});

/**
 * The same timeouts, with a lookup that refuses every private answer: the
 * dispatcher for a request that may only reach a public host.
 */
export const publicOnlyAgent = new Agent({
  bodyTimeout: 0,
  headersTimeout: 0,
  connect: { lookup: publicOnlyLookup },
});

function requestUrl(input: Parameters<typeof undiciFetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL((input as { url: string }).url);
}

/**
 * The fetch every AI provider sends through, under one egress policy.
 *
 * We MUST call `undici.fetch` (from the npm package) rather than
 * `globalThis.fetch` -- Node bundles its own internal copy of undici, and its
 * built-in fetch silently ignores or rejects a `dispatcher` option that came
 * from a separately-installed undici package, because the two `Agent` classes
 * have different internal identities. Using undici's own fetch guarantees the
 * dispatcher is honored.
 *
 * Redirects are never followed (`redirect: "error"`): the address policy is
 * decided for the URL the provider was configured with, and a 3xx from that
 * host would otherwise send the request -- headers, API key and all -- to a
 * target nobody checked.
 *
 * The signature is widened to `typeof fetch` so SDK clients (Anthropic,
 * OpenAI) that accept a `fetch` option can use this drop-in replacement.
 * undici's Response type is structurally compatible with the global one
 * but TS sees them as distinct (Symbol.dispose), so we cast through
 * unknown.
 */
export function providerFetch(policy: AiEgressPolicy): typeof fetch {
  return (async (
    input: Parameters<typeof undiciFetch>[0],
    init?: Parameters<typeof undiciFetch>[1],
  ) => {
    const url = requestUrl(input);
    const privateAllowed = privateTargetAllowed(url, policy);
    if (!privateAllowed) assertPublicIpLiteral(url);
    return undiciFetch(input, {
      ...init,
      redirect: "error",
      dispatcher: privateAllowed ? longRunningAgent : publicOnlyAgent,
    });
  }) as unknown as typeof fetch;
}

/**
 * The unrestricted provider fetch (`any`), for the operator's own
 * `AI_DEFAULT_*` provider. Still never follows a redirect.
 */
export const longRunningFetch: typeof fetch = providerFetch("any");
