# Context-aware MCP tool listing: Agent Task List

> Companion to [`mcp-context-aware-listing.md`](./mcp-context-aware-listing.md) (the plan, which carries the decisions, the visibility table, the facts query, the era matrix and the measurements). This file breaks the work into tasks sized for one AI-agent session each. Do the tasks in dependency order; never start a task whose dependencies are unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note on the task's issue instead.
- **The plan is the authority on every contract.** The rules and the per-tool table are plan section 4; the facts query and the two types are section 5; the instructions sections are section 6; the era matrix is section 7. If the code and the plan disagree, the plan is changed first, in its own commit, with the reason.
- **Two rules apply to every task:** no handler check moves (plan decision 1: the listing is a projection, the handler is the authority); and the full projection (`FULL_LISTING`) lists exactly what `main` lists today, which `tools-list-budget.spec.ts` pins without a cap moving.
- **Read first:** `docs/backend/mcp.md` in full and `backend/src/mcp/CLAUDE.md`. The SDK facts the plan relies on (section 14) were read in `@modelcontextprotocol/server` 2.3.1; re-read them if `backend/package-lock.json` names another version.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `npm run test:changed`.
  - `docs/`: `node scripts/check-docs-manifests.mjs` and, in `backend/`, `npm run test:unit -- doc-paths instruction-files`.
  - Stage new files before running a guard (`git add -N` is enough).
  - The doc line each task names lands in the same PR.
- **Terminology:** "the plan" = `mcp-context-aware-listing.md`; "the table" = `TOOL_VISIBILITY`; "the context" = `McpListingContext`; "the facts" = `McpListingFacts`; "the projection" = disabling, on one server instance, every tool whose rule the context fails; "a listing method" = `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`. Section references point at the plan. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
| --- | --- |
| **none** | Tests, docs, or code nothing calls yet. |
| **change** | A caller's `tools/list` can differ from today. Safe under a rolling deployment: a 2026-07-28 listing is built per request, a 2025-era session is pinned to the replica that answered `initialize`, and no call is refused that was answered before (plan decision 1). |

No migration. No environment variable. No Helm value.

## Task graph

| ID | Issue | Task | Depends on | Deploy class | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | -- | This plan pair, committed to `main` | -- | none | [ ] | |
| B1 | -- | The table, the context and facts types, the facts service, the projection seam, the guard; nothing wired | S1 | none | [ ] | |
| B2 | -- | The context threaded through both eras; the free rules (`always`, `write`, `relay`); the instructions sections; the TTL; INV-MCP-005 | B1 | change | [ ] | |
| B3 | -- | The facts: the query on listing methods (modern) and at `initialize` plus after writes (2025-era); the presence rules live | B2 | change | [ ] | |
| Q | -- | Acceptance: section 8 re-measured from `main`, release note, tracker closed, plan status | B3 | none | [ ] | |

**Why B1 is separate from B2:** the table and the seam are tested once against a fake server and the real SDK with every tool visible, so B2's diff is the transport and the rules alone.

**Why B2 lands before B3:** the free rules change a read-only or OAuth caller's list with no query behind them; if the facts query has to be reworked, the scope and relay savings are already shipped.

---

## Task details

### S1 -- Plan

**Files:** `docs/future-plans/mcp-context-aware-listing.md`, `docs/future-plans/mcp-context-aware-listing-tasks.md`.

- The open questions in plan section 15 are answered on the tracking issue; the answer to question 1 decides whether B2's `relay` rule is by credential kind or `always`, and the answer to question 4 whether `list_upcoming_bills` is `scheduled` or `always` in B3.
- Acceptance: the doc guards above are green with both files staged.

### B1 -- The table, the types, the facts service, the seam, the guard

**Files:** `backend/src/mcp/mcp-listing.ts` and `backend/src/mcp/mcp-listing.spec.ts` (new), `backend/src/mcp/mcp-listing-facts.service.ts` and `backend/src/mcp/mcp-listing-facts.service.spec.ts` (new), `backend/src/mcp/mcp.module.ts` (the new provider), `database/schema.sql` (read only, to verify the column names).

- `mcp-listing.ts`: the `McpListingContext` and `McpListingFacts` types and `FULL_LISTING` exactly as plan section 5; the rule names and `TOOL_VISIBILITY` exactly as plan section 4, as an `as const` object keyed by tool name; `isListed(rule, context): boolean` implementing the table with "is not `false`" semantics and `isAdministrator` hiding on absence (decision 6); `RESOURCE_VISIBILITY` for the five resources; `installListingProjection(server, context)`, a wrapper of `server.registerTool` and `server.registerResource` in the shape of `installRelayToolActivity` (`backend/src/mcp/mcp-relay-tool-activity.ts`) that calls through, keeps the returned `RegisteredTool` / `RegisteredResource` by name, and calls `disable()` on each whose rule fails; and `reapplyListing(context)` on the returned handle, which runs `enable()` or `disable()` only where the answer changed (so a 2025-era session emits one `list_changed` per real change). A tool name with no entry in the table throws at registration: the guard below makes that unreachable, and the throw says what to add.
- `mcp-listing.spec.ts`: one `it.each` row per rule crossed with the contexts of plan section 8, asserting `isListed`; `facts: undefined` shows every presence-gated tool and hides `enter_bond_series_manually`; the guard in the shape of `mcp-annotations.spec.ts`: every name from `collectToolConfigs()` has a rule and every rule names a registered tool; the seam against a real `McpServer`: with `FULL_LISTING` every registered tool is `enabled`, with a read-only context the nine write tools are `enabled: false`, and `reapplyListing` toggles exactly the difference.
- `mcp-listing-facts.service.ts`: `McpListingFactsService.read(userId): Promise<McpListingFacts | undefined>`, the one `withScopedDb` query of plan section 5 with every column name verified against `database/schema.sql` (the task records in its PR the three it had to check: the accounts owner column, the mailbox enabled flag, the rule actions containment); `undefined` on any throw, logged once at `warn` through the NestJS `Logger` with the user id and the error's message, never its stack (`describeFetchFailure` is for providers; this is a local query, so a plain message). `INSTALLED_BOND_ADAPTERS` is read where the rule is evaluated, not stored in the facts.
- `mcp-listing-facts.service.spec.ts`: the mapping from the row to the record (every boolean, both ways), `undefined` on a thrown query with the one warn line, and the SQL text pinned so a changed predicate is a visible diff.
- Acceptance: the two specs; `npm run test:unit -- mcp-listing`; `mcp-server.service.spec.ts` and `tools-list-budget.spec.ts` untouched and green.

### B2 -- The context on both eras, the free rules, the instructions, the TTL

**Files:** `backend/src/mcp/mcp-server.service.ts` and `backend/src/mcp/mcp-server.service.spec.ts`, `backend/src/mcp/mcp-http.controller.ts` and `backend/src/mcp/mcp-http.controller.spec.ts`, `backend/src/mcp/mcp-context.ts` (a `credentialKind` helper beside `callerKey`), `backend/src/mcp/tools-list-projection.spec.ts` (new), `backend/src/mcp/mcp-eras.spec.ts`, `backend/src/mcp/tools-list-budget.spec.ts` (the `createServer(FULL_LISTING)` call only), `backend/src/mcp/tool-output-schemas.spec.ts` (the same, if it builds a server), `docs/backend/mcp.md`, `backend/src/mcp/CLAUDE.md`, `docs/system-invariants.md`.

- `createServer(context: McpListingContext)`: `installListingProjection(server, context)` runs after `installRelayToolActivity` and `installConfirmSupport` and before the providers register; the instructions are assembled from the sections of plan section 6, each included when its rule passes (`always` sections unconditionally); `LIST_TTL_MS` becomes ten minutes (question 3) and its comment says why the lifetime is no longer "until this deployment changes".
- `mcp-http.controller.ts`: the modern factory becomes `(ctx) => this.mcpServerService.createServer(listingContextFor(ctx))`, where the helper reads `era`, the scopes and the credential kind from `ctx.authInfo` and leaves `facts` undefined (B3 fills it); on the 2025-era path the context is built from `authResult` at `initialize`, and the `createServer` + `connect` pair moves inside the `withUserContext` wrapper so B3's query has an identity (no new `WITH_CONTEXT_ALLOWLIST` entry; the wrapper is the existing one).
- The rules live for `always`, `write` and `relay` (by credential kind if question 1 is "yes", else `always`); every presence rule reads `facts: undefined` and shows, so B2's listing differs from today only by scope and credential kind.
- `tools-list-projection.spec.ts`: in the shape of `tools-list-budget.spec.ts`, builds the real server per context row of plan section 8 and asserts the listed names equal the table's set in registration order, the serialized bytes equal the row's figure (dated; a changed description moves the number and the row is updated with the measurement, as the budget spec does), the instructions name no hidden tool, and a read-only 2026-07-28 request calling `manage_transactions` through `createMcpHandler` receives the handler's scope error rather than the SDK's "disabled". The 2025-era half asserts the same list over `InMemoryTransport` and the SDK's "disabled" answer for a call.
- `mcp-eras.spec.ts`: the existing "serves the same tool" cases take a context; one new case per era asserts a read-only context lists the same subset on both wires.
- `mcp-http.controller.spec.ts`: the factory passes `era`, scopes and kind; a 2025-era `initialize` builds the server inside the user context (assert the ambient identity, as `rls-context-smoke.spec.ts` does).
- Docs: `docs/backend/mcp.md` gains a section "The listing is a projection of the caller" after "A tool definition is paid for on every request" (the rules table, the era matrix in prose, the TTL, the rule that a new tool adds a row to `TOOL_VISIBILITY`); `backend/src/mcp/CLAUDE.md` gains one line under the three rules ("Every tool has a row in `TOOL_VISIBILITY` (`mcp-listing.ts`); the listing is a projection and the handler keeps its own scope check"); `docs/system-invariants.md` gains INV-MCP-005 in the table and as a full entry in the shape of INV-MCP-004 (statement: a listing never widens what a handler would allow, and a hidden tool that is called is refused by the same check as a listed one; status `enforced`), and `invariant-catalog-parity` stays green.
- Acceptance: the four specs; `npm run test:unit -- mcp`; the budget spec's caps unchanged and green with `FULL_LISTING`.

### B3 -- The facts

**Files:** `backend/src/mcp/mcp-http.controller.ts` and `backend/src/mcp/mcp-http.controller.spec.ts`, `backend/src/mcp/mcp-server.service.ts`, `backend/src/mcp/mcp-listing.ts` (the re-evaluation hook), `backend/src/mcp/tools-list-projection.spec.ts`, `backend/src/mcp/mcp-eras.spec.ts`, `docs/backend/mcp.md`.

- Modern path: the factory reads `requestInfo.headers.get("mcp-method")`; when it names a listing method it awaits `McpListingFactsService.read(userId)` and passes the facts; otherwise `facts` stays undefined and no query runs. The factory is already `async`-capable (`McpServerFactory` may return a promise).
- 2025-era path: `initialize` reads the facts once and passes them; the projection handle is kept beside the session's `McpServer` in the controller's maps (process-local, like the maps themselves; `docs/backend/mcp.md`, "A 2025-era session lives in one process"); after each `tools/call` of a write-annotated tool whose result is not `isError`, the controller re-reads the facts under the same user context and calls `reapplyListing`. The write tools are the `readOnlyHint: false` set, read from the captured configs, never a second list.
- The presence rules go live: `investments`, `investments+write`, `budgets`, `scheduled` (or `always` per question 4), `ai-review`, `email-receipts`, `bonds`, `bonds+admin`.
- `tools-list-projection.spec.ts`: the presence rows of plan section 8 now assert against a facts service double returning each row's record; one row with the double throwing asserts the decision-6 fallback and the single warn line.
- `mcp-http.controller.spec.ts`: a modern `tools/call` never calls the facts service; a modern `tools/list` calls it once; a 2025-era session calls it at `initialize` and again after an unrefused write, not after a refused one, not after a read.
- `mcp-eras.spec.ts`: a 2025-era client with a `request_ai_review` rule created mid-session receives `notifications/tools/list_changed` and its next `listTools()` carries `ai_review_requests`; a 2026-07-28 client sees it on its next listing with no notification.
- Docs: the `docs/backend/mcp.md` section from B2 gains the facts paragraph (what is read, when, and the fallback).
- Acceptance: the three specs; `npm run test:unit -- mcp`; `npm run build && npm run test:integration` (an RLS context moved: the server construction now runs inside the user context).

### Q -- Acceptance

**Files:** `docs/future-plans/mcp-context-aware-listing.md` (section 8 and the status line), `docs/future-plans/mcp-context-aware-listing-tasks.md` (the task table), `docs/release-notes/` (one paragraph in the next release's note, in the shape of the 1.16.0 MCP paragraph).

- Re-run the projection spec's capture on `main` after B3 and replace the figures in plan section 8 with the measured ones, dated.
- Connect a read-only PAT and a write PAT from a real client and record in the PR what each lists (tool count) -- the only check no spec makes.
- Plan status to **done** with the tracker and the PRs named; every task row checked.
- Acceptance: the doc guards; the plan and this file agree with the merged code by symbol.
