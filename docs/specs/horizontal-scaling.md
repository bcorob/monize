# Plan: Horizontal scaling and high availability

Shipped. Every task of the former task list is done: `CLUSTER_MODE` selects
`single` (the default, the single-replica behaviour unchanged) or `multi`
(several backend and frontend replicas serving one database behind an ordinary
load balancer), and ADR 0005 records the decision. This document is kept as the
specification: what stood between the two deployments, why PostgreSQL is the
only shared store in either mode, and the order in which the gap was closed.
The decision record is `docs/adr/0005-cluster-mode-on-postgresql-alone.md`,
which wins where the two disagree.

## Goal

- Any number of backend replicas and any number of frontend replicas, behind a
  load balancer with **no session affinity**, over one PostgreSQL.
- A new `CLUSTER_MODE` setting: `single` (the default, today's behaviour,
  byte-for-byte) or `multi`. In `multi` the process refuses to boot unless the
  things a second replica needs are present: a PostgreSQL connection that can
  hold `LISTEN` (a session, not a transaction-mode pooler), and cluster-safe
  storage for attachments and backups.
- Everything that must be *correct* across replicas (rate-limit budgets, replay
  protection, signing keys, cron claims) lives in PostgreSQL and therefore
  behaves identically in both modes. The two things that are ephemeral and
  latency-bound live there too, in the shapes PostgreSQL has for exactly that:
  the HTTP throttler's counters are one upsert on an `UNLOGGED` table, and the
  wake-up that reaches the replica holding a live connection is `NOTIFY`,
  received on one dedicated `LISTEN` connection per replica.
- Rolling upgrades with zero downtime, and one replica failing without a user
  noticing more than a retried request.

Out of scope: a PostgreSQL high-availability topology (that is the operator's
database, not this application), read replicas, and sharding the database.

## Why this is non-trivial here (current state)

Much of the work is already done. The claims below are what a reviewer should
*not* re-propose.

| Already solved | Source | Mechanism |
|---|---|---|
| Every replica runs every cron, and most crons are safe | `docs/cron-jobs.md`, `backend/src/common/jobs/job-claim.service.ts` | `claimOnce` / `claimLease` + lease token, `markDelivered`; occurrence claim on auto-posting (`scheduled_transaction_postings` unique key); `FOR UPDATE SKIP LOCKED` in `backend/src/notifications/notification-reminder-cron.service.ts`; insert-winner dedupe indexes for alerts |
| Two containers starting together against one database | `backend/src/common/db/advisory-locks.ts` | `db-init` and `db-migrate` take `pg_advisory_lock(DB_LIFECYCLE_LOCK_KEY)` and re-read state after acquiring |
| First-user-becomes-admin race | `backend/src/auth/auth.service.ts` | `withScopedDb(..., "SERIALIZABLE")` |
| Refresh-token rotation, PATs, OAuth artifacts, TOTP secrets | `backend/src/auth/token.service.ts`, `backend/src/oauth/postgres.adapter.ts` | rows, not memory; rotation under a row lock |
| Password lockout counter | `backend/src/auth/auth.service.ts` `recordFailedAttempt` | one `UPDATE users SET failed_login_attempts = failed_login_attempts + 1 ... RETURNING`; the gap-register row in `docs/concurrency-and-idempotency.md` that still calls it a JavaScript read-modify-write is stale |
| OIDC step-up single-use artifacts | `backend/src/auth/oidc/oidc-reauth.service.ts` | `INSERT ... ON CONFLICT (jti) DO NOTHING` -- the comment there already names the multi-replica reason |
| Web Push VAPID key pair | `backend/src/push/push-config.service.ts` | one row, `INSERT ... ON CONFLICT (id) DO NOTHING` as the arbiter, re-read in the same transaction |
| Restore upload ticket | `backend/src/backup/restore-upload-ticket.ts` | HMAC over `{userId, expiry}` keyed from `JWT_SECRET`, chosen so the upload can land on a different pod from the JSON request |
| CSRF and OAuth cookie keys | `backend/src/auth/auth.service.ts`, `backend/src/oauth/oauth-provider.service.ts` | derived from `JWT_SECRET` via `derivePurposeKey`, identical on every replica |
| `.mny` import workers | `backend/src/import/mny/mny-import-job.service.ts` | partial unique index, atomic claim, heartbeat + reaper, `attempt_token` fencing; progress is a row the wizard polls |
| Backup temp files on a shared volume | `backend/src/backup/atomic-file.ts` | `randomUUID` in the intermediate name (FV-004) |
| The frontend | `frontend/src/proxy.ts` | stateless: no route-handler caches, no ISR, no `unstable_cache`; the only module-scope mutable is a one-shot log flag |

What remains, in severity order:

| Severity | Where | Consequence at N replicas |
|---|---|---|
| Security | `backend/src/auth/two-factor.service.ts` -- `twoFactorAttempts`, `user2FAAttempts`, `usedTotpCodes` are `Map`s | 2FA attempt budgets become 3N and 10N. The TOTP replay window is per process, so a captured code can be spent once on each replica |
| Security | `backend/src/auth/step-up/step-up.service.ts` `attempts`; `backend/src/auth/auth-email.service.ts` `forgotPasswordAttempts`, `verificationEmailAttempts` | step-up lockout and the 3-per-hour email throttles multiply by N |
| Security | `ThrottlerModule.forRoot` in `backend/src/app.module.ts` passes no `storage`, so `@nestjs/throttler` keeps counters in process | every `@Throttle` override (login 5 per 15 minutes, password reset 3 per 15 minutes, and the rest) becomes limit x N |
| Correctness | `backend/src/ai/actions/ai-actions.service.ts` `consumed` | "a confirmed action descriptor cannot be submitted twice" is enforced per process; the same descriptor confirms once per replica |
| Correctness | `backend/src/oauth/oauth-provider.service.ts` constructs `oidc-provider` with **no `jwks`** | the library generates a development signing key per process. `/oauth/jwks` differs per replica and per restart; an ID token signed by one replica does not verify against the JWKS document served by another. Today this is masked because access tokens are opaque and `userinfo` is disabled, so only the ID token is affected -- and it already breaks across a restart |
| Blocker | `backend/src/ai/relay/ai-relay.service.ts` (`pending`, `inFlight`, `waiters`, `buffered`, `awaitingLate`, `bufferedActions`) and `backend/src/ai/relay/relay-attachment.store.ts` | the browser SSE stream, the agent's long-poll and the agent's answer POST each hold a live promise in a `Map`; the three requests must reach the same process. Both files say so in their header comments |
| Blocker (2025-era MCP only) | `backend/src/mcp/mcp-http.controller.ts` -- `transports`, `servers`, `sessionUsers`, `sessionCreatedAt` | a 2025-era session id resolves only on the replica that created it. The 2026-07-28 leg is stateless per request (`docs/adr/0004-mcp-two-eras-request-identity-and-mrtr-confirmation.md`) |
| Storage | `backend/src/attachments/storage/local-storage.provider.ts`, `backend/src/backup/auto-backup.service.ts`, `backend/src/backup/backup-paths.ts` | per-pod disk. `helm/values.yaml` mounts one `ReadWriteOnce` claim, which a second pod on another node cannot attach |
| Startup | `backend/docker-entrypoint.sh` runs the demo seed **after** `db-migrate` releases the lifecycle lock | two demo pods can both fail `db-demo-check` and both seed |
| Duplication (cost, not data) | `backend/src/currencies/exchange-rate.service.ts` (`onModuleInit` sweep and the 17:05 cron), `backend/src/securities/security-price.service.ts`, `backend/src/securities/market-index.service.ts`, `backend/src/updates/updates.service.ts` | N provider fetches per tick and per rollout; the writes are natural-key upserts, so data stays right |
| Duplication (a counted error) | `backend/src/budgets/budget-period-cron.service.ts` | no claim; the loser's 23505 on `UNIQUE(budget_id, period_start)` is caught and counted as a failure |
| Deployment (compose only; the chart is done) | `docker-compose.prod.yml` | compose pins `container_name`, so it cannot replicate at all. The chart's half closed at task D1: `helm/templates/deployment-backend.yaml` and `helm/templates/deployment-frontend.yaml` replaced the StatefulSets, with PodDisruptionBudgets, spread constraints, an optional HPA and `cluster.mode` |

One latent trap to close on the way: `backend/src/common/csrf.util.ts` keeps a
per-process random `FALLBACK_KEY` that is reached only when `JWT_SECRET` is
absent, while `backend/src/common/guards/csrf.guard.ts` skips verification in
that state. A deployment without `JWT_SECRET` works on one replica and fails
open on two. `JWT_SECRET` should be fatal at boot in every mode.

Doc drift to correct in the same body of work, so this plan does not inherit
it: section 8 of `docs/concurrency-and-idempotency.md` still lists scheduled
auto-posting, the demo reset and `users.failed_login_attempts` as unprotected,
and `docs/external-side-effects.md` still says bill and mortgage reminders have
no dedupe state and that the automatic backup writes with a bare
`fs.writeFile`. All five are fixed in code.

## Principles

1. **PostgreSQL is the store for anything that must be correct.** Counters,
   replay sets, signing keys and claims are rows, arbitrated by the mechanisms
   in `docs/concurrency-and-idempotency.md` section 2 (atomic arithmetic, unique
   index, conditional `UPDATE ... RETURNING`, `ON CONFLICT DO NOTHING`). They
   then work the same in `single` and `multi`, and there is no second store
   whose loss could widen a brute-force budget or replay a confirmation.
2. **The ephemeral, latency-bound state is PostgreSQL's too, in its cheaper
   shapes.** Two things. The HTTP throttler's counters are one atomic upsert on
   an `UNLOGGED` table: no WAL, no replication, truncated on crash recovery,
   which is precisely the durability a cache offered, and losing them costs at
   most one window of leniency on non-auth routes because auth routes keep a
   logged counter beneath the throttler (WP1). The wake-up channel, whose only
   message is "re-read this row", is `pg_notify()` sent and `LISTEN` held on
   one dedicated connection per replica. What this buys is one dependency, one
   backup, one readiness check and one connection string. What it costs is
   named rather than hidden: one indexed write per request on the throttler
   path in `multi`; one session-level connection per replica that a
   transaction-mode pooler cannot carry (the startup scripts already have the
   same requirement, `backend/src/common/db/advisory-locks.ts`); an 8000-byte
   payload cap a wake-up never approaches; and notifications lost while a
   listener reconnects, which the slow poll every waiter already runs absorbs.
3. **One door per concern, behind a DI token, selected by config, memory by
   default.** Copy `ATTACHMENT_STORAGE_PROVIDER` in
   `backend/src/attachments/attachments.module.ts`: register every
   implementation as a provider, then one `useFactory` picks by mode. The token
   name is the env var name.
4. **An unsafe mode refuses to boot; a sub-optimal one warns.** Refusal copies
   `assertRequiredDbFunctionsOrExit` in `backend/src/main.ts` (log the reason,
   `process.exit(1)`, before `app.listen`). Warning copies
   `reportSecretStatus` in the same file. The parse-and-throw shape for
   the setting itself is `parseRlsMode` in `backend/src/common/db/rls-config.ts`.
5. **Every process-local `Map` or `Set` that survives is allowlisted with a
   reason.** `backend/src/common/db/derived-state-writers.guard.spec.ts` does
   this for files containing `@Cron(`; the scan widens to the whole tree and
   the allowlist may only shrink.
6. **A two-replica claim is tested with two real connections.**
   `docs/verification-contract.md` section 1 names the kinds ("two
   connections", "two instances"); `backend/test/integration/mny-import-job.integration.spec.ts`
   is the pattern. A concurrency mechanism with only unit tests has not been
   tested.

## Configuration

| Variable | Values | Meaning |
|---|---|---|
| `CLUSTER_MODE` | `single` (default), `multi` | `multi` selects the table-backed throttler storage and the `LISTEN`/`NOTIFY` event bus, adds the listener connection to readiness, and turns on the boot refusals below. Parsed like `RLS_MODE`: an unknown value throws and refuses the boot |
| `ATTACHMENT_SHARED_VOLUME` | `true` | operator assertion that `ATTACHMENT_CONTAINER_DIR` is a volume every replica mounts (ReadWriteMany or equivalent). Read only in `multi`, only when `ATTACHMENT_STORAGE_PROVIDER=local` |
| `BACKUP_SHARED_VOLUME` | `true` | the same assertion for `BACKUP_CONTAINER_DIR` |

No connection variable is added. The listener uses the same `DATABASE_*`
settings and the same resolved runtime role as the TypeORM pool
(`resolveRlsDatabaseAuth` in `backend/src/common/db/rls-config.ts`), because
`LISTEN` and `pg_notify()` need no privilege the runtime role lacks. The
constraint that comes with it is not new: `DATABASE_HOST` must reach a session,
not a transaction-mode pooler, which `db-init` and `db-migrate` already require
for the lifecycle lock. No key prefix is needed either: several Monize
deployments on one PostgreSQL server are separate databases, and `NOTIFY` is
scoped to the database. Task F1 shipped a `REDIS_URL` input to the boot matrix
against the earlier draft; task F6 retired it. As shipped, `checkClusterBoot`
reads `CLUSTER_MODE` and `JWT_SECRET` in every mode, plus, in `multi`, the
attachment provider and directory (`ATTACHMENT_STORAGE_PROVIDER`,
`ATTACHMENT_CONTAINER_DIR` or its deprecated `ATTACHMENT_LOCAL_DIR` alias) and
the two assertions `ATTACHMENT_SHARED_VOLUME` and `BACKUP_SHARED_VOLUME`, with
`BACKUP_CONTAINER_DIR` named in the refusal it produces. The listener's own
connection is not in the matrix: it is checked by connecting, in `main.ts`,
because a reachable host is not a fact about the environment.

Boot matrix in `multi`:

| Condition | Outcome |
|---|---|
| the listener connection cannot connect and `LISTEN` within 5 s at boot | refuse, naming the host (never the password) and that a transaction-mode pooler cannot carry `LISTEN` |
| `ATTACHMENT_STORAGE_PROVIDER=local` without `ATTACHMENT_SHARED_VOLUME=true` | refuse, naming the `database` and `s3` providers as the alternatives |
| `BACKUP_SHARED_VOLUME` not `true` | refuse, unconditionally in `multi`: automatic backups are switched on per user, so no environment variable says whether any exist, and the check cannot be conditional on "backups enabled" (until the S3 backup target ships, see WP7) |
| `JWT_SECRET` absent | refuse (in every mode -- this is the CSRF trap above) |
| `ENCRYPTION_KEY` absent | warn, as today; Web Push and the persisted OIDC keys stay unavailable |

Readiness (`backend/src/health/health.controller.ts`) gains the listener
connection's state in `multi` only, so a replica whose wake-ups are dead leaves
the load balancer until its reconnect succeeds, instead of holding SSE streams
that only advance on the slow poll. The throttler needs no probe of its own: its
table is on the pool the existing `SELECT 1` already checks. Liveness stays
dependency-free.

Every new variable lands in `.env.example` in the same PR;
`scripts/check-env-docs.mjs` fails the `Documentation vs Manifests` job
otherwise. Numeric knobs go through `resolvePositiveInt` in
`backend/src/common/env-number.util.ts`.

## Work packages

Each package names its mechanism, the invariant it serves, the test kind it
owes, and its deploy impact for a deployment that stays on `single`.

### WP0 -- Foundations

New `backend/src/common/cluster/cluster-mode.ts` (`parseClusterMode`, the
boot-matrix check as a pure function returning refusals and warnings) and a
global `ClusterModule` (`backend/src/common/cluster/cluster.module.ts`, the
two-provider shape of `backend/src/common/demo-mode.module.ts`) exposing the
mode and, in `multi`, one dedicated `pg.Client` for `LISTEN` and `pg_notify()`
(`PG_LISTENER`), opened the way `backend/src/db-init.ts` opens its lock
connection but on the runtime role, `null` in `single`. `main.ts` calls the
check before `app.listen`. Readiness probe extension. `docs/cron-jobs.md` and
the two stale doc sections corrected. ADR `0005` written when this lands (next
free number in `docs/adr/README.md`). Task F6, which retired the `REDIS_URL`
input F1 shipped, is done.

Deploy impact: `none` for `single`.

### WP1 -- Auth counters and single-use codes to PostgreSQL

Ships first because it fixes single-replica behaviour too (a restart today
resets every lockout).

- New table `auth_attempt_counters (scope TEXT, key TEXT, count INT, window_expires_at TIMESTAMPTZ, PRIMARY KEY (scope, key))`
  with one service, `backend/src/auth/auth-attempt-counter.service.ts`, whose
  only write is `INSERT ... ON CONFLICT (scope, key) DO UPDATE SET count = CASE WHEN window_expires_at < now() THEN 1 ELSE count + 1 END, window_expires_at = ... RETURNING count`.
  Scopes: 2FA per temp token, 2FA per user, step-up per `userId:purpose`,
  forgot-password per email, verification email per email.
- `users.failed_login_attempts` needs no change: `recordFailedAttempt` is
  already one atomic `UPDATE ... RETURNING`. The counter service copies its
  shape (increment and threshold decision in one statement).
- New table `single_use_tokens (purpose TEXT, token_hash TEXT, expires_at TIMESTAMPTZ, PRIMARY KEY (purpose, token_hash))`
  with `claim(purpose, token)` doing `INSERT ... ON CONFLICT DO NOTHING RETURNING` --
  the `claimJti` shape from `backend/src/auth/oidc/oidc-reauth.service.ts`,
  generalised. `usedTotpCodes` becomes purpose `totp` keyed on
  `hash(userId:code)`; WP3 reuses it.
- A daily sweep of expired rows on both tables (a `@Cron` with a row in
  `docs/cron-jobs.md`, idempotent by predicate).
- **Transaction boundary.** A failed login must still persist its counter, so
  the increment runs in its own short `withScopedDb` after the login
  transaction has decided, never inside it -- otherwise the rejection rolls
  back the evidence. The doc comment on the service says which.
- RLS: both tables are keyed by opaque scope and hash, not by `user_id`. They
  join the exempt list in `docs/row-level-security-contract.md` with the
  reason, and `RLS_EXEMPT_TABLES` in the same PR.

Invariant: INV-HA-002, INV-HA-003. Tests: two-connection integration spec
where two concurrent increments both see the threshold, and where two
concurrent claims of one TOTP code yield exactly one winner. Deploy impact:
`neutral` (same limits, durable across restarts).

### WP2 -- HTTP throttler storage

`backend/src/common/throttler/postgres-throttler-storage.ts` implementing
`@nestjs/throttler`'s `ThrottlerStorage` (`increment(key, ttl, limit, blockDuration, name)`)
over a new `UNLOGGED` table
`http_throttle_counters (name TEXT, key TEXT, hits INT, window_expires_at TIMESTAMPTZ, blocked_until TIMESTAMPTZ, PRIMARY KEY (name, key))`.
`increment` is one statement, the `auth_attempt_counters` shape from WP1 with
the block decision added: `INSERT ... ON CONFLICT (name, key) DO UPDATE SET hits = CASE WHEN window_expires_at < now() THEN 1 ELSE hits + 1 END, window_expires_at = CASE WHEN expired THEN now() + $ttl ELSE window_expires_at END, blocked_until = CASE WHEN <the same hits expression> > $limit THEN now() + $block ELSE blocked_until END RETURNING hits, window_expires_at, blocked_until`,
so two replicas cannot double-count and the block is decided where the count
is. `UNLOGGED` is the point: the rows are a cache, WAL for them is waste, and
a crash truncating the table costs one window of leniency, the same as the
cache restart the earlier draft accepted. The guard runs before
`RequestContextInterceptor`, so there is no ambient identity; the storage seeds
`withSystemContext` (a `WITH_CONTEXT_ALLOWLIST` entry, reviewed) and the table
is RLS-exempt with no owner column, like WP1's. `ThrottlerModule.forRootAsync`
selects it in `multi`; `single` keeps the library default and pays no write.
Auth routes are protected twice on purpose: the throttler is the cheap first
gate, WP1's counters are the correctness gate. If the statement fails at
request time the storage fails **open** and logs once per minute (a closed
throttler would turn a database blip into a 500 before the handler decides
anything, and the readiness probe already removes a replica that lost its
database). WP1's daily sweeper deletes expired rows; the primary key bounds
the table to the number of distinct keys in the meantime.

The window is **fixed**, and the library's in-memory storage's is **sliding**:
its `Map` holds one expiry per hit and drops them individually, so a client's
allowance recovers a hit at a time, whereas a row here holds one
`window_expires_at` for the whole count and the allowance returns all at once
when it passes. This is a deliberate difference between `single` and `multi`,
not an oversight. A sliding window in SQL means storing the hits themselves --
one row per request, or an array read back and rewritten on every guarded call
-- which is the opposite of the cheap upsert this table exists to be, and the
caps it enforces (5 logins per 15 minutes, and the rest) are stated as
"N per window" everywhere they are documented. What a caller can observe: a
burst spent early in a window is forgiven in one step rather than gradually,
which is marginally more lenient at the boundary and never more strict. The
class docstring on the storage says the same thing for a reader who arrives
from the code.

Invariant: INV-HA-001 (readiness). Tests: unit spec with a mocked manager for
the statement's shape and the fail-open path; a two-connection integration
spec asserting the limit holds across two `ThrottlerStorage` instances over one
database (the harness builds the table from entity metadata, which cannot say
`UNLOGGED`; the spec asserts counting, not durability, so that changes
nothing), and a source guard
(`backend/src/common/db/unlogged-table-parity.spec.ts`) holding the migration
and `database/schema.sql` to the same persistence, since no other gate compares
them. Deploy impact: `multi-only`.

### WP3 -- AI action anti-replay

`consumed` in `backend/src/ai/actions/ai-actions.service.ts` becomes a
`single_use_tokens` claim with purpose `ai-action`, taken **inside** the
transaction that applies the action, so a rejected claim and an applied write
cannot both happen. Grep the MCP confirmation path for the same descriptor and
route it through the same claim.

Invariant: INV-HA-003. Tests: two-connection spec, one winner. Deploy impact:
`neutral`.

### WP4 -- OIDC provider signing keys

New table `oauth_instance_config (id BOOLEAN PRIMARY KEY DEFAULT TRUE, jwks_enc TEXT, generated_at TIMESTAMPTZ)`
and `backend/src/oauth/oauth-signing-keys.service.ts`: generate an RSA and an
EC key with `jose`, encrypt the JWKS with `ENCRYPTION_KEY`, `INSERT ... ON CONFLICT (id) DO NOTHING`,
re-read in the same transaction (the `push-config.service.ts` pattern,
verbatim). `oauth-provider.service.ts` passes the result as `jwks`. Without
`ENCRYPTION_KEY` the provider keeps today's per-process key and the existing
warning gains a sentence. Rotation is a later concern: a second row with a
`retired_at` and both keys published.

Invariant: INV-HA-004. Tests: unit spec that two service instances over one
database end up with the same key id; the OAuth E2E spec verifies an ID token
against `/oauth/jwks` after a backend restart. Deploy impact: `neutral`, and a
visible improvement for `single` (ID tokens survive restarts).

### WP5 -- Event bus and the AI relay

`backend/src/common/events/event-bus.interface.ts` (`publish(channel, payload)`,
`subscribe(channel, handler)`, `EVENT_BUS` token), with
`backend/src/common/events/memory-event-bus.ts` (default) and
`backend/src/common/events/postgres-event-bus.ts`. The PostgreSQL bus holds
`LISTEN` on one channel per deployment (`monize_wakeups`) over the
`PG_LISTENER` connection from `ClusterModule`, and fans each notification out
to local subscribers by the exact channel named inside its JSON payload
(`{ "channel": "relay:<userId>", "payload": { ... } }`). One `LISTEN` rather
than one per subscriber, because a subscribe happens on every SSE open and
`LISTEN`/`UNLISTEN` churn on the session would be the hot path. `publish` is
`SELECT pg_notify($1, $2)` on that same dedicated connection, not on the pool:
the message carries no tenant, so the RLS door is the wrong door for it (a
statement that touches no table needs no identity GUC, and seeding one would
widen an allowlist for nothing), and a connection outside every transaction
sends when called, which is what the interface's after-commit rule means.
That connection is the second sanctioned direct-connection path in
`docs/row-level-security-contract.md`, written in its own words beside the
OAuth adapter's. Messages are wake-ups only -- `{ userId, promptId }` -- never
the payload; anything over 4 KB is refused (the server's cap is 8000 bytes).
The listener reconnects with backoff and re-issues `LISTEN` on every connect;
notifications sent in the gap are lost, which the slow poll every waiter runs
already covers.

The relay itself moves its queue to rows:

- `ai_relay_prompts (id, user_id, status pending|claimed|answered|expired, prompt, claimed_at, answered_at, answer, created_at)`.
  The browser inserts `pending` and subscribes to `relay:<userId>`. The agent's
  long-poll claims with `UPDATE ... SET status='claimed', claimed_at=now() WHERE id = (SELECT id ... WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`
  (the `notification-reminder-cron.service.ts` shape). `post_response` is a
  conditional `UPDATE ... WHERE status='claimed'`; the loser of a double post is
  refused. Both transitions publish a wake-up; the replica holding the SSE
  stream re-reads the row and streams.
- Late answers and buffered action cards are the same rows with a TTL sweep;
  `buffered`, `awaitingLate` and `bufferedActions` disappear.
- `lastPollAt`, `idleSince`, `idleDisconnectedAt` become columns on a small
  `ai_relay_agents (user_id PRIMARY KEY, last_poll_at, idle_since, idle_disconnected_at)`
  row written through `runOutsideActiveScopedManager` (they are progress, not
  business data).
- Relay attachments (`relay-attachment.store.ts`) go through the existing
  `ATTACHMENT_STORAGE_PROVIDER` under a `relay/` key prefix with a TTL row, so
  bytes uploaded on one replica are readable on another.
- Per-connection heartbeat timers in `backend/src/ai/relay/ai-relay.controller.ts`
  stay where they are; they describe one socket.

In `single`, the memory bus delivers the wake-up in-process and behaviour is
today's, minus the restart-loses-queue defect.

Invariant: INV-HA-005. Tests: two-connection spec (two agents claim one
prompt, one wins); two-instance spec (browser subscribes on instance A, agent
answers on instance B, A streams). Deploy impact: `neutral` (relay persists
across restarts).

### WP6 -- MCP 2025-era sessions

Keep the 2026-07-28 leg as is. For the sessionful leg, persist
`session_id -> user_id, created_at` in a `mcp_sessions` table and re-create the
transport per request from that row, so any replica can serve any session; the
5-minute sweep becomes a `DELETE ... WHERE created_at < now() - interval '1 hour'`.
If the SDK's transport cannot be re-created statelessly for that revision, the
fallback is documented sticky routing on `/mcp` only (a Helm ingress
annotation), with `legacy: "reject"` already limiting the exposure. Decide by
reading the SDK, not by assuming.

Tests: two-instance spec for the persisted variant. Deploy impact: `neutral`.

### WP7 -- Storage under `multi`

The boot matrix refusals for `local` attachments and the backup directory
(WP0). Follow-on task: an S3 backup target for automatic backups, reusing the
client and the deadline rule of `backend/src/attachments/storage/s3-storage.provider.ts`,
so `multi` needs no shared filesystem at all. Retention and promotion move to
object listing; the per-user prefix keeps the `shardedSegments(userId)` layout
from `backend/src/common/shard-path.util.ts` so `docs/adr/0003-filesystem-objects-use-id-sharding.md`
still describes it.

Deploy impact: `multi-only` for the refusals; `none` until the S3 target is
selected.

### WP8 -- Cron duplication and bootstrap fan-out

- The budget period rollover claims per owner and month with `claimOnce`
  (the `DemoIntraday` shape), since it already works owner by owner.
- The exchange-rate startup sweep and 17:05 fetch, the security price fetch
  and the market index fetch belong to no user, and `job_claims.user_id` is
  a foreign key to `users`, so they take a deployment-wide lease on a new
  `fetch_sync` row (`INSERT ... ON CONFLICT (job) DO UPDATE ... WHERE lease_until < now() RETURNING lease_token`,
  the `market_index_sync` and `provider_health` shape). Data is already
  idempotent; the claim removes N provider calls and the counted 23505
  errors. Each cron's row in `docs/cron-jobs.md` gains the mechanism, and
  `backend/src/common/cron-doc.spec.ts` checks the expression verbatim.
- `updates.service.ts` keeps its release check in a one-row table so every
  replica answers the same and GitHub is asked once per 12 hours per
  deployment.
- The demo seed step in `backend/docker-entrypoint.sh` moves inside the
  lifecycle advisory lock: `db-demo-check` and `seed` take
  `DB_LIFECYCLE_LOCK_KEY` like `db-init`, and are added to `PRE_BOOT_SCRIPTS`
  in `backend/src/startup-logging.spec.ts` if they are not already there.

Deploy impact: `neutral`.

### WP9 -- Deployment and CI

- **Helm.** Backend and frontend become `Deployment`s (nothing about them is
  ordinal; a StatefulSet only slows rollouts). Values: `replicas`,
  `podDisruptionBudget.minAvailable`, `topologySpreadConstraints`, an optional
  `autoscaling` block, `clusterMode`, `persistence.*.accessMode: ReadWriteMany`
  guidance in `helm/templates/NOTES.txt` when `clusterMode=multi` and the
  `local` provider is chosen, and a `NOTES.txt` line that `multi` needs the
  database host to be a session-capable endpoint (a transaction-mode pooler
  cannot carry `LISTEN`). `CLUSTER_MODE` in
  `helm/templates/configmap-backend.yaml`. The chart lint job renders both
  modes.
- **Compose.** A new `docker-compose.ha.yml` example with `deploy.replicas`,
  no `container_name` and a reverse proxy in front; the production file is left
  as the single-replica reference. No new service: both replicas point at the
  `postgres` service the file already has.
- **CI.** Nothing to add. The two-connection and two-instance specs run
  against the PostgreSQL service the `backend-integration-tests` job already
  has, and task D3 has taken the `redis` service and `REDIS_URL` it added
  against the earlier draft back out. One E2E shard runs with
  `CLUSTER_MODE=multi` and two backend replicas behind the frontend proxy in
  `docker-compose.e2e.yml`.

Deploy impact: `none` for existing deployments (defaults unchanged).

## Per-replica state that stays

Each of these is listed in the widened guard's allowlist with the reason here.

| State | Source | Why it may stay per replica |
|---|---|---|
| Provider circuit breaker | `backend/src/provider-health/provider-health.service.ts` | describes this replica's own sockets; episode start and notification markers are already shared rows (`docs/backend/securities-and-providers.md`) |
| Yahoo request semaphore and crumb | `backend/src/securities/yahoo-finance.service.ts` | a per-process handshake; N replicas mean N crumbs, which the provider tolerates. WP8's fetch claim removes the cron-driven multiplication |
| `EmptyWindowMemory` and the empty-window caches | `backend/src/common/time-series/history-fill.ts` | "a cache, not a guard"; a cold replica costs one extra fetch behind an idempotent upsert |
| Intraday, news and instrument-id caches | `backend/src/securities/portfolio.service.ts`, `backend/src/securities/security-news.service.ts` | short TTL, miss costs one provider call |
| Activity-write throttle | `backend/src/common/interceptors/request-context.interceptor.ts` | up to N writes per five minutes instead of one; harmless |
| Support-backup raw export cache | `backend/src/backup/support-backup/support-backup.service.ts` | preview and generate landing on different replicas degrade to two exports. Acceptable; documented on the endpoint |
| Budget actuals promise cache | `backend/src/budgets/budgets.service.ts` | already stale within one replica for its TTL; multi-replica does not change the contract |
| Restore admission gate | `backend/src/backup/restore-processing-gate.ts` | memory is per pod, so the gate is correctly per pod. Cluster-wide restore admission is an open question |
| Email failure snapshot | `backend/src/notifications/email.service.ts` | per replica by design and forgotten on restart, so it only decides whether to look: the SMTP-failure sweep asks a live `verifyConnection()` probe from the same replica before raising: a failed probe raises, and a passing one clears a single stale failed send but not repeated ones (a relay can take the login and refuse every message). Either way the alert describes this replica's delivery now, which holds under any replica count. The alert dedupes at the database (`SMTP_FAILURE:<UTC day>`) |
| `INSTANCE_ID` / `application_name` | `backend/src/common/cluster/instance-id.ts` | a random UUID and start time minted once per process and stamped on every pooled PostgreSQL session; correct per replica by definition, since it exists to tell processes apart in `pg_stat_activity` for the replica census (`backend/src/common/cluster/replica-census.service.ts`). Identity for observation only, never for authorization or ownership |

## Invariants to add

Five entries in `docs/system-invariants.md`, in its field template, and the
matching rows in `docs/verification-contract.md` section 3 (the parity guard
`backend/src/common/invariant-catalog-parity.spec.ts` fails when either file
lacks an ID). Proposed wording:

| ID | Statement | Mechanism | Test kind |
|---|---|---|---|
| INV-HA-001 | A process in `CLUSTER_MODE=multi` serves traffic only while every replica-shared dependency it needs is reachable | boot refusal in `main.ts`; the `LISTEN` connection's state in readiness | unit (boot matrix), E2E (readiness flips) |
| INV-HA-002 | An authentication attempt budget is one number per deployment, not per process | `auth_attempt_counters` atomic upsert, the same shape as the existing `users.failed_login_attempts` increment | two connections |
| INV-HA-003 | A single-use artifact (TOTP code, AI action descriptor, re-auth jti) is consumed at most once across all replicas | `single_use_tokens` primary key, `ON CONFLICT DO NOTHING RETURNING` | two connections |
| INV-HA-004 | One deployment publishes one OIDC signing key set, stable across restarts | `oauth_instance_config` insert-as-arbiter | two instances |
| INV-HA-005 | A relay prompt is claimed by exactly one agent poll and answered at most once | `ai_relay_prompts` conditional `UPDATE ... RETURNING` under `FOR UPDATE SKIP LOCKED` | two connections, two instances |

## Guards to add

- `backend/src/common/process-local-state.guard.spec.ts`: the
  `derived-state-writers` scan widened from cron files to every file under
  `backend/src`, matching `private readonly <name> = new Map|Set(` and
  `private <name>: Map|Set`, with the allowlist from the table above. The
  allowlist may shrink and never grow without a written reason.
- `backend/src/common/cluster/cluster-mode.spec.ts`: the boot matrix as a
  table-driven test, one row per line of the matrix above.
- `startup-logging.spec.ts` gains any new pre-boot script.
- `check-env-docs.mjs` already covers the new variables; `.env.example` is
  the deliverable.
- The `Helm Chart Lint & Render` job renders `clusterMode=multi` as well as
  the default.

## Rollout order and deployment safety

| Order | Packages | Class for a `single` deployment |
|---|---|---|
| 1 | WP0 (mode parsing and checks only), WP1, WP3, WP4, WP8 | `neutral`: same behaviour, durable across restarts; auth lockouts stop resetting on restart, ID tokens stop breaking on restart |
| 2 | WP5 (relay rows + memory bus), WP6 | `neutral` |
| 3 | WP2, WP5 (PostgreSQL bus), WP7 refusals, WP9 | `multi-only`: no effect unless `CLUSTER_MODE=multi` |
| 4 | WP7 S3 backup target | `none` until selected |

Every work package landed behind `CLUSTER_MODE=single` unchanged; each one's
definition of done required proving that.

One deployment obligation is not conditional on the mode and is worth stating
here because WP9 is what makes it visible: a rolling deployment runs the
previous release against the new schema for the length of the rollout, so a
migration that renames or drops a column, narrows a type or adds a `NOT NULL`
breaks the pods still serving. Expand now, contract in a later release;
`docs/database-migrations.md` has the rule and the table of what it forbids.
This is a property of surging rollouts rather than of `multi` -- it applies at
one replica too -- but `multi` widens the window, and the chart's default
`maxSurge: 1` / `maxUnavailable: 0` is what creates it.

## Open questions

- **A pooler in front of `DATABASE_HOST`.** `LISTEN` is session state, and a
  transaction-mode pgBouncer does not carry it. The startup scripts already
  require a session-capable endpoint under the same variables, so `multi`
  adds no new requirement, only a second reason for it; the boot refusal
  names it. Whether a separate direct endpoint for the listener alone
  (`DATABASE_LISTEN_HOST` or similar) is worth a variable is decided when an
  operator runs one, not before.
- **Throttler write cost.** In `multi` every request the throttler guards
  costs one upsert on an `UNLOGGED` table. If D4's shard or a real deployment
  shows it on the pool, the fallback is the cheaper design, not a cache: let
  the default 100-per-minute limiter count per replica (its budget is a soft
  guardrail; every auth route carries WP1's deployment-wide counter beneath
  it) and keep the table only for the routes with a `@Throttle` override.
  Measure first.
- **Cluster-wide restore admission.** The per-pod gate protects a pod's memory;
  N pods can each admit a restore. A `claimLease` per user around restore would
  add a cluster ceiling. Not needed for correctness.
- **Frontend body buffer.** Settled: `frontend/src/proxy.ts` buffers only
  bodies within `DEFAULT_PROXY_BODY_LIMIT_BYTES` (10 MiB), and the
  `LARGE_UPLOAD_ROUTES` in `frontend/src/lib/proxy-body-limit.ts` are excluded
  from its matcher and streamed by `frontend/src/lib/large-upload-proxy.ts`, so
  a frontend replica's memory no longer has to cover `MNY_IMPORT_LIMIT_MB`.
- **pgBouncer and the runtime pool.** The pool itself still holds no session
  state: every `LISTEN` and every `pg_notify()` lives on the one dedicated
  connection above, so transaction-mode pooling stays possible for the API
  provided that one connection, like the startup scripts' lock connection,
  reaches PostgreSQL directly, as `advisory-locks.ts` already states.
- **Should `multi` warn about the `database` attachment provider?** It is
  cluster-safe by construction, but large blobs on the primary are a scaling
  concern of a different kind. Warn, do not refuse.
