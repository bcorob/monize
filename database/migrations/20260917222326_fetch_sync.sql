-- Deployment-wide leases for the three outbound market-data fetch jobs.
--
-- The exchange-rate, security-price and market-index refreshes each fire on
-- every replica. Their writes are idempotent upserts, so the data converges --
-- what does not is the cost: N replicas is N times the provider calls, N times
-- the rate-limit budget, and N chances to trip the circuit breaker on a
-- provider that is only slow.
--
-- A lease, not a permanent claim: this is a cost control, so a holder that
-- crashes must never block the next tick. `lease_until` is shorter than the
-- cron interval, so an abandoned lease expires before the job is next due.
--
-- Not JobClaimService: `job_claims.user_id` is a NOT NULL foreign key to
-- `users`, and these fetches belong to no user -- one FX rate serves everybody.
--
-- Not market_index_sync either. That table keeps its own job: a per-index
-- attempt cooldown, which is about how often ONE index is worth re-asking for.
-- This is about which replica asks at all.
--
-- lease_token identifies the holder, the way job_claims.lease_token does: a
-- worker delayed past its own expiry must not release or mark a lease another
-- replica has since retaken.
--
-- Deployment-wide state with no owner column, so RLS-exempt for the same reason
-- market_index_sync is; see the marker block at the foot of database/schema.sql
-- and docs/row-level-security-contract.md.
--
-- rls-exempt: fetch_sync

CREATE TABLE IF NOT EXISTS fetch_sync (
    job TEXT PRIMARY KEY,
    lease_until TIMESTAMPTZ,
    lease_token UUID,
    last_success_at TIMESTAMPTZ,
    last_error TEXT
);
