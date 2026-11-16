# 0005. Horizontal scaling runs on PostgreSQL alone, behind an explicit `CLUSTER_MODE`

Status: accepted
Date: 2026-09-19 (retrospective: the decision was taken with
`docs/specs/horizontal-scaling.md` and most of it has shipped)

## Context

Monize was written to run as one backend process, and it shows in the places
that count. A survey before any of this work began
(`docs/specs/horizontal-scaling.md`, "Why this is non-trivial here")
found most of the hard parts already right -- every cron has a durable claim,
bootstrap takes an advisory lock, refresh-token rotation and the TOTP secret are
rows, the CSRF and OAuth cookie keys are derived from `JWT_SECRET` so every
replica agrees, and the frontend holds no request state at all.

What was left divided into three kinds, and the middle kind is why this is an
ADR rather than a task list.

**Rows that were maps.** The 2FA attempt counters and the TOTP replay window,
the step-up and auth-email throttles, the AI action anti-replay set, the OIDC
signing keys the library invented per process, and the whole AI relay queue.
Each is a correctness claim -- "three attempts", "spent once", "one signer",
"one claimant" -- that a second process silently multiplies. Nothing about these
was in question: they had to become rows.

**State that is ephemeral and latency-bound.** The HTTP throttler's counters and
the wake-up that tells a waiting replica to re-read a row. Neither is worth a
durable write on its own terms: a lost throttle counter costs one window of
leniency, and a lost wake-up costs one poll interval. This is the shape a cache
is conventionally the answer to, and the plan's first draft said so -- it
reserved an optional Redis for exactly these two concerns, with PostgreSQL
fallbacks behind them.

**Things a second replica cannot share.** Per-pod disk for attachments and
automatic backups, and the 2025-era MCP session bound to a socket on one pod.

The question this ADR settles is the second kind: whether running more than one
replica of Monize should require a second stateful service.

## Decision

**PostgreSQL is the only store for replica-shared state, in both modes.** There
is no Redis, optional or otherwise, and no other coordination service.

Correctness-bearing state is rows arbitrated by the mechanisms already
catalogued in `docs/concurrency-and-idempotency.md` section 2 -- atomic
arithmetic, a unique index, a conditional `UPDATE ... RETURNING`, `ON CONFLICT
DO NOTHING`: `auth_attempt_counters` (INV-HA-002), `single_use_tokens`
(INV-HA-003), `oauth_instance_config` (INV-HA-004), `ai_relay_prompts` and
`ai_relay_agents` (INV-HA-005). These are not gated on the mode. They are
correct in `single` too, and they make a single-replica deployment better:
a lockout is no longer cleared by a redeploy, and an ID token no longer stops
verifying when the pod restarts.

The ephemeral state gets PostgreSQL in its cheaper shapes, and the cost of each
is named rather than hidden:

- **The throttler's counters are an `UNLOGGED` table** (`http_throttle_counters`).
  No WAL, no replication, truncated by crash recovery -- which is precisely the
  durability a cache offered. It costs one indexed write per guarded request in
  `multi`, and nothing at all in `single`, where the in-process storage stays
  bound.
- **The wake-up channel is `pg_notify()` and `LISTEN`**, held on one dedicated
  `pg.Client` per replica (`backend/src/common/cluster/pg-listener.provider.ts`),
  never on the runtime pool. It costs one session-level connection per replica
  that a transaction-mode pooler cannot carry.

**The mode is explicit.** `CLUSTER_MODE` is `single` (the default, and unset) or
`multi`; an unrecognized value refuses the boot rather than guessing, the shape
`parseRlsMode` already established. `multi` is a precondition the boot checks,
not a hint: `checkClusterBoot` reports every refusal at once and `main.ts` exits
before `app.listen`, and the one check that needs a round trip -- that the
database endpoint will actually hold a `LISTEN` -- runs against the live listener
straight after (INV-HA-001).

**A message on the channel is a hint, never a fact.** Its only content is
"re-read this row"; every waiter also polls, so a notification lost while a
listener reconnects costs latency and never an outcome.

## Consequences

**A `single` deployment gains durability and loses nothing.** Every `neutral`
change in the plan improves one replica on its own, which is why they shipped
ahead of the `multi` enablers rather than behind a flag.

**`multi` adds no dependency.** One database to run, back up, secure and probe.
The operational surface a second store would have added -- its own availability,
its own credentials, its own failure mode when the two disagree -- does not exist
to reason about.

**What `multi` does add** is one session-level connection per replica, one
readiness check that reads that connection's state, and a boot that refuses more
configurations than `single`'s does. `DATABASE_HOST` must reach PostgreSQL
directly; the startup scripts' advisory lock already required that, so this is a
second reason for an existing requirement rather than a new one.

**The relay is a table now.** What used to be six maps of live promises in one
process is a queue, a claim, an answer and a liveness row. The only part that
stays in memory is the open SSE socket this process holds
(`backend/src/ai/relay/relay-stream.registry.ts`), which decides delivery and
never the turn's state.

**The throttler path costs a write in `multi`**, and the fallback if that ever
shows on the pool is the cheaper design rather than a cache: let the default
limiter count per replica -- its budget is a soft guardrail, and every
authentication route carries INV-HA-002's logged counter beneath it -- and keep
the table only for the routes with a `@Throttle` override. Measure first; the
open question is recorded in the plan.

**The throttler fails open**, and that is a deliberate exception to INV-HA-001:
a rate limiter whose table or grant is missing must not turn into an outage of
the product. `/health` reports `rateLimiting: disabled` the moment it happens.

**`single` stays an assertion, but no longer a silent one.** Every backend
session carries `application_name = monize-backend:<instance id>@<start>`
(`backend/src/common/cluster/instance-id.ts`), and a `single` process that
finds another long-running backend process on its database
(`backend/src/common/cluster/replica-census.service.ts`) says so in its log
every fifteen minutes and as `checks.replicas` with a `degraded` status on
`GET /health`. The Helm guard remains the only refusal; the census exists for
the compose file or the bare cluster that scaled without setting the mode.

**Per-replica state now needs a written reason.**
`backend/src/common/process-local-state.guard.spec.ts` scans every file under
`backend/src` for a class-scope `Map` or `Set` and fails one that is not
allowlisted with the reason N copies of it are correct. The list may shrink; it
grows only with that reason.

**What this does not make horizontal.** Per-pod attachment and backup
directories are refused at boot in `multi` unless the operator asserts a shared
volume, and the 2025-era MCP session is pinned to its replica -- the addendum to
[0004](0004-mcp-two-eras-request-identity-and-mrtr-confirmation.md) records why a
table would not have helped and what sticky routing does and does not buy.

## Alternatives considered

**An optional Redis for the throttler's counters and the wake-up channel**, as
the plan's first draft proposed. Rejected, and the two pieces that had shipped
against that draft were undone before anything was built on them. It is a second
stateful service to run, back up, secure, probe and upgrade, for two concerns
whose PostgreSQL shapes cost less than the operations of a second store; and
"optional" is worse than either answer alone, because it doubles the
configurations that have to be correct and tested while guaranteeing that the
one operators actually run is the one nobody tried. Its single real advantage --
a hot-path counter with no durable write -- is what `UNLOGGED` answers.

**Sticky routing instead of shared state.** Rejected as a general answer: it
does nothing for the correctness rows, since two requests from one client still
race with the cron and with the same user's other devices, and it fails silently
on a replica loss -- the session simply lands somewhere that has never heard of
it. It survives only where the state genuinely cannot move, which is the
2025-era MCP path and nothing else.

**`LISTEN` on the runtime connection pool.** Rejected: `LISTEN` is session
state, and session state on the runtime pool is exactly what the RLS design
forbids (a pooled connection carries identity GUCs for one transaction and no
longer). A transaction-mode pooler drops it as well. One dedicated connection,
outside the pool, keeps both properties.

**Always-on clustering, with no mode setting.** Rejected: the requirement was
that a single-replica deployment needs nothing new -- no extra connection, no
throttler write, no readiness dependency it cannot satisfy. A setting that
defaults to `single` and refuses an unrecognized value costs one variable and
makes the difference reviewable.

**Leader election for the duplicated work** (the provider fetches every replica
was making on every tick). Rejected as heavier than the problem: those writes
are natural-key upserts, so the data was always right and only the provider
calls multiplied. A deployment-wide `fetch_sync` lease around the fetches is the
same claim mechanism already used for crons, with no new concept and no leader to
lose.
