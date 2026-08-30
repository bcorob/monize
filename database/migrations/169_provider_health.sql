-- Provider availability and what has already been said about it by email.
--
-- Issue #1265: Yahoo Finance became unreachable from the container and every
-- code path that wanted a price kept calling it, thousands of times a minute,
-- logging `TypeError: fetch failed` with an undici stack and nothing else. The
-- in-process circuit breaker (`ProviderCircuit`) stops the calls; this table is
-- the part memory cannot do:
--
--   * it survives the restart the outage itself provoked, so "has this provider
--     been down for 15 minutes" stays answerable across a restart loop -- the
--     upsert preserves `outage_started_at` while the stored state is 'down';
--   * it serializes the alert across replicas, because `outage_notified_at` and
--     `last_notified_at` are claimed with a conditional UPDATE (see
--     docs/concurrency-and-idempotency.md), so one outage produces one email
--     however many replicas noticed it.
--
-- Deployment-wide reference state with no owner column -- one provider outage is
-- every user's -- so the table is RLS-exempt for the same reason
-- `market_index_sync` is. The rationale is in
-- docs/row-level-security-contract.md, and the list itself lives once, in
-- backend/src/common/db/rls-exempt-tables.ts.

CREATE TABLE IF NOT EXISTS provider_health (
    provider VARCHAR(64) PRIMARY KEY,
    state VARCHAR(16) NOT NULL DEFAULT 'up',
    recent_failures INTEGER NOT NULL DEFAULT 0,
    outage_started_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    last_failure_reason TEXT,
    last_success_at TIMESTAMPTZ,
    outage_notified_at TIMESTAMPTZ,
    last_notified_at TIMESTAMPTZ,
    CONSTRAINT provider_health_state_check CHECK (state IN ('up', 'down'))
);

-- The alert sweep asks one question: which providers are down. A partial index
-- keeps that a lookup rather than a scan of a table that also holds the healthy
-- ones.
CREATE INDEX IF NOT EXISTS idx_provider_health_down
    ON provider_health (provider)
    WHERE state = 'down';
