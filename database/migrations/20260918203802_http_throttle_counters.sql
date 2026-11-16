-- The HTTP throttler's counters, so a rate limit is one budget per deployment
-- rather than one per process.
--
-- `ThrottlerModule` keeps its counts in a `Map` in the guard's own process,
-- which means N replicas enforce a limit of N x limit: the login cap of 5 per
-- 15 minutes becomes 10 across two pods, and a restart hands the next attempt a
-- clean count. This table is what `CLUSTER_MODE=multi` binds instead
-- (`backend/src/common/throttler/postgres-throttler-storage.ts`); `single`
-- keeps the library's in-process default and never writes here.
--
-- UNLOGGED is the point, not an optimization detail. These rows are a cache:
-- they are written on every guarded request, nothing reads them after their
-- window passes, and losing the lot costs exactly one window of leniency on
-- routes that also carry `auth_attempt_counters` beneath them. Paying WAL,
-- replication and crash recovery for that would be paying for durability
-- nobody wants. What it means operationally is stated rather than hidden: an
-- UNLOGGED table is truncated by crash recovery and is not carried to a
-- streaming standby, so a failover starts with an empty table.
--
-- No user_id, for the same reason `auth_attempt_counters` has none: the guard
-- runs before `RequestContextInterceptor`, so there is no identity yet, and the
-- key is already an opaque SHA-256 of controller, handler, throttler name and
-- tracker (`ThrottlerGuard.generateKey`). RLS-exempt with that reason.
--
-- The window and block arithmetic lives in the one INSERT ... ON CONFLICT the
-- storage issues, not here: hits, the window and the block decision are written
-- together in one statement, so two replicas cannot each read "4 of 5" and both
-- allow the fifth (docs/concurrency-and-idempotency.md, mechanism 1).

CREATE UNLOGGED TABLE IF NOT EXISTS http_throttle_counters (
    -- The throttler this counter belongs to: `default`, or the name of a
    -- @Throttle override. Part of the key because one route can be guarded by
    -- several throttlers with different windows.
    name TEXT NOT NULL,
    -- ThrottlerGuard's generated key: sha256(class-handler-name-tracker).
    -- Already opaque, and deliberately not decomposed here -- a raw IP in a
    -- table readable by every session is exactly what the hash prevents.
    key TEXT NOT NULL,
    hits INTEGER NOT NULL,
    -- When the current counting window ends. A row past this is reset in place
    -- by the next hit, never read as a live count.
    window_expires_at TIMESTAMPTZ NOT NULL,
    -- Set when the window's hits passed the limit; NULL when the key is merely
    -- counting. A blocked key stops accumulating hits until this passes, which
    -- is what @nestjs/throttler's in-memory storage does.
    blocked_until TIMESTAMPTZ,
    PRIMARY KEY (name, key)
);

-- For the daily sweep in AuthStateSweeperService. Nothing else orders by it:
-- every read is a primary-key hit from the upsert.
CREATE INDEX IF NOT EXISTS idx_http_throttle_counters_expiry
    ON http_throttle_counters(window_expires_at);
