# Backend Directory

NestJS API server. All commands run from this directory.

Most of this layer's hardest rules are cross-layer and live in `docs/`, indexed by [`docs/system-invariants.md`](../docs/system-invariants.md) -- which also records, per invariant, whether the code currently upholds it. Before changing a balance, a holding, a transfer, a scheduled occurrence, a cron, a token, or anything that writes outside PostgreSQL, read the relevant one and name its ID in the PR:

- [`docs/concurrency-and-idempotency.md`](../docs/concurrency-and-idempotency.md) -- `withScopedDb` gives atomicity and identity, **not** protection against a concurrent writer of the same row. Which mechanism to use, lock ordering, and what a retry means before commit, after commit, and when the result is unknown.
- [`docs/financial-semantics.md`](../docs/financial-semantics.md) -- signs, transfer legs, FX rate direction and precision, split and commission arithmetic.
- [`docs/external-side-effects.md`](../docs/external-side-effects.md) -- attachments, backups, email, providers: anything a transaction cannot roll back.
- [`docs/cron-jobs.md`](../docs/cron-jobs.md) -- every `@Cron` with what stops a second replica repeating its effect. A new cron fills in that column.
- [`docs/verification-contract.md`](../docs/verification-contract.md) -- a mock proves the call, not the property; which claims need a real two-connection test.

## Commands

```bash
npm run start:dev          # Dev server with HMR
npm run build              # Production build
npm run lint               # ESLint --fix
npm run typecheck          # tsc over src AND test (CI gate; plain `tsc --noEmit` skips test/)
npm run test               # jest with no filter -- see the note below, this is NOT green
npm run test:unit          # Unit tests only (src/**/*.spec.ts)
npm run test:cov           # Coverage report (95% lines, 94% stmts, 95% funcs, 85% branches)
npm run test:e2e           # E2E tests (test/**/*.spec.ts, 30s timeout, sequential)
npm run i18n:pseudo        # Regenerate the xx pseudo-locale from en
npm run i18n:check         # Verify the pseudo-locale is up to date (CI gate)
npm run migration:lint     # Idempotency lint over database/migrations (CI gate)
npm run migration:lint:test # Self-test for the migration lint
```

### `test/*.e2e-spec.ts` is not a gate, and three of the four suites are broken

CI runs `test:unit` and `test:integration` (the latter filtered to
`test/integration/*.spec.ts`). Nothing runs `test:e2e`, and `tsconfig.json`
excludes `test/`, so for over a week four suites did not even compile -- a
namespace `import * as cookieParser` left behind when `main.ts` moved to a
default import. ESLint's glob covers the directory, but that is a type error, not
a lint error. `npm run typecheck` now closes the compile half in CI.

What the compile error was hiding, once removed:

| Suite | State | Why |
|---|---|---|
| `test/payee-detail.e2e-spec.ts` | passes (9 tests) | nothing wrong with it; its coverage was simply absent. This is the spec cited below as what caught the raw-select transformer class of bug |
| `test/payees.e2e-spec.ts` | fails | calls services directly, so there is no request scope; never converted for RLS (`withScopedDb` throws without ambient context) |
| `test/auth.e2e-spec.ts` | fails | `AuthController` gained a `TokenService` dependency its test module does not provide |
| `test/transactions.e2e-spec.ts` | fails | `DelegateTransferMaskInterceptor` gained a `CrossOwnerAccessService` dependency its test module does not provide |

Each is separate rot that accumulated *behind* the compile error: the RLS
conversion, the token-service split and the cross-owner-transfers work each moved
on without these files and nothing complained. Repair them or delete them --
what they must not stay is present, cited, and dead. Do not add `test:e2e` to CI
until the three are fixed; it will be red.

## Module Structure

Each feature module under `src/` follows the standard layout. Use `ls src/` or LSP `workspaceSymbol` to discover modules; the cron schedule lives in `docs/cron-jobs.md`.

```
{feature}/
  {feature}.module.ts
  {feature}.controller.ts
  {feature}.service.ts
  {feature}.controller.spec.ts
  {feature}.service.spec.ts
  entities/{entity}.entity.ts
  dto/create-{entity}.dto.ts
  dto/update-{entity}.dto.ts
```

Controllers are thin and delegate to services. Services always take `userId` as the first parameter and filter by it for multi-tenancy.

## Configuration

- **Path alias:** `@/*` maps to `src/*` (tsconfig + Jest moduleNameMapper)
- **ESLint:** Flat config (`eslint.config.mjs`) with typescript-eslint + prettier
- **Jest:** Coverage thresholds: 95% lines, 94% statements, 95% functions, 85% branches. Excludes `main.ts`, modules, entities, DTOs, seed scripts, and migrations from coverage.
- **TypeScript:** ES2021 target, CommonJS modules, `strictNullChecks: true`, `noImplicitAny: false`

## Global Providers (app.module.ts)

Registered globally via `APP_FILTER`, `APP_GUARD`, `APP_INTERCEPTOR`:

| Provider | Purpose |
|----------|---------|
| `GlobalExceptionFilter` | Catches all exceptions; handles HttpException and TypeORM QueryFailedError |
| `ThrottlerGuard` | Rate limiting (100 requests/minute) |
| `CsrfGuard` | CSRF double-submit cookie validation |
| `MustChangePasswordGuard` | Blocks access until password change (admin-reset users) |
| `DemoModeGuard` | Restricts write operations in demo mode |
| `CsrfRefreshInterceptor` | Refreshes CSRF token cookie on responses |
| `ClassSerializerInterceptor` | Applies `@Exclude()` / `@Expose()` from class-transformer |

Also configured: `ConfigModule` (global), `TypeOrmModule` (async, PostgreSQL), `ThrottlerModule`, `ScheduleModule`.

## main.ts Setup

- **API prefix:** `api/v1`
- **Body limit:** 10mb (for large QIF file imports)
- **Swagger:** Enabled at `/api/docs` in non-production only
- **DATE column parser:** `pg.types.setTypeParser(1082, val => val)` -- returns DATE columns as strings to prevent timezone-related date shifting
- **Validation pipe:** Global with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`
- **Security:** Helmet (CSP, HSTS, frame-deny), CORS (credentials, configurable origins)
- **Cookie parser:** Required for OIDC state/nonce and auth tokens
- **Trust proxy:** Level 1 (Docker/nginx real client IP)

## Entity Conventions

**DATE columns** must use a string transformer to avoid timezone issues -- without this, PostgreSQL returns a `Date` parsed in UTC and reading `.toISOString()` can shift the day:

```typescript
@Column({
  type: 'date',
  name: 'transaction_date',
  transformer: {
    from: (value: string | Date): string => {
      if (!value) return value as string;
      if (typeof value === 'string') return value;
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    },
    to: (value: string | Date): string | Date => value,
  },
})
transactionDate: string;
```

**Decimal columns** use a `numericTransformer` to convert PostgreSQL's string representation to `number`. **Timestamps** are `@CreateDateColumn({ name: 'created_at' })` and `@UpdateDateColumn({ name: 'updated_at' })`.

**Raw selects bypass both transformers.** `getRawOne`/`getRawMany` return driver values, not entity-hydrated ones, so a DATE column comes back as a JS `Date` and a numeric as a string -- regardless of the transformer on the entity. Select a DATE as text in SQL (`TO_CHAR(col, 'YYYY-MM-DD')`) and pass a numeric through `Number()` before it reaches a DTO that declares `string`/`number`. `main.ts` installs a global DATE string parser, which hides the DATE half of this in the running server but not in tests, jobs, or any other process -- so do not rely on it. `payee-detail.service.ts` is the worked example; its `test/payee-detail.e2e-spec.ts` is what caught it, because a unit spec with mocked query builders cannot.

## DTO Conventions

### An optional field with a format validator needs `@ValidateIf`, not just `@IsOptional`

`@IsOptional()` waives validation for `undefined` and `null` only. A text input the user left alone arrives as `""` -- react-hook-form gives the empty string and the form sends it -- so an `@IsUrl` / `@IsEmail` sitting beside `@IsOptional()` still runs on it and rejects it. Because validation fails per *request*, one blank optional field breaks every save from that form, not just the field. Add `@ValidateIf((_o, value) => value !== null && value !== "")` for a column that is nullable, so a blank clears it. `src/common/optional-url-dto.spec.ts` sweeps every URL-validated DTO property and fails on a new one; a field whose column is NOT NULL belongs on that file's exemption list with the reason, not silently rejecting a blank.

This class of bug is invisible to unit tests, which construct payloads by hand and never send what the form sends. It surfaces in E2E or in production.

### A request-supplied array declares an upper bound

Every `@IsArray()` DTO property carries `@ArrayMaxSize(n)` beside it -- an unbounded array turns any per-element work downstream (one UPDATE per id inside a transaction) into a denial-of-service lever, and CodeQL flags the loop as `js/loop-bound-injection` (CWE-834). `src/common/array-bound-dto.spec.ts` sweeps validator metadata and fails on a new unbounded property; properties older than the guard are grandfathered there, and that list may only shrink. Relatedly, never use a request value's `.length` as a loop bound inside a `withScopedDb` callback: CodeQL cannot track an outer `Array.isArray` guard through the closure, so iterate `for (const [i, v] of xs.entries())` instead of `for (let i = 0; i < xs.length; i++)`.

## `complete()` is not `completeWithTools()` with the tools left off

The two take the same `AiCompletionRequest`, which makes them look
interchangeable, and they are not: `complete()` maps messages through
`toSimpleMessages`, which **filters `role: "tool"` out entirely**. Reach for it
to summarise a tool-use conversation and you send a transcript stripped of
every tool result and get back a confident summary of nothing -- no error, no
empty response, just an answer about no data.

A tool-free turn over a tool-use transcript therefore goes through
`completeWithTools`/`streamWithTools` with an empty tool list, and every
provider builds the field with `toolsField` (`src/ai/providers/tools-field.util.ts`)
so it is **omitted** rather than sent as `[]` -- OpenAI rejects `tools: []`
outright. `tools-field.util.spec.ts` scans every `*.provider.ts` and fails on a
bare `tools:` key, so a sixth provider cannot reintroduce it; the per-provider
specs assert the request body in both directions.

The one caller is `AiQueryService.streamFinalSynthesis`, the pass that turns an
unfinished investigation -- budget-truncated, or stalled per the rule below --
into an answer instead of an apology.

## A turn that ends on a promise is not an answer

Nothing runs between turns. So a tool-free turn saying "I am gathering the split
details for those 17 transactions. One moment." ends the query: the loop's exit
condition is `stopReason !== "tool_use"`, control goes back to the user, and the
second message they are now waiting for cannot ever arrive. It reads as a hang,
and the smaller the model the more often it happens -- assistant training data is
full of transcripts where a human speaks next.

The loop therefore does not treat every tool-free turn as an answer.
`isDeferredContinuation` (`src/ai/query/continuation.ts`) recognises the promise,
and the loop replies with `CONTINUATION_NUDGE` in the user's place -- "your turn
does not resume; call the tool now or answer now" -- for at most
`MAX_CONTINUATION_NUDGES` passes, after which it breaks to the tool-free
synthesis pass with `cutoff = "stalled"`, because a model with no tools left
cannot answer with another promise. The stalled text stays in the thinking
buffer and never becomes the answer bubble.

Two asymmetries decide the detector's shape, and both are in its spec. A wait
request ("one moment", "hold on") is decisive; a bare work announcement ("I'll
pull the rest") is not, because the same words end a finished answer that offers
more -- so an offer (`let me know`, `if you want`, a trailing `?`) wins over it.
And only the tail of the message is examined: mid-answer narration is followed
by the answer itself. A false positive costs one extra pass; a false negative is
the hang this exists to stop.

One of these signals needs no judgement about prose, and it is the strongest:
`promisesPendingAction` recognises a promise of confirmation cards, and a card
exists **only** if a write tool call in that same turn produced a pending
action. Promised cards plus `proposingToolResults === 0` is a broken promise the
loop can prove. Prefer that shape -- pair a claim in the text against state the
loop already tracks -- over adding another phrase to a regex list.

The prompt asks for the same thing in `QUERY_SYSTEM_PROMPT` ("FINISH THE TURN YOU
ARE IN") and the safety reminder, since the cheapest stall is the one that never
happens -- but a prompt rule is not a guarantee, which is why the loop enforces
it too.

**A stall is often a dead end the model found and could not name.** Both reported
stalls were the same request: recategorize one line inside 17 split
transactions. It could not be done. A split update had to be a single-item call
(batch rows dropped the splits), and `AiQueryService` allows one proposing tool
call per *query* -- so one split transaction per user request, seventeen
requests, and nothing said so. The model narrated progress towards something
unreachable instead.

Batch rows now carry `splits` (`BatchUpdateTransactionRow.splits`, applied in
`executeBatchRow` inside the same `UpdateTransactionDto` as the scalar fields,
per invariant I1), so one call recategorizes up to 25 split transactions and the
individual-card path passes `result.splits` through rather than silently
dropping them. Two rules the tests hold: a row that resends no splits must carry
none (an empty set would rewrite the lines it was asked to leave), and a row's
preview shows its lines instead of a category name, because a card reading
"Groceries" while writing three other lines is a card approved for something
else.

The general point outlives this feature: when you add a limit, put it in the
tool description in the same commit. An assistant that says "I can do six of
these at a time" is working; one that discovers the wall mid-answer stalls.

**A filtered read is not a complete read, and only one of its two readers can
tell.** `applyCategoryFilters` hydrates *only* the split lines matching the
filter, which is right for the register (it wants a partial total and refetches
the whole transaction to edit it) and wrong for anything that will send the
lines back. `getLlmTransactionRows` reuses that query, so a model asking for
"transactions in Business: Cell Phone" received one line of a three-line split
-- and `manage_transactions` replaces a split set with exactly what it is given.
The observed outcome was a one-line replacement set, refused only by the
unrelated "a split needs at least 2 lines" rule, with the model then offering to
convert the transactions to non-split ones. Two lines matching out of three
would have passed that rule and silently destroyed the third.

So the LLM path reloads the full set per split parent (`loadCompleteSplits`) and
its rows are always complete. Before reusing a list query in a tool, ask what
its `where` does to the collections it hydrates: a filter on a joined child
table silently truncates the parent's children, and the caller cannot tell a
truncated set from a short one.

**A refusal the caller cannot act on is a refusal that ends the task.** Every
bulk tool path computes a per-row reason and then used to throw it away,
answering "None of the transaction edits could be prepared. Check each
transactionId and the fields to change." The next attempt at the 17 splits
failed exactly there: all 17 rows were refused because a split's categories
live on its lines and the edit resent none -- the reason said so, in words the
model could have acted on -- and it was told to check the ids, which were
correct. It concluded the task was impossible and stopped.

`describeSkippedRows` (`common/bulk-create.types.ts`) is now the only way those
messages are built: identical reasons collapse to one line with a count,
distinct ones are listed up to three with a tail count. `bulk-skip-reporting.spec.ts`
scans all four tool sources and fails on a "None of ... could be prepared"
message that does not carry its reasons -- and a generic message is worse than
none when it *guesses*, because a confident wrong diagnosis sends the reader
away from the fix. Individual-card paths that counted skips (`skipped++`) now
collect reasons too, for the same reason.

## A numeric env knob is declared as data, next to its documentation

Coerce every numeric environment variable through `resolvePositiveInt`
(`src/common/env-number.util.ts`) rather than a bare `Number(...)`: env values
arrive as strings, and `Number` is willing enough to turn `true` into 1 and
`[5]` into 5. It separates *absent* from *invalid* so the caller can log the
second -- a typo that silently runs on the default is an afternoon lost to
wondering why the setting did nothing.

Where a feature has more than one knob, declare the set as one table of
`{ envVar, default, description }` and resolve from it in a loop --
`src/ai/query/query-budgets.ts` is the pattern -- so a new knob cannot be added
without a name, and a copied spec object that reads a neighbour's variable
fails a test rather than moving two budgets together. A knob nobody can find is
not configurable, so `query-budgets.spec.ts` checks `.env.example` in both
directions: every declared budget is documented with its current default, and
no `AI_QUERY_*` line documents a variable the code does not read.

## An environment variable configures the deployment's own resource, not somebody else's

The AI provider is the worked example, and it has two owners. `AI_DEFAULT_*`
builds the **centrally managed** provider -- the operator's, used for anyone who
has configured none of their own, editable nowhere in the UI. Everything else in
`ai_provider_configs` is a row a *user* created, pointed at their own key or
their own Ollama box, and can see and edit.

A setting about how hard the assistant may work belongs to whichever of those
two owns the provider. So `AI_QUERY_*` sizes the central provider only, and a
user's provider carries the same five budgets as nullable columns on its row,
set per provider in Settings -> AI and defaulting to the built-in numbers --
never to the environment. `resolveQueryBudgetsForConfig` is the single place
that decision is made; `AiService.resolveToolUseProvider` hands the caller the
configuration alongside the provider so it can be made at all, and the transient
system-default config is marked `isSystemDefault` because that is the only thing
distinguishing it from a row.

Before adding an env var for anything a user can also configure, ask which
resource it describes. An operator's ceiling for the model they host says
nothing about the model somebody else is paying for, and a global limit quietly
reshaping a configuration the user is looking at reads as a broken form rather
than as a policy. The reverse mistake is worse: a per-user knob for something
the operator is paying for hands out their budget.

`query-budgets.spec.ts` holds the split from both sides -- the environment must
not reach a user's provider, and a stored value outside the declared range falls
back to the documented default rather than being clamped to a number nobody
chose. The bounds live in the same spec table as the defaults, so the DTO
(`QueryBudgetFieldsDto`), the migration and the frontend form all derive from
one place; the form's copy of the numbers is checked against it by
`frontend/src/lib/ai-query-budgets.contract.test.ts`.

## A label the exporter writes itself must need no escaping

The CSV formula-injection guard in `account-export.service.ts` exists for
user-controlled text -- a payee named `=cmd|...`, a description opening with
`+`. When one of the *exporter's own* strings trips it, the guard is neutralizing
a threat the exporter invented: `-- Split --` was prefixed with an apostrophe on
the parent row of every split in every account export, and no test saw it,
because `toContain("-- Split --")` is satisfied by `'-- Split --`.

Do not fix that by exempting the literal -- Excel evaluates a leading dash, so an
unguarded `-- Split --` reads as `#NAME?`, which is worse. Rename the label so it
opens with a character no spreadsheet evaluates (`CSV_SPLIT_CATEGORY_LABEL` is
now `(Split)`), and assert the *field* rather than the line, so a neutralized
cell cannot satisfy the assertion again. The document-level check is the durable
half: export a fixture whose every user-supplied field is ordinary text, and
assert no cell carries the guard's prefix. Any future literal that needs
escaping fails it, wherever it is added.

A transfer's label is `csvTransferLabel` in the same file, and it names the
direction as well as the counterpart (`Transfer To Savings`): money leaving this
account went *to* the other one, money arriving came *from* it, and a split line
is asked with its own amount rather than the parent's. `Transfer: Savings` named
the counterpart without saying which way the money moved -- the half a reader
cannot recover from the sign of a column they are looking at in a spreadsheet.
Its twin is `transferCsvLabel` in `frontend/src/lib/transfer-label.ts`; the QIF
export keeps Quicken's `L[Account]` form and is deliberately untouched.

The guard also asks what a value *is* rather than what it starts with, matching
its twin in `frontend/src/lib/csv-export.ts`: a value a spreadsheet reads as a
number is data, and prefixing one stops the column adding up (issue #1134).
Amounts here bypass `escapeCsv`, so the rule covers the text columns that can
still hold a number, such as a cheque number written `-123`.

## Rejection happens before the write

A check capable of refusing a command belongs inside the transaction that performs it, and under the same lock when concurrency is in play. A service that mutates, commits, and returns a success-shaped value for a caller to reject afterwards has already done the thing the `409` says it did not do.

Give the operation the caller's precondition as a parameter -- the expected owner, scenario or revision -- and let it refuse before writing. Return the refusal distinguishably: "no such row", "not yours" and "done" are three answers, and folding two into `null` makes the caller guess. Tests assert the rejected response **and** the stored state; see `docs/financial-calculation-contract.md` section 7.

## A category's leaf name is not its identity

"Cell Phone" under **Bills** and "Cell Phone" under **Business** is an ordinary
chart of accounts, not an edge case -- so a bare leaf name identifies nothing,
and every surface that emitted one was guessing on the reader's behalf. The
analytics breakdown grouped on `splitCat.name`, which merged the two categories
into a single row carrying `MIN(id)`; the LLM transaction rows sent the model
`s.category.name`, so a split filed under Business came back as "Cell Phone" and
was reported under whichever parent the model had seen elsewhere.

Both halves now go through `categories/category-name.util.ts`:

- **Emitting**: `qualifiedCategoryName` / `loadQualifiedCategoryNames` produce
  `"Business: Cell Phone"`. Analytics groups on `SPLIT_CATEGORY_ID` and resolves
  the label from the map -- there is deliberately no category-*name* SQL
  fragment left to reach for, and `transaction-split-query.util.spec.ts` fails if
  one reappears.
- **Accepting**: `resolveCategoryNamePaths` matches a name the model sends back,
  separator- and spacing-insensitive, and **refuses an ambiguous one** with the
  qualified candidates rather than picking a winner.

The two are one contract, and the test that matters is the round trip: every
name we emit must resolve back to the category we emitted it for
(`category-name.util.spec.ts`). Four hand-rolled resolvers had drifted apart
before this, and the one the tools used accepted `"Business:Cell Phone"` and
`"Business : Cell Phone"` but **not** `"Business: Cell Phone"` -- the single
spelling every tool description and error message tells the model to type. That
miss fell through to a last-segment fallback that returned the *other* "Cell
Phone", and because results were labelled with the leaf name, nothing in the
answer could reveal that the wrong category had been read.

Also: `Uncategorized` (the user filed it nowhere) and `Unknown category` (we
could not resolve the name of the category they did file it under) are different
facts and have different constants. Do not fold the second into the first.

## A predicate that decides which row counts is written once

When "is this row the one we mean" takes more than one clause -- current
algorithm version *and* matching configuration fingerprint, say -- name it and
call it. Written out at each site it drifts, and the drift is invisible: the
GEM signal service spelled the condition out four times, and the fourth asked
only whether the *date* had an answer. A date can hold two rows once a unique
key carries a version, so a superseded row could win the lookup and be stored
as the next period's predecessor -- a wrong decision, persisted, from rules no
longer in force.

The same goes for the `where` clause that reads such a row back. A key that
grew a column selects more than one row now; a query still written against the
old key returns whichever the database offers first. Grep for reads of a
unique key in the migration that widens it.

## One classifier decides whether a database role is safe

`common/db/runtime-role-check.ts` owns the question "may this role serve
enforced traffic": one facts query template, one violation list, one verdict.
Every surface that asks goes through its exports -- `main.ts` about its own
connection (`assertRuntimeRoleSafe`), `db-init` about the configured role by
name (`assertRuntimeRoleSafeByName`). Do not write a second role-safety query:
a hand-written copy in `app-role.ts` once warned on CREATEDB/CREATEROLE/
REPLICATION where the original refuses them, so the pre-flight blessed a role
the runtime check then rejected (PR #1076). `runtime-role-check.spec.ts` pins
the two exported queries to one template ("only the subject swapped") and the
two asserts to one verdict per input.

## A read about somebody else needs somebody else's identity

`users_self` exposes exactly two rows to a session: `app_current_user_id()` and
`app_real_user_id()`. So **any query keyed on another person -- by their id, or
worse, by their email -- returns zero rows from the caller's own scope**, and
under `RLS_MODE=enforce` that empty result is what the caller gets back. It does
not raise, it does not log, and "no rows" is the same shape as "no such user".
`AuthService` finds a login by email only because it runs pre-identity, under a
bypass; `DelegationService.delegateEmailExists` ran the identical `where` under
`scoped()` and told owners that an account which demonstrably logs in did not
exist. `listDelegates` had the same defect as a `relations: ["delegate"]` join,
`revokeDelegate` decided whether to delete a login from three counts the
database had refused to answer, and the delegate 2FA gate concluded that no
owner requires 2FA.

Before writing a query, ask whose row it is. There are three answers, not two:

| Whose row | Use | Why |
|---|---|---|
| The caller's | `scoped()` / `withScopedDb` | The policy is the point. |
| An owner's, read by their delegate | `withDelegateContext(owner, delegate)` | `current = owner, real = delegate` is the identity `users_self` and `user_preferences_isolation` were written for. **No bypass** -- the delegation is an identity the policies already understand, and `app.real_user_id` stays true about who is authenticated. |
| A delegate's, read by their owner (or any genuine cross-user sweep) | `withSystemContext` | There is no policy arm for it. Decide authorization *first*, under `scoped()`, and let only the minimum out. |

Reaching for `withSystemContext` when the middle row applies is the easy wrong
answer: it works, so nothing complains, and the bypass fence widens by one.

`src/delegation/rls-context-smoke.spec.ts` is the guard, and the shape is worth
copying. Per-service specs mock `withScopedDb` away, which makes them
structurally incapable of seeing this class of bug -- so that suite runs the
**real** `withScopedDb` at `RLS_MODE=enforce`, records the ambient context at
each repository call, and asserts the ordered sequence of identities plus the
`set_config` statements actually emitted. Asserting the order is what proves the
fence: the authorization read must appear under the caller's own identity
*before* any bypass opens.

## A joint account is only shared where somebody remembered to share it

`transaction.userId = :userId` is the wrong ownership predicate for any
own-context read a delegate can reach: a jointly shared account's rows belong
to the **owner**, so the grantee matches none of them and the endpoint returns
a confident empty answer rather than an error. That is how the register got the
joint scope on day one while the summary, grouped totals and monthly totals
beside it did not -- a joint account's detail page drew a full balance chart
with an empty cash flow, no top categories and no top payees under it.

Own-context reads resolve their scope through
`TransactionsController.resolveOwnContextJointScope` (the accounts controller's
equivalents are `jointAccountIdSetFor` for list reads and a `NotFoundException`
fallback through `jointAccessFor` for `:id` reads, as on `getBalance` and
`getBalanceForecast`). Filtered to exactly one joint account, the query runs as
the owner so every derived value -- category descendant expansion, the search
term parsed in the user's number/date format, the money math -- is byte-identical
to the owner's own view; anything else keeps the caller's scope and widens it by
the already-authorized joint ids, never by raw request input. The widened
predicate itself is written once per service (`registerScope`,
`analyticsScope`).

An endpoint that deliberately stays owner-only says so where it is skipped:
`tag-key-breakdown` does, because tags are personal and a joint row never
carries the grantee's.

## A stored price says which session it belongs to, not which minute it was fetched

`security_prices` holds one row per trading day, and the thing that row is
supposed to hold is the **session**: the official close, the full-day volume,
the high and low over the whole day, and the adjusted close. A live quote is
none of those. `regularMarketPrice` is the last print at the moment it was
asked for, which is a true statement about 14:42 and a false one about the day.

The frontend auto-refreshes quotes through the trading session
(`usePriceRefresh`), so a row for today exists long before the day is over --
and the closing job used to treat that as "already done" and skip the security,
leaving whichever mid-session quote arrived last stored as the close. On real
data that was sixteen of seventeen consecutive rows disagreeing with the
provider, by a cent or two, with volumes at a third of the real figure. The two
correct ones were the days nobody opened the app.

Three rules, each with a test rather than a paragraph:

- **"Has a price for today" is not "the day is settled".** Ask whether the
  *session* has ended -- `isSessionSettled` (`providers/settled-bar.util.ts`),
  on the market's own clock in the market's own zone, from the
  `market_timezone` / `market_close_time` the quote refresh stores. Never from
  the presence of a row, and never from the server's clock.
- **The closing job settles the day from the daily bar, after the quote
  refresh.** `settleDailyBars` re-reads a bounded recent window and upserts the
  bars whose sessions have ended, so a missed run, a provider outage or a week
  of intraday-only rows repairs itself. Order matters: the quote is what a
  still-open market can offer, the bar is what the finished session did, and
  the bar has to win.
- **A calculated column needs a writer on the recurring path.**
  `adjusted_close` was populated by the on-demand backfill and by nothing else,
  so it was null on every row the daily job wrote. Because `loadPriceSeries`
  picks one basis per series and then keeps only the adjusted rows, that did
  not degrade to raw prices -- it silently truncated every return series at the
  last backfill date.

The quote path fills `adjusted_close` with the close it is writing, so today is
in the series from the first intraday refresh rather than only after
settlement. That is definitional, not a guess -- the newest session's
adjustment factor is 1 -- but it holds *only* for the newest session, and only
where the series already carries an adjusted close. Both conditions live in the
`CASE ... EXISTS` inside the statement, because the second one is not obvious:
an MSN-priced series has no adjusted closes anywhere, and giving it exactly one
flips `bool_or(...)` and collapses the series to that single row.

A daily bar is also not a quote, so settling clears `quoted_at`; and a
`source = 'manual'` row is a correction the user typed, which no provider write
may overwrite -- the quote path and `bulkUpsertPrices` both carry
`WHERE security_prices.source IS DISTINCT FROM 'manual'`, and the quote path
treats the refusal as a successful no-op that reads back the row that won,
not as a failure. The guard is what makes a nightly settlement pass safe to
add at all; without it every manual correction would be destroyed each night.
Its cost, which is the honest half: a manual row on a provider-priced security
has no adjusted close and no way to derive one, so that day stays out of the
adjusted series rather than being overwritten into it.

A related one, in the same family as the DATE-transformer rule above: **a bar's
timestamp is the instant its session opened, so the day it belongs to is the
exchange's calendar day.** `barDate` reads it in `meta.exchangeTimezoneName`,
falling back to UTC. Reading it with `setHours(0,0,0,0)` made `price_date` a
function of the container's timezone and put an ASX bar on the wrong day.

## A payload coarser than daily is a different series, not a sparse one

Ask a provider for a long range and it may answer with weekly or monthly bars.
Written into a daily table those rows are indistinguishable from daily ones --
and they overwrite the real daily rows that sat on those dates, so the damage
is not limited to what was added. `market_index_prices` refused this from the
day it was written; `security_prices` did not, and one production catalogue
carried **six years of a single adjusted row per month** spliced through a daily
history. Under the one-basis-per-series rule that did not merely add noise: the
monthly rows carried adjusted closes and the daily ones did not, so
`loadPriceSeries` kept the monthly rows and *dropped every daily row around
them*, reducing six years of return series to twelve points a year.

`assertDailySeries` (`providers/daily-spacing.util.ts`) is the one test, and it
runs inside `bulkUpsertPrices` -- not in its callers, of which there are four,
because a guard one caller forgets is not a guard. Every caller already wraps
that write in a try/catch that reports a failed security, so the throw surfaces
as "this one did not update" rather than as a crash. The threshold, the median
(never the mean -- one long exchange closure must not make a daily series look
weekly) and the minimum sample size live there too, and
`daily-spacing.util.spec.ts` fails if a second copy of any of them appears
anywhere under `securities/`.

## History depth is a request, not a property of the holding

`backfillSecurityHoldingPeriod` clips its write to the first transaction date,
which is right for a position valuation and wrong for everything else: a
backtest, the GEM report and the performance comparison all need prices from
before the user bought. A security first transacted in May 2025 therefore held
fifteen months of history out of ten available, with no way to ask for more --
`backfillSecurityRange` can fetch any range but has no HTTP route of its own,
reachable only as a side effect of running one of those reports.

Both backfill endpoints now take `range` (`BackfillPricesQueryDto`), and
supplying it means two things at once, deliberately: fetch that range, **and**
store all of it. Omitting it keeps the clipped default. When you add a caller,
decide which of the two questions it is asking -- "what is this position worth
over the time I held it" or "what did this instrument do" -- rather than
reaching for `max` because more data seems safer; the clip exists so an
untouched catalogue does not accumulate decades of prices nobody reads.

## A money value carries the currency it was calculated into

Not the currency of the account it is filed under. `InvestmentTransaction.exchangeRate`
converts a trade out of the security's currency and into the *settlement*
account's -- the funding account when the row names one, otherwise the
brokerage's linked cash account -- so a replayed cost basis is denominated
there, and a PLN brokerage funded from EUR holds a EUR basis. A consumer that
assumed the holding account's currency set that against a PLN market value and
reported the exchange rate as profit, then taxed it.

So the amount and its currency travel together (`ReplayedLot.currencyCode`),
and a consumer compares that field against what it is reporting in. A mismatch
is **unknown**, not a conversion: today's rate answers today's question, and
the acquisition happened at its own. Two acquisitions that settled in
different currencies cannot be summed at all.

## A fallback answers only the question it was asked

A lookup that fails is a fact about *that* lookup. A stale scenario id that no
longer resolves says nothing about the user's other scenarios, so an empty
report hardcoding `strategies: []` made a second claim -- that there are none
-- without looking, and took away the switcher that was the only route back.
Fall back to the default rather than to nothing, and fill the surrounding
fields from a real read.

And a retry has to change something. `getReport` recursed with the same
strategy id after establishing that the id was gone, so every attempt took the
identical path: a retry whose inputs are unchanged is a comment claiming a
recovery that cannot happen.

## Backup and restore

`docs/backup-restore-contract.md` is the contract: what a backup promises, what
it deliberately does not, and the known gaps. Read it before changing anything
under `src/backup/`.

Three things it will not let you get wrong by accident, because a test enforces
them:

- **A new foreign key between two backed-up tables** has to keep
  `src/backup/restore-plan.spec.ts` green. It parses every FK out of
  `database/schema.sql` and fails when a restored table references a table
  inserted later, or itself, without being stripped on insert and repaired
  afterwards.
- **A new column referencing `currencies(code)`** has to keep
  `src/currencies/currency-references.spec.ts` green -- both SQL functions and
  the TypeScript constant the support backup uses.
- **A new table** has to be exported or listed in
  `INTENTIONALLY_EXCLUDED_TABLES` with a reason, and classified in the support
  backup rules.

**A file's name is its identity, so anything that decides whether it may be
deleted has to be in the name.** An automatic backup that could not include every
attachment is published as `monize-backup-partial-<date>` in its own retention
tier, and the name is chosen *after* the export from what the export found --
`writeFileAtomic` replaces a final name by design, so a partial artifact written
under the ordinary `daily-` name had already destroyed that day's complete copy
by the time `applyBackupOutcome` recorded `partial` in the settings row, and
every later retention pass then counted it as a complete daily. State beside the
file (a status column, a variable, a later check) cannot govern a decision the
write has already made. The durable copy of the same fact goes *inside* the
document (`completeness` in the envelope), because a filename does not survive a
rename and a settings row does not survive the machine.

**Nothing in the export path may hold a whole table, a whole artifact, or a whole
attachment set.** Rows come through the cursor in `src/backup/export-cursor.ts`,
the document is serialised a row at a time under the chunk budget in
`export-json-stream.ts`, and an object store is opened one object at a time and
the bytes dropped once written. A `manager.query` for an export table, a
`JSON.stringify` over an array of rows, or an array of base64 built before
serialising are each the same defect (issue #1070), and each looks reasonable in
isolation -- which is how it survived five audits. The guards are in
`src/backup/export-streaming.spec.ts`: they assert the ordering (batched fetches,
loads interleaved with writes, reads that stop when the client does) rather than
the memory, because peak RSS needs a cgroup harness this repository does not have.

And one thing about `verifyAuthentication` that is easy to undo by accident. An
OIDC restore is authorized by a single-use `OidcReauthService` artifact, and the
round trip that mints one loses the user's file selection -- so the restore
validates everything free (decrypt, decompress, envelope) *before* spending it,
and a wrong backup password costs no identity-provider round trip. That makes it
the one refusal in the path that is deliberately not first; it still precedes
every write. Do not reorder it forward to match section 3's list, and do not
reorder it backward past a `DELETE FROM`. Section 5 of the contract has the
reasoning, and `backup.service.spec.ts` pins both edges.

**A value encrypted with server configuration cannot travel in a document.**
`ai_provider_configs.api_key_enc` is ciphertext under `AI_ENCRYPTION_KEY`, and
that variable is not in the backup and must not be -- shipping the master key
beside the ciphertext would make encrypting the column pointless. Exported
verbatim it restored onto any other instance *populated and unreadable*, which is
the worst shape a failure can have: the column is non-null, so every "is a key
configured?" check said yes, the row drew a masked key, and the only symptom was
that AI calls failed. So the key is decrypted on the way out and re-encrypted on
the way in (`ai-provider-key-transport.ts`), and both directions live in one file
because the field name and the fallbacks are one contract -- an export writing a
field the restore does not read loses the secret silently. The cost is that the
artifact holds the credential in plaintext, which is stated in
`docs/backup-restore-contract.md` §1, logged by the export, and the reason the
support backup drops the table outright. Anything else stored under server-side
configuration and put in a user-facing document has the same problem; solve it
the same way, or exclude it.

### `BackupService` is a facade; put new code in the component that owns it

Issue #1092 split the 2,600-line original into `BackupExportService`,
`BackupRestoreService`, `BackupAttachmentTransferService` and
`BackupRestoreDatabaseService`, with the file format in `backup-format.ts` and
the table list in `export-table-queries.ts`. Section 0 of the contract says which
owns what. `BackupService` itself is one delegation per method and holds no
`DataSource` and no storage provider -- a query there is how the original grew,
and `src/backup/module-shape.spec.ts` fails on the dependency as well as on the
line count. That spec's grandfather list may only shrink.

**A source-scanning guard names a file, so a split disarms it silently.** Four of
them pointed at `backup.service.ts` -- the two attachment readers, the trigger-DDL
ban, the export's bytea encoding and `currency-references.spec.ts`'s "one
predicate" check -- and every one would have gone on passing while scanning code
that had moved out from under it. A scan whose subject is "wherever this appears"
walks the directory (`backupModuleSources()` in `backup.service.spec.ts` is the
pattern); one that must name a file throws when its marker is missing rather than
returning an empty match set. Grep `readFileSync(` under the module you are
splitting before you split it.

## Testing Conventions

Mock repositories use `Record<string, jest.Mock>`; tests use `Test.createTestingModule` with mocks injected via `getRepositoryToken()`. E2E tests live in `test/` with helpers under `test/helpers/` (`auth-helper.ts`, `test-database.ts`, `test-factories.ts`).

### A mock must return what the real collaborator returns

`Record<string, jest.Mock>` is fine for a repository, whose surface the driver defines. For **one of our own services**, type the double -- `jest.Mocked<TheService>`, or a `Partial<jest.Mocked<T>>` cast once -- so `tsc` rejects a return shape the real method cannot produce.

Untyped, a mock quietly becomes fiction, and the branch that reads that fiction is green and unreachable. Two ways it happens:

- **A shape the driver never returns.** A TypeORM insert result mocked as `{ generatedMaps: [] }` made an entire lost-the-race path testable, tested and dead: the real driver signals a conflict elsewhere, so the branch never ran in production and its tests never ran anything else.
- **A signature that moved.** A service method growing from `Promise<boolean>` to `Promise<string | null>` leaves `mockResolvedValue(true)` behind it -- still truthy, still passing, still describing a contract nothing has any more. When you change a method's return type, grep its mocks in the same commit.

### Fixtures are claims about production data

`docs/testing-contract.md` is the shared list of adversarial inputs to choose from. A fixture is evidence only if the code that writes the real data could have written it. Before adding one, look at the producer: the query's sampling, whether the column is nullable, whether the format guarantees what the fixture assumes. A price series three points a quarter apart proves nothing about code reading daily closes, and weightings that always sum to 1 never exercise the remainder the storage format allows. `docs/financial-calculation-contract.md` section 8.3 has the full rule.

### Do not trust a suite that stayed green

Changing what a service computes and seeing every test pass means the change is a no-op or the suite has a hole -- see `docs/financial-calculation-contract.md` sections 8.1 and 8.2. Establish which before moving on, and break each new invariant on purpose once to confirm its test actually fails.

## Internationalization (i18n)

Server-rendered strings (exception messages, email copy) are localized via `nestjs-i18n`. Wrap exception messages in `tr(key, fallback, args)` (`src/i18n/translate.ts`), which resolves against the request locale and returns the English `fallback` outside an HTTP context (jobs, schedulers, tests). Render emails with an `EmailT` translator (`emailTranslator(i18n, recipientLang)` from `src/i18n/email-translator.ts`) so copy matches the recipient's stored locale rather than the request's. Catalogs live in `src/i18n/locales/{locale}/*.json`, one folder per supported locale; the authoritative locale list is `SUPPORTED_LOCALE_CODES` in `src/i18n/config.ts` (root `CLAUDE.md` enumerates them) -- keep it in sync with the frontend's. The `en-*` entries are lean regional variants (declared in `LOCALE_BASES`): they hold only the keys that differ from `en` and fall back to it per key. Adding or changing a string means updating every locale -- the parity test `src/i18n/locales.parity.spec.ts` fails otherwise -- then regenerating the pseudo-locale with `npm run i18n:pseudo`. Full contributor flow: `src/i18n/README.md`.

## Every line in the log has the same shape

`[Nest] pid - date LEVEL [Context] message`, produced by the NestJS `Logger`.
That includes the lines written before the app exists: `Logger` works outside an
application context, so `db-init`, `db-migrate`, `db-demo-check` and the seeders
each construct `new Logger("<Context>")` rather than calling `console`. Backend
`src/` bans `console` outright (`no-console`, `eslint.config.mjs`); the only
exception is `oauth/oidc-provider-log-bridge.ts`, which has to hold the real
console methods in order to forward everything that is not a provider notice.

`docker-entrypoint.sh` prints nothing itself. A shell `echo` is the one line in
the container log with no timestamp, level or context, and an inline `node -e`
blob cannot reach the `Logger` without restating its format -- so each step logs
for itself and the entrypoint just runs the steps.
`src/startup-logging.spec.ts` scans for both mistakes and for a `console` call in
any pre-boot script.

## OAuth / OIDC provider

**A page whose form submission must redirect off-origin needs its own CSP.**
Helmet's app-wide policy merges in the default `form-action 'self'`, and Chrome
enforces `form-action` against every redirect hop that follows a form submit --
so the OAuth consent page's Allow/Deny POST (303 to `/oauth/auth` resume, 303 to
the client's `redirect_uri` with the code) is silently cancelled on the final,
cross-origin hop. The server logs `authorization.success`, the browser stays
parked on the consent form, and the MCP client never receives its code. The
interaction controller therefore sets a per-page policy with
`form-action 'self' https:` (`setInteractionPageHeaders`); the redirect_uri is
per-client and dynamic, so it cannot be enumerated. Do not "fix" this by
loosening the global Helmet `form-action` -- only this page needs it.

`node-oidc-provider` prints its own `oidc-provider NOTICE:`/`WARNING:` lines with bare `console.info`/`console.warn`, outside the Nest `Logger`. The library exposes no logger hook, so `oauth/oidc-provider-log-bridge.ts` -- installed at the top of `main.ts`, before anything can instantiate the provider -- re-routes exactly those lines to a `[OidcProvider]` logger and passes any other console output through untouched. That fixes the formatting only: every such notice still means a config option was left at its default, so fix the config rather than treating the bridge as the answer. In particular, `ttl` needs an explicit number for every artifact the provider can issue (`AccessToken`, `AuthorizationCode`, `IdToken`, `RefreshToken`, `Grant`, `Interaction`, `Session`); the guard test in `src/oauth/oauth-provider.service.spec.ts` fails when one is missing.

## Automatic backups are an operator setting, not a user preference

The auto-backup endpoints live on `AutoBackupController`, whose class-level
`@Roles("admin")` is the whole access rule -- put a new endpoint there and it is
admin-only without anyone remembering to say so. Manual export/restore, which
touches only the caller's own data, stays on `BackupController` for everyone.

Every other user is enrolled on the deployment defaults by
`AutoBackupService.enrollManagedUsers`, which runs at the top of the hourly
cron: nobody but an admin can switch the feature on, so without it a non-admin
would silently have no backups. It reconciles rather than seeds -- a row that
has drifted is written back to the defaults, an unchanged one is not written at
all, and `lastBackup*`/`nextBackupAt` are left alone so enrollment never
re-triggers a backup.

Backups are encrypted with the user's own password. For a local-auth account
the server only ever holds that in plaintext at the moment they type it, so
`rememberLoginPassword` captures it from registration, login and
change-password and nothing asks them to configure anything. An OIDC account
has no password of ours, so those users set a dedicated one in Settings
(`setBackupPasswordForOidcUser`) or go unencrypted; `getStatus().manageable` is
what the UI gates that section on, and both management methods refuse a
local-auth caller rather than accepting a change the next login would undo.

A stored copy is checked against the account's current password hash before it
is used (`resolveBackupPassword`) -- encrypting with a password the user has
since changed produces a file that looks like a backup and cannot be opened.
That resolution has three outcomes, not two: nothing stored (write plaintext), a
usable password (encrypt), and stored-but-undecryptable (refuse, because the
previous backups are encrypted and silently downgrading is worse than failing).

## Cron Jobs

Cron jobs use `@Cron()` from `@nestjs/schedule` and run **in the API process** -- `ScheduleModule.forRoot()` is registered in `app.module.ts`; there is no separate scheduler process (on k8s with more than one backend replica, every replica fires every cron). For the full schedule, see `docs/cron-jobs.md` or grep `@Cron(`.

Every `@Cron` handler is an out-of-request entry point, so its body must seed its own RLS context (tasks C2-C4): the cross-user fan-out under `withSystemContext`, each per-user body under `withUserContext(userId)`. A handler that reaches the DB with no ambient context throws `DB access outside request/user/system context` in every `RLS_MODE`, including `off` -- the per-module `rls-context-smoke.spec.ts` specs are the pattern for proving a cron runs clean.

### Cleanup somebody is blocked on belongs on the request path

Before choosing an interval, ask what the stale row *does* while it sits there.
If it is only untidy, a schedule is the whole answer. If it **refuses the user's
next request** -- a slot, a lock, a uniqueness guard -- then the interval is a
lockout the user cannot end, and picking a smaller number only makes the outage
shorter. Run the cleanup inside the transaction of the request that is about to
be refused by it, scoped to that caller, and leave the cron as a cross-user
backstop for whoever never comes back. `MnyImportJobService` is the worked
example: `reapStaleJobsForUser` runs in `create` and in the poll's `findOne`, so
a dead import clears itself within one 1.5s poll instead of within ten minutes,
and `reapStaleJobs` dropped from every five minutes to hourly.

Two things that path has to get right, both of which have a test rather than a
paragraph. The staleness predicate is **one exported constant** used by the reap
and negated by the advisory pre-check -- an advisory check that still counts what
the reap would clear throws the refusal before the request ever reaches the
transaction that would have cleared it, which reinstates the lockout through the
back door and looks correct at every individual site. And a per-user cleanup
whose predicate is a disjunction needs its own parentheses inside the
`user_id = $n AND (...)`, or the trailing arm escapes the tenant restriction
entirely; assert the composed clause, not an `"AND ("` prefix, since a condition
that opens with its own paren satisfies that prefix while ungrouped.

### Deciding a worker is dead does not stop it -- revoke, do not merely record

A reaper reads a heartbeat and concludes a worker is gone. That conclusion can be
wrong in the one direction that costs money: the heartbeat runs on its own
connection while the work runs on another, so a worker that is merely *blocked*
gets written off, wakes up, and finishes. Marking its row `failed` changed
nothing about what it was about to write -- and because the reap also advertised
a retry, the file lands twice.

So an attempt gets an identity, not just a status. `import_jobs.attempt_token` is
minted by `claim()`, required by every write that worker makes, and set to NULL by
both reaps. The worker's own commit checkpoint (`markDataCommitted`) is a fenced
compare-and-set on that token and is the **last statement of the transaction that
wrote the rows**, so a zero-row result throws and rolls all of them back. Position
is load-bearing: the same check one statement later is a check after the commit,
which is the rule in "Rejection happens before the write".

Three parts, and each is a separate way to get it wrong:

- **A status check is not a fence.** `WHERE status = 'running'` still passes for a
  job that was reaped and re-claimed by a *different* attempt. Compare the token.
- **A fence the other binary does not know about is not a fence.** During a
  rolling deployment the previous release is still running, and its checkpoint
  names no token because its code predates the column. That rule has to live in
  the database -- migration 145's `BEFORE UPDATE` trigger refuses a false -> true
  `data_committed` on a non-`running` job, which is exactly the reaped case, from
  either binary. Deliberately not "and has a token": an old worker's normal state
  is `running` with a NULL token, and refusing that would break every import in
  flight during the rollout.
- **Terminal states are monotonic.** `complete()` and `fail()` are compare-and-set
  on `(status, attempt_token)` and return whether they took, so a woken worker
  cannot overwrite the terminal state the reaper already wrote. The caller must
  read that boolean: logging "completed" after a refusal puts the operator's only
  two lines about the job in contradiction, with the false one the more visible.

The integration suite installs the trigger via `findTriggerMigrations()` in
`test/helpers/rls-setup.ts` -- `synchronize` creates no triggers, so without that
step a mixed-version test reports the fence as working while nothing enforces it.
