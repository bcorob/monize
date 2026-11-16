# Context-aware MCP tool listing

Design for replacing the MCP server's flat `tools/list` -- the same 25 tools,
the same instructions, to every caller -- with a listing the server composes
per caller from what it already knows about the request: the protocol era,
the credential's scopes and kind, the user's role, and which parts of Monize
the user actually uses. The task list is
[`mcp-context-aware-listing-tasks.md`](./mcp-context-aware-listing-tasks.md).
This plan carries its own contracts, truth table and recorded measurements
(sections 5 to 8) because there is no separate spec for it.

Status: **proposal**. The decisions in section 3 are recorded with their
alternatives; the open questions in section 15 carry a recommended default
and await Ken. Nothing here is implemented.

## 1. Goal

- A caller pays, on every request, only for the tools it can use. A read-only
  token never carries nine write tools it cannot call; a user with no
  brokerage account never carries six investment tools; a client that will
  never relay the web chat never carries the three relay tools and the relay
  section of the instructions.
- Nothing about authorization moves. Every handler keeps its own
  `requireScope` and role check; the listing is a projection of what the
  handler would allow, never a substitute for it (INV-MCP-005, section 3,
  decision 1).
- The two protocol eras keep answering from one definition
  (`docs/backend/mcp.md`, "Two protocol revisions, one definition"): the same
  context yields the same list on a 2026-07-28 request and on a 2025-era
  session, and `mcp-eras.spec.ts` keeps proving it.
- The `tools/list` byte budget (`tools-list-budget.spec.ts`) keeps measuring
  the full list, and a second measurement pins what each context sees.
- No schema change in the first delivery. Every context fact is read from a
  row that already exists.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
| --- | --- | --- |
| A server per request (2026-07-28) and per session (2025-era) | `backend/src/mcp/mcp-http.controller.ts`: `createMcpHandler(() => this.mcpServerService.createServer(), { legacy: "reject" })` for the modern leg; `new NodeStreamableHTTPServerTransport` + `createServer()` on a 2025-era `initialize` | The v2 SDK (`@modelcontextprotocol/server` 2.3.1) already hands the modern factory a `McpRequestContext` (`era`, `authInfo`, `requestInfo`); the zero-argument factory ignores it today. On the 2025-era path the controller holds the validated credential before it builds the server. |
| Identity on the request | `backend/src/mcp/mcp-context.ts`: `toAuthInfo`, `resolveUserContext`, `callerKey`, `requireScope` | The scopes and the credential id (`pat:<id>` or `oauth:<grant>`) ride on every request as the SDK `AuthInfo`. The credential kind is the prefix of `credentialId`. |
| The one factory | `backend/src/mcp/mcp-server.service.ts` `createServer()` | Registers fourteen tool providers, five resources and four prompts in a fixed order; builds the instructions as one string; declares `cacheHints` with a one-hour `tools/list` TTL whose comment says the honest lifetime is "until this deployment changes". That sentence stops being true here. |
| The SDK's own listing switch | `RegisteredTool.enable()` / `disable()`; `tools/list` returns only `enabled` tools; `tools/call` on a disabled tool answers `InvalidParams` "Tool X disabled"; `McpServer.sendToolListChanged()` is a no-op until the transport is connected and a real `notifications/tools/list_changed` after | Verified in the 2.3.1 sources. `disable()` before `connect()` therefore emits nothing; on a connected 2025-era session it tells the client the list changed. `capabilities.tools.listChanged` is advertised `true` by default. |
| The mandatory method header on 2026-07-28 | The SDK refuses a modern request POST without `Mcp-Method` (`standard-header-validation`, SEP-2243) | So the factory can read the method from `requestInfo.headers.get("mcp-method")` and know whether it is building a server for a listing or for a call. |
| A wrapper around `registerTool` | `backend/src/mcp/mcp-relay-tool-activity.ts` `installRelayToolActivity` | The precedent for a seam that runs before the providers register. The listing projection is a second wrapper of the same shape: it keeps the `RegisteredTool` each provider registers and disables the ones the context hides. |
| The per-user facts a listing needs | `users.role` (`BondSeriesService.isAdministrator`, `backend/src/bonds/bond-series.service.ts`); `accounts.account_sub_type`; `budgets`; `scheduled_transactions`; `transaction_rules.actions` (JSONB, `request_ai_review`); `email_receipt_mailboxes`; `INSTALLED_BOND_ADAPTERS` (`backend/src/bonds/bond-adapters.ts`) | Six `EXISTS` reads under RLS plus one constant. `database/schema.sql` is the authority on the column names; the task names them. |
| The AI Assistant's own context gating | `backend/src/ai/query/ai-query.service.ts` filters `FINANCIAL_TOOLS` by `excludeTools` (`NETWORK_WRITING_TOOL_NAMES` when the prompt carries untrusted content) | A precedent for "the offered set depends on the run". It is per run, not per user; this plan does not change it (section 13). |
| The tools' own tests | `backend/src/mcp/tools-list-budget.spec.ts`, `backend/src/mcp/mcp-annotations.spec.ts`, `backend/src/mcp/testing/collect-tool-configs.ts` | The budget spec serializes the real list through the SDK; the annotation spec pins every tool's hints from the same captured configs. The visibility table is pinned against the same capture (section 9). |
| The relay's own guidance | `backend/src/mcp/relay-guidance.ts` | The precedent for "guidance for one kind of turn travels with that turn". The relay section of the instructions follows the relay tools (section 6). |

## 3. Decisions

1. **The listing is a projection; the handler is the authority (INV-MCP-005).**
   Every tool stays registered on every server instance, every handler keeps
   its `requireScope` and role check unchanged, and the projection only
   decides what `tools/list` shows. On a 2026-07-28 request the projection is
   applied only when the request IS a listing (`tools/list`,
   `resources/list`, `resources/templates/list`, `prompts/list`), so a call
   always reaches the handler and is refused there, exactly as today. On a
   2025-era session the SDK's `enabled` switch is the projection, so a call
   to a hidden tool is answered by the SDK ("Tool X disabled") rather than by
   the handler; both are refusals, and the handler check behind it is still
   there. Rejected: resolving authorization in the listing and dropping the
   handler checks, because a client that cached an older list, or that never
   lists at all, must still be refused by the same rule; the listing is
   advisory by protocol design (clients cache it).
2. **One context, built by the transport, from facts in cost order.** A
   `McpListingContext` has `era`, `scopes`, `credentialKind` (`pat` or
   `oauth`) and `facts`. The first three are free: they come from the
   validated credential and the SDK's request context. `facts` is one query
   (section 5) and is resolved only when a listing is being built: on the
   2026-07-28 path when `Mcp-Method` names a listing method, on the 2025-era
   path once at `initialize` and again after a write this session made
   (decision 7). A `tools/call` on the modern path never runs the query.
   Rejected: computing facts on every request, which would add a database
   round trip to every tool call for a list the call does not read.
3. **Visibility is a named rule per tool, in one table.** `TOOL_VISIBILITY`
   in `backend/src/mcp/mcp-listing.ts` maps every tool name to a rule
   (`always`, `write`, `investments`, ...; section 4). A guard fails when a
   registered tool has no rule or a rule names no tool, in the shape of
   `mcp-annotations.spec.ts`. Rejected: a field in each `registerTool`
   config, because the SDK sends `_meta` on the wire (bytes on every request)
   and the config has no other slot; and a table is the one place a guard can
   check against the registration.
4. **A write-annotated tool is listed to `write` only.** The rule follows the
   annotation (`readOnlyHint: false`), not the operations: the reads folded
   into write tools (`manage_transaction_rules` list and test,
   `manage_securities` list, `ai_review_requests` list,
   `email_receipt_parsers` test and categories) are not offered to a read-only
   token. They were folded to save bytes for the common write token; a
   read-only token that needs them is the rarer case and the cost is a tool
   error naming the scope, as today. Recorded as open question 2 so Ken can
   reverse it.
5. **Presence facts hide what the user cannot use, never what the user
   could create through MCP.** A tool is presence-gated only when nothing on
   the MCP surface can create the thing it needs: no tool creates an account,
   a budget, a scheduled transaction or a mailbox, so the investment tools,
   `get_budget_status`, `list_upcoming_bills` and `email_receipt_parsers` can
   be gated on their rows existing. `manage_transaction_rules` creates rules,
   so it is never presence-gated; `ai_review_requests` is gated on a source
   of requests existing (a `request_ai_review` rule or an enabled mailbox),
   not on a request existing, because the queue agent must be able to poll an
   empty queue.
6. **A failed facts query lists everything the free facts allow.** Facts are
   `undefined` when the query throws, and every presence rule reads
   `undefined` as "show". Hiding on failure makes the model tell the user a
   capability does not exist; showing on failure costs bytes. The failure is
   logged once per instance through the NestJS `Logger`.
7. **A 2025-era session re-evaluates after its own writes.** After a write
   tool call that was not refused, the session recomputes `facts` and applies
   the table again; the SDK emits `notifications/tools/list_changed` for each
   `enable()`/`disable()` that changed something. Writes made in the web UI
   are not observed; the session's TTL (one hour) and the client's own
   re-listing cover them. Rejected: watching for data changes, because the
   session cannot see writes made elsewhere and a poll would cost more than
   the bytes it saves.
8. **The relay tools follow the credential kind.** `get_next_prompt`,
   `post_response`, `report_progress` and the `monize://relay-attachment`
   resource are listed to PAT credentials and hidden from OAuth grants: the
   relay agent is a scripted client holding a token minted for it
   (`docs/backend/mcp.md`, "A relay turn belongs to one caller"), while an
   OAuth grant comes from an interactive connector flow that never runs the
   loop. This is open question 1; if Ken answers "no", the rule is `always`
   and nothing else in the plan changes. Rejected for now: a `purpose`
   column on the token (a migration, a form field and a second way to be
   wrong), which section 13 keeps as the follow-up if the kind proves too
   coarse.
9. **The instructions are projected by the same rules.** The instructions
   string becomes sections, each carrying the visibility rule of the tools it
   describes (section 6). The byte budget on the instructions is measured on
   the full projection, which is the largest.
10. **The listing TTL drops from one hour to ten minutes.** The listing now
    depends on facts that change, so the honest lifetime is "until the user
    adds the first budget", which the server cannot see from a 2026-07-28
    request. Ten minutes bounds that staleness at one `tools/list` per ten
    minutes per client. Open question 3 carries the number.
11. **Prompts are not projected.** `prompts/list` is four short templates and
    is requested separately from `tools/list`; projecting it would add rules
    for no measurable saving. Section 13.

## 4. The visibility table

The rules, as named in `TOOL_VISIBILITY`:

| Rule | Listed when |
| --- | --- |
| `always` | the credential holds `read` (every credential does) |
| `write` | the credential holds `write` |
| `investments` | `read` and `facts.hasInvestmentAccounts` is not `false` |
| `investments+write` | `write` and `facts.hasInvestmentAccounts` is not `false` |
| `budgets` | `read` and `facts.hasBudgets` is not `false` |
| `scheduled` | `read` and `facts.hasScheduledTransactions` is not `false` |
| `ai-review` | `write` and (`facts.hasAiReviewRules` or `facts.hasEmailReceiptMailbox`) is not `false` |
| `email-receipts` | `write` and `facts.hasEmailReceiptMailbox` is not `false` |
| `bonds` | `write` and `INSTALLED_BOND_ADAPTERS` is non-empty |
| `bonds+admin` | `bonds` and `facts.isAdministrator` is `true` |
| `relay` | the credential kind is `pat` (decision 8) |

"Is not `false`" is decision 6: an absent fact shows the tool. `isAdministrator`
is the one fact that hides on absence, because the handler refuses a
non-administrator and a tool the caller can never use is not worth showing
on a failed read.

| Tool | Rule | Annotation today |
| --- | --- | --- |
| `list_accounts` | `always` | READ_ONLY |
| `list_transactions` | `always` | READ_ONLY |
| `compare_periods` | `always` | READ_ONLY |
| `manage_transactions` | `write` | destructive |
| `list_categories` | `always` | READ_ONLY |
| `list_payees` | `always` | READ_ONLY |
| `manage_payees` | `write` | destructive |
| `generate_report` | `always` | READ_ONLY |
| `get_portfolio_summary` | `investments` | READ_ONLY |
| `list_investment_transactions` | `investments` | READ_ONLY |
| `list_capital_gains` | `investments` | READ_ONLY |
| `lookup_securities` | `investments` | READ_ONLY |
| `manage_securities` | `investments+write` | destructive |
| `manage_investment_transactions` | `investments+write` | destructive |
| `list_upcoming_bills` | `scheduled` | READ_ONLY |
| `calculate` | `always` | READ_ONLY |
| `get_budget_status` | `budgets` | READ_ONLY |
| `manage_transaction_rules` | `write` | destructive |
| `ai_review_requests` | `ai-review` | CREATE |
| `email_receipt_parsers` | `email-receipts` | CREATE |
| `fetch_bond_series` | `bonds` | UPDATE, open-world |
| `enter_bond_series_manually` | `bonds+admin` | CREATE |
| `get_next_prompt` | `relay` | READ_ONLY |
| `post_response` | `relay` | READ_ONLY |
| `report_progress` | `relay` | READ_ONLY |

Resources: `monize://relay-attachment` follows `relay`; the other four follow
`always`. The registration order does not change, so the pinned order in
`tools-list-budget.spec.ts` holds for the full projection and every
projection is a subsequence of it.

## 5. The facts query

One `withScopedDb` read, run under the request's own user context (the
transport already wraps every exchange in `withUserContext`; the 2025-era
`initialize` moves the server construction inside that wrapper, so no new
`WITH_CONTEXT_ALLOWLIST` entry is needed):

```sql
SELECT (SELECT role FROM users WHERE id = $1) = 'admin'                        AS is_administrator,
       EXISTS (SELECT 1 FROM accounts WHERE user_id = $1
                 AND account_sub_type IN ('INVESTMENT_CASH', 'INVESTMENT_BROKERAGE')) AS has_investment_accounts,
       EXISTS (SELECT 1 FROM budgets WHERE user_id = $1)                        AS has_budgets,
       EXISTS (SELECT 1 FROM scheduled_transactions WHERE user_id = $1)         AS has_scheduled_transactions,
       EXISTS (SELECT 1 FROM transaction_rules WHERE user_id = $1
                 AND actions @> '[{"type": "request_ai_review"}]'::jsonb)       AS has_ai_review_rules,
       EXISTS (SELECT 1 FROM email_receipt_mailboxes WHERE user_id = $1)        AS has_email_receipt_mailbox
```

The task verifies every column against `database/schema.sql` before writing
the query (the owner column of a joint account and the mailbox's enabled flag
are the two to check). The result is the `McpListingFacts` record:

```typescript
interface McpListingFacts {
  readonly isAdministrator: boolean;
  readonly hasInvestmentAccounts: boolean;
  readonly hasBudgets: boolean;
  readonly hasScheduledTransactions: boolean;
  readonly hasAiReviewRules: boolean;
  readonly hasEmailReceiptMailbox: boolean;
}

interface McpListingContext {
  readonly era: "modern" | "legacy";
  readonly scopes: string;                 // the credential's comma list, as on AuthInfo
  readonly credentialKind: "pat" | "oauth";
  readonly facts?: McpListingFacts;        // undefined: not resolved, or the query failed
}
```

`FULL_LISTING` is the exported context every existing spec passes to
`createServer`: `write` scope, `pat`, every fact `true`. It is the list the
budget spec measures.

## 6. The instructions, by section

| Section | Follows | Content today |
| --- | --- | --- |
| Preamble and today's date | `always` | first three lines |
| Conventions | `always` | signed amounts, name resolution, null totals, `calculate` |
| Writing | `write` | the `manage_*` shape and the confirmation rule |
| Choosing a tool | `always`, with two lines gated | the `generate_report` / `list_accounts` / `list_transactions` lines stay; "Upcoming bills" follows `scheduled`; "Investments: get_portfolio_summary" follows `investments` |
| Web-chat relay | `relay` | the `get_next_prompt` guidance line |

The lines keep their wording; only their presence changes. A section that
names a hidden tool is a defect the projection spec catches: every tool name
that appears in a projected instructions string must be in that projection's
list.

## 7. Era matrix

| | 2026-07-28 (per request) | 2025-era (per session) |
| --- | --- | --- |
| Where the context is built | the handler factory, from `McpRequestContext` (`era`, `authInfo`, `requestInfo`) | `handlePost` on `initialize`, from the validated credential |
| When facts are resolved | only when `Mcp-Method` is a listing method | at `initialize`, and after each unrefused write (decision 7) |
| How hiding is applied | `disable()` before `connect()`; nothing is emitted | `disable()`/`enable()` on the live server; the SDK emits `list_changed` |
| A call to a hidden tool | reaches the handler (the instance for a call has everything enabled); refused there if unauthorized | answered `InvalidParams` "Tool X disabled" by the SDK |
| A hidden tool that becomes relevant | the next `tools/list` after the TTL | the session's own writes: immediately; anything else: the session's end |
| `server/discover` | capabilities and versions only; no tools; unchanged | n/a |
| Cache hint | `tools/list` and its siblings: 10 minutes, `private` | the SDK attaches hints on the modern wire only; unchanged |

## 8. Measurements, 2026-10-15

Serialized bytes per tool in the real `tools/list` on `main` at
`f199b628f` (the same capture `tools-list-budget.spec.ts` makes), and the
sums each context would carry. Tokens at the budget spec's calibrated 6.7
bytes per token.

| Context | Hidden | Bytes | Tokens | Saving |
| --- | --- | --- | --- | --- |
| Full (`FULL_LISTING`) | nothing | 63,041 | ~9,409 | 0% |
| Write PAT, nothing present, not an administrator | investments (17,181), `get_budget_status` (2,296), `list_upcoming_bills` (2,821), `ai_review_requests` (2,968), `email_receipt_parsers` (2,613), `enter_bond_series_manually` (1,546) | 33,616 | ~5,017 | 47% |
| Read-only PAT, everything present | the nine write tools (30,004) | 33,037 | ~4,931 | 48% |
| Write OAuth grant, everything present, not an administrator | relay (3,603), `enter_bond_series_manually` (1,546) | 57,892 | ~8,641 | 8% |
| Read-only OAuth grant, nothing present | everything but the seven `always` tools | 15,539 | ~2,319 | 75% |

The per-tool figures: `manage_transactions` 5,787, `manage_transaction_rules`
4,827, `manage_investment_transactions` 4,317, `manage_securities` 4,086,
`list_transactions` 3,544, `ai_review_requests` 2,968, `manage_payees`
2,954, `get_portfolio_summary` 2,924, `list_upcoming_bills` 2,821,
`generate_report` 2,623, `email_receipt_parsers` 2,613,
`list_investment_transactions` 2,441, `list_accounts` 2,375,
`get_budget_status` 2,296, `list_payees` 2,128, `list_capital_gains` 1,925,
`calculate` 1,921, `compare_periods` 1,812, `enter_bond_series_manually`
1,546, `lookup_securities` 1,488, `get_next_prompt` 1,378, `report_progress`
1,205, `list_categories` 1,136, `post_response` 1,020, `fetch_bond_series`
906.

The instructions are 2,002 bytes today (cap 2,600): the Writing section is
429 of them, the relay section 153, and the "Upcoming bills / Investments"
line 115. A read-only OAuth grant with nothing present therefore carries
about 1,300 bytes of instructions beside its 15,539 bytes of tools.

## 9. Where each rule is held

| Rule | Held by |
| --- | --- |
| Every registered tool has a visibility rule, and every rule names a tool | `backend/src/mcp/mcp-listing.spec.ts`, against `collectToolConfigs()` |
| Each context lists exactly the table's set, in registration order, on both eras | `backend/src/mcp/tools-list-projection.spec.ts`, driving the real SDK over `createMcpHandler` and `InMemoryTransport` with one row per context of section 8 |
| A projected instructions string names no hidden tool | the same spec |
| The full projection is the budget spec's list | `backend/src/mcp/tools-list-budget.spec.ts`, unchanged |
| A call on the modern path reaches the handler whatever the listing would show | `tools-list-projection.spec.ts`: a read-only credential calls `manage_transactions` and receives the handler's scope error, not the SDK's |
| The facts query runs only for a listing method on the modern path | `backend/src/mcp/mcp-http.controller.spec.ts`: the facts service mock is not called for a `tools/call` |
| A failed facts query hides nothing presence-gated | `backend/src/mcp/mcp-listing.spec.ts` |
| A 2025-era session re-evaluates after its own write and emits `list_changed` | `backend/src/mcp/mcp-eras.spec.ts`, a client capturing the notification |
| The listing never widens authorization | INV-MCP-005 in `docs/system-invariants.md`, enforced by the handler checks that already hold INV-MCP-001 and pinned by the projection spec |

## 10. Order of work

B1 lands the table, the context type, the facts service and the guard with
nothing reading them. B2 threads the context through the factory on both
eras, applies the free rules (`always`, `write`, `relay`) and the
instructions sections, and changes the TTL; this is the first listing a
caller sees differently. B3 adds the facts: the query, the listing-method
gate on the modern path, and the re-evaluation on the 2025-era path. Q
re-measures section 8 from the merged code and closes the tracker. The task
file carries the files and the acceptance of each.

## 11. What a reader sees when something is hidden

- A model holding a read-only connector that is asked to add a transaction
  has no `manage_transactions` and says so; today it calls the tool and
  relays "Insufficient scope". Both end in the same place; the new one does it
  without a round trip.
- A user who creates their first budget from the web UI and asks a
  2026-07-28 client about it inside the ten-minute window is told the client
  has no budget tool. The instructions' Conventions section does not change,
  so nothing tells the model to re-list; this is the staleness decision 10
  bounds.
- A 2025-era session that creates a `request_ai_review` rule through
  `manage_transaction_rules` sees `ai_review_requests` appear on its next
  listing, because the session re-evaluated after the write.

## 12. Frontend

None. No setting, no page, no copy. The API-access page's token form is
unchanged; the open question about a token purpose (section 15, question 1)
would be the first frontend touch if it is ever taken.

## 13. Scope cuts

- **A token purpose column** (`general` / `relay`) as the relay signal. A
  migration, an entity field, a DTO field, a form control and a backup rule,
  for a distinction the credential kind already makes in every deployment
  seen so far. Revisit if an OAuth client turns out to run the relay loop.
- **Progressive disclosure through a meta-tool** (`discover_tools` revealing a
  domain on demand). It needs `list_changed` to reach the client, which the
  2026-07-28 revision has no channel for after the response; it would be a
  legacy-only feature with a different shape per era.
- **Projecting prompts** (decision 11).
- **Gating the AI Assistant's tools by the same facts.** Its tool definitions
  are a separate list sent to a different model surface, inside one request
  whose cost is not per-listing; and `ai-query.service.ts` already has its own
  per-run exclusion. A later plan can derive both from one table if the
  savings there are ever measured.
- **Watching data changes to refresh a 2025-era session's list** (decision
  7).
- **Deployment-level feature flags** (an environment variable to switch the
  projection off). The projection never hides a tool the caller could use, so
  there is no configuration a deployment needs; `FULL_LISTING` exists for
  tests.

## 14. Assumptions, restated for a fresh session

- `@modelcontextprotocol/server` is 2.3.1 (`backend/package-lock.json`). The
  factory context, the `enabled` switch, the connection-guarded
  `sendToolListChanged` and the mandatory `Mcp-Method` header were read in
  that version's sources on 2026-10-15; a bump re-checks the four.
- Claude Desktop's connector, `claude mcp add` and Codex negotiate the
  2025-era revision today (`helm/README.md`), so the per-session path is the
  one most callers take and the `list_changed` mechanism is live for them.
- The `tools/list` capture is 63,041 bytes for 25 tools at `f199b628f`
  (section 8). The caps in `tools-list-budget.spec.ts` are not moved by this
  plan.
- `credentialId` is `pat:<id>` or `oauth:<grant>` and nothing else
  (`backend/src/mcp/mcp-context.ts`); an OAuth grant with no id is refused
  before any server is built.
- The scope vocabulary is `read` and `write` (`backend/src/auth/scopes.ts`).
- Every handler already refuses on scope and, for `enter_bond_series_manually`,
  on role; the plan adds no handler checks and removes none.

## 15. Open questions

1. **Relay tools by credential kind** (decision 8): list the three relay tools
   and the attachment resource to PAT credentials only, hiding them from OAuth
   grants? Recommended default: yes. Alternative: keep them `always` (today),
   or the token purpose column of section 13.
2. **Write-annotated tools with folded reads** (decision 4): hide
   `manage_transaction_rules`, `manage_securities`, `ai_review_requests` and
   `email_receipt_parsers` from a read-only token even though each has a read
   operation? Recommended default: yes, by annotation. Alternative: a
   `read-or-write` rule for those four, costing a read-only token about
   14,500 bytes for operations it can only partly use.
3. **The listing TTL** (decision 10): ten minutes? Alternatives: five, or
   keep one hour and accept an hour's staleness after the first budget,
   account or mailbox.
4. **`list_upcoming_bills` on presence** (section 4): gate it on scheduled
   transactions existing, saving 2,821 bytes for a user with none, at the
   cost of the model not knowing the tool exists until the TTL after the
   first scheduled item? Recommended default: yes, same as budgets.
5. **The bond tools on investment accounts**: `fetch_bond_series` is listed to
   every write credential while an adapter is installed. Should it also need
   `hasInvestmentAccounts`, since a series is only useful once a bond can be
   held? Recommended default: no; the series catalog is reference data an
   administrator may fill before any account exists.

## 16. Risks

- **A client that caches the list across credentials.** The cache hint is
  `private` and the list is per credential, so a client honouring the hint
  cannot cross them; a client ignoring it would already be serving a stale
  list today.
- **The SDK's `enabled` semantics change.** The projection spec drives the
  real SDK; a release that lists disabled tools or refuses to enable one
  turns it red rather than silently widening a list.
- **The facts query under load.** Six `EXISTS` reads on indexed owner
  columns, once per listing on the modern path and once per session plus
  once per write on the 2025-era path. If it shows in traces, the row cache
  per credential is the next step, as a reviewed decision; it is not in this
  plan.
- **A hidden tool a user needed.** Every hide rule is a row that exists or
  does not; a wrong rule is corrected in `TOOL_VISIBILITY` and the projection
  spec's fixture, with no data change.
