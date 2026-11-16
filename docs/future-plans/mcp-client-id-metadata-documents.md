# Client ID Metadata Documents for the MCP authorization server

Status: **planned**. Nothing here is implemented. Dynamic Client Registration
is enabled and working; this note records why CIMD was left out of the
2026-07-28 upgrade and what adopting it would involve.

## What the revision says

Revision 2026-07-28 deprecates OAuth 2.0 Dynamic Client Registration in favour
of Client ID Metadata Documents: instead of registering and being issued a
`client_id`, a client presents an HTTPS URL as its `client_id`, and the
authorization server fetches that URL to learn the client's metadata. DCR
remains functional during the deprecation window (a minimum of twelve months
from the revision), and the specification does not require CIMD.

## Why it is not in the upgrade

CIMD is an authorization-server feature, not a protocol-surface one: nothing
about how Monize serves MCP requests changes with it. Adopting it means
accepting a URL where a client id is expected, fetching it, validating the
document, and deciding what to do about every failure mode that fetch has --
which is a new outbound request made on behalf of an unauthenticated caller,
with all the SSRF questions that implies. `validateUrlIsSafe`
(`backend/src/ai/validators/safe-url.validator.ts`) is the existing answer to
that class of question and would have to cover this one.

No client this deployment serves asks for it today: Claude Desktop's connector
flow, `mcp-remote` and the CLI all register dynamically.

## What it would take

- A `client_id` that is a URL is fetched, size-capped and timed out, through
  the same host-safety check outbound provider calls already use.
- The fetched document is validated (redirect URIs, grant types, response
  types) and cached with an explicit lifetime, because it is re-read on every
  authorization.
- `node-oidc-provider` has no built-in CIMD support at 9.8.x, so this is a
  client-resolution hook rather than a configuration flag; check the version in
  use before assuming otherwise.
- The failure modes need answers a person can act on: an unreachable document,
  one that changed between authorizations, and one whose redirect URIs no
  longer match the request.

## When to revisit

Before the deprecation window closes, or as soon as a client Monize wants to
serve presents a URL as its `client_id`. Until then DCR stays enabled and the
`iss` parameter (RFC 9207), which the same revision asks for, is already on
every authorization response.
