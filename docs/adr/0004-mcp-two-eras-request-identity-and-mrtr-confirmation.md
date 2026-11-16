# 0004. The MCP server serves two protocol revisions, with identity per request and confirmations that travel

Status: accepted
Date: 2026-09-03

## Context

MCP revision 2026-07-28 removes the two things the Monize MCP server was built
on. Sessions are gone: there is no `initialize`, no `Mcp-Session-Id`, and each
request carries its own `_meta` envelope. Server-initiated requests are gone
too: a server can no longer send an `elicitation/create` and wait, which is how
every write here was confirmed by a human.

Those two removals reach further into this server than they look. Identity came
from a session map. The web-chat relay decides "does this write belong to the
browser" by asking *which session* is calling. The confirmation dialog's
timeout, its per-session memory of clients that answer for themselves, and the
fallback that lets a write proceed when no dialog can reach a human are all
built around a server-side wait.

The SDK also changed underneath: `@modelcontextprotocol/sdk` 1.x is frozen at
1.30 and can never speak the new revision. The v2 packages can speak both, but
only by explicit opt-in.

Existing clients do not move on our schedule. Claude Desktop's connector,
`claude mcp add` and Codex all speak the 2025-era revisions today, and a
deployment that upgraded the server would break every one of them.

## Decision

**One endpoint serves both revisions from one server definition.** A request
the SDK's `isLegacyRequest` does not classify as 2025-era goes to
`createMcpHandler(..., { legacy: "reject" })`; everything else keeps the
sessionful transport. The SDK's own stateless legacy fallback is deliberately
not used, because it serves a 2025-era client from an instance that holds
nothing between rounds, and our 2025 confirmation is a wait.

**Identity is resolved per request on both revisions.** The transport validates
the bearer and attaches the result as the SDK's `AuthInfo`; a handler reads the
caller from the request. INV-MCP-001 is restated as a property of the request.
A 2025-era session keeps its credential binding, because a session is still a
thing a second credential could present.

**"Which session" becomes "which caller"**: the session id where there is one,
the credential id where there is not.

**A write confirmation travels rather than waits.** On 2026-07-28 the tool
answers with the question and the client calls it again with the answer. What
makes that safe is a signed `requestState`: bound to the credential and the
method, carrying a fingerprint of what the user was shown, and re-checked on
the round that writes.

**The fingerprint covers the change, not the round.** The two rounds are two
tool calls, so each rebuilds its descriptor with a fresh `actionId`,
`expiresAt` and attachment parking slot. Those are projected out
(`roundStableAction`) and everything that says what is being approved is
hashed. The alternative -- having each caller hand over a pre-trimmed action --
was rejected: it is a rule every one of thirty call sites has to remember, and
forgetting it fails closed but totally, refusing every confirmed write.

**Client ID Metadata Documents are deferred**; RFC 9207 `iss` is in scope and
already satisfied by the provider.

## Consequences

Every existing client keeps working, unchanged, while 2026-07-28 clients get
the stateless core: no sticky sessions, no session table to scale, a fresh
server per request.

A confirmed write on the new revision is **two HTTP requests**, so the endpoint's
rate limit had to rise, and individual approval mode had to become one round
carrying every card rather than a round per card.

**Two clients sharing one token now share a caller key.** On a 2025-era
connection two clients have two sessions and are told apart; on 2026-07-28 the
credential is the only stable per-client fact on the wire. A user running the
web-chat relay agent and a direct client on the same personal access token will
have the direct client's confirmations offered to the browser. The mitigation
is a sentence in the connect instructions telling them to mint the agent its
own token. This is the one place the upgrade makes something worse, and it is
recorded here rather than left for someone to discover.

**A confirmation is bounded by who and what, not by how many times.** The seal
carries no nonce and the server holds no record of a spent one, so the same
seal and the same answer, re-sent by the same credential against the same tool
within the ten-minute TTL, commits again. This is deliberate rather than
overlooked: the answer is client-asserted on this revision -- as it already is
on the 2025-era one, where a client can return `accept` without showing anyone
a dialog -- so a client able to replay a confirmation could equally have
fabricated the first one. Single-use would put the server-side record back that
the stateless core exists to remove, and would buy nothing against the only
attacker it could face.

The sessionful path is now the only part of the server with an end date. When
no client negotiates a 2025-era revision, `legacy: "reject"` on the whole
endpoint retires the session table, the elicitation-behaviour memory and the
server-side wait in one change.

## Alternatives considered

**Serve only 2026-07-28.** Simplest server, and it breaks every client in the
field on the day it deploys. The revision's own deprecation window is twelve
months; there is no reason for ours to be zero.

**Serve 2025-era traffic through the SDK's stateless legacy fallback** instead
of keeping our transport. It would delete the session table immediately, and it
would also delete the server-side wait a 2025-era confirmation is: a stateless
instance cannot hold one. That is a behaviour change to the clients we were
keeping compatibility for, which defeats the point.

**Use the SDK's `legacyShim` to answer `input_required` on 2025-era
connections**, so handlers are written once. The shim turns the returned
question into real server-initiated requests, which is the right idea, but it
cannot reproduce our fallback: a client that advertises elicitation and then
answers `-32601`, or never answers at all, must be read as "no dialog reached a
human" and allowed to proceed under its own approval prompt. That distinction
is behavioural and lives in `mcp-elicitation-support.ts`, so the era branch
stays ours.

**Keep the relay claim keyed on something else on the new revision** -- the
connection, the user, a time window. Every one of those was tried before, on
sessions, and each routed a direct client's confirmation into a web chat nobody
was watching; the worst version captured every direct write the user made
afterwards. The credential is the narrowest key the wire actually carries.

**Store the pending confirmation on the server, keyed by an id the client
quotes.** It would let the second round carry less, and it would put session
state back into a protocol that just removed it -- with a TTL to tune, a store
to scale across replicas, and a new way for a confirmation to be lost. The
signed state has none of that: the server holds nothing.

**Sign the state with a new secret.** `JWT_SECRET` is enforced at startup;
`ENCRYPTION_KEY` is not (a deployment without one boots and is warned). A
confirmation whose integrity silently depended on an unset variable is the
failure mode this decision exists to avoid, so the key is derived from
`JWT_SECRET` with its own label, as `AiActionSigningService` already does.

## Addendum, 2026-09-18: a 2025-era session is pinned to its replica

This ADR said the new revision gets "no sticky sessions"; it did not say what the
old one gets. Horizontal scaling (`docs/specs/horizontal-scaling.md`, WP6)
asked the question directly: persist `session_id -> user_id` and rebuild the
transport on any replica, or document sticky routing. The instruction was to
decide by reading the SDK.

**Read, on `@modelcontextprotocol/{server,node}` 2.0.0: it cannot be rebuilt.**
`NodeStreamableHTTPServerTransport.sessionId` is a getter with no setter, so a
persisted id cannot be assigned. `_initialized` is private and set only by
handling an `initialize` request, so a transport built from a row answers `400
Bad Request: Server not initialized` to the first request that uses it. Both are
pinned as tests in `mcp-http.controller.spec.ts`.

Persisting the row would not have been enough even with a seam to put it back.
The state a 2025-era exchange is holding is the open response stream on that
pod's socket, the `Protocol._responseHandlers` entry carrying the promise a
`confirmWrite` elicitation is waiting on, and the per-`McpServer` behaviour
record in `mcp-elicitation-support.ts`. A session id addresses none of them. A
table would have made the id resolvable and the session no more servable -- the
worst of the two outcomes, because it looks like the problem is solved.

**So: sticky routing, on the MCP path only, off by default** (`mcp.stickySessions`).
Two things the implementation had to account for that the plan did not anticipate:
the MCP path has to be routed straight to the backend Service, because every
other path is served by the frontend's proxy and pinning the frontend pod leaves
kube-proxy spreading its server-side fetch across backend replicas; and cookie
affinity pins only clients that keep cookies, which is not all of them.

The honest statement of the limit is therefore narrower than "sticky routing
fixes it": under `CLUSTER_MODE=multi`, a deployment serving 2025-era clients
wants one backend replica, or clients that keep the affinity cookie, or clients
that speak 2026-07-28. What the absence of stickiness costs is specific -- a
misrouted session id is answered `404` and the client re-initializes, so reads
recover, but a confirmation in flight is lost and its write completes under the
client's own approval prompt instead of the dialog's.

This sharpens rather than changes the end date already recorded above. Retiring
the 2025-era path retires the sticky-routing requirement with it.
