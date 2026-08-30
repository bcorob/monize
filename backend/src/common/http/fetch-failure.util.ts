/**
 * What a caught outbound-HTTP error actually was, in one line.
 *
 * `fetch` rejects with `TypeError: fetch failed` for every transport failure
 * there is -- DNS, TLS, a refused connection, a proxy that closed the socket,
 * an `AbortSignal.timeout` firing -- and puts the only useful part in
 * `error.cause`. Logging `error.message` (or its stack, which is worse: the
 * frames are all undici's) produced the log this exists to replace, thousands
 * of times over: `TypeError: fetch failed` and nothing an operator could act
 * on. Issue #1265 was diagnosed from the container's network configuration,
 * not from the log, because the log did not carry the cause.
 *
 * So the log line names the cause chain and the socket-level details undici
 * hangs off it. Bounded on purpose: the same string is written to
 * `provider_health.last_failure_reason` and rendered into an alert email, so it
 * may not be a page of nested causes.
 */

/** How deep the `cause` chain is followed. Undici nests two; five is slack. */
const MAX_CAUSE_DEPTH = 5;

/** Longest description returned. Long enough for a cause chain plus details. */
export const MAX_FETCH_FAILURE_LENGTH = 300;

/**
 * Error codes that mean the request never got an answer.
 *
 * These are the ones that make a provider "unavailable" rather than
 * "unhappy with this request": an HTTP status, however bad, proves the service
 * answered. `UND_ERR_*` are undici's own; the rest are libuv/OpenSSL.
 */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "EPROTO",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
]);

/** Error names an aborted or timed-out request rejects with. */
const TIMEOUT_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "TimeoutError",
]);

/** The socket-level fields undici and libuv attach, in the order shown. */
const DETAIL_KEYS = [
  "code",
  "errno",
  "syscall",
  "hostname",
  "address",
  "port",
] as const;

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
  readonly [key: string]: unknown;
}

/** The error and its causes, outermost first, bounded and cycle-safe. */
function causeChain(error: unknown): readonly ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== null &&
    current !== undefined &&
    chain.length < MAX_CAUSE_DEPTH &&
    !seen.has(current)
  ) {
    seen.add(current);
    if (typeof current === "object" || typeof current === "function") {
      const link = current as ErrorLike;
      chain.push(link);
      current = link.cause;
      continue;
    }
    chain.push({ message: String(current) });
    break;
  }
  return chain;
}

/** A string field of an error object, or null when it carries nothing usable. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

/** `name: message` for one link, without the redundant `Error:` prefix. */
function summarize(link: ErrorLike): string | null {
  const name = text(link.name);
  const message = text(link.message);
  if (name && message) {
    return name === "Error" ? message : `${name}: ${message}`;
  }
  return message ?? name;
}

/**
 * The first `code` anywhere in the chain -- the field that says *what* failed.
 *
 * Read from the whole chain, not the outermost error: undici's `TypeError` has
 * no code at all, and the `ECONNREFUSED` sits two links down.
 */
export function fetchFailureCode(error: unknown): string | null {
  for (const link of causeChain(error)) {
    const code = text(link.code);
    if (code) return code;
  }
  return null;
}

/**
 * True when the error says the request never reached an answering server.
 *
 * This is the signal a circuit breaker counts, so the distinction matters: a
 * 404 or a malformed JSON body is this request's problem, while `EAI_AGAIN` is
 * the provider's (or the container's DNS) and every subsequent request will hit
 * it too. `fetch` rejecting with `TypeError: fetch failed` is transport by
 * definition -- undici only rejects that way when no response arrived.
 */
export function isTransportFailure(error: unknown): boolean {
  const chain = causeChain(error);
  for (const link of chain) {
    const code = text(link.code);
    if (code && TRANSPORT_CODES.has(code)) return true;
    const name = text(link.name);
    if (name && TIMEOUT_NAMES.has(name)) return true;
    if (name === "TypeError" && text(link.message) === "fetch failed") {
      return true;
    }
  }
  return false;
}

/**
 * One log-safe line describing a caught outbound-HTTP failure.
 *
 * Shape: `TypeError: fetch failed <- Error: getaddrinfo EAI_AGAIN query1.finance.yahoo.com
 * [code=EAI_AGAIN syscall=getaddrinfo hostname=query1.finance.yahoo.com]`.
 * The chain is what a human reads; the bracketed details are what they grep.
 */
export function describeFetchFailure(error: unknown): string {
  const chain = causeChain(error);
  if (chain.length === 0) return "unknown error";

  const summaries: string[] = [];
  for (const link of chain) {
    const summary = summarize(link);
    // A cause that only repeats its parent's text adds nothing to the line.
    if (summary && !summaries.includes(summary)) summaries.push(summary);
  }

  const details: string[] = [];
  for (const key of DETAIL_KEYS) {
    for (const link of chain) {
      const value = text(link[key]);
      if (value) {
        details.push(`${key}=${value}`);
        break;
      }
    }
  }

  const line =
    summaries.join(" <- ") +
    (details.length > 0 ? ` [${details.join(" ")}]` : "");
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_FETCH_FAILURE_LENGTH
    ? `${collapsed.slice(0, MAX_FETCH_FAILURE_LENGTH - 3)}...`
    : collapsed || "unknown error";
}
