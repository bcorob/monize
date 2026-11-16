-- Per-user state for the daily portfolio-movement notification (discussion
-- #1291; docs/specs/portfolio-movement-notifications.md).
--
-- One row per user, holding two things: the user's opt-in threshold
-- (move_alert_percent, NULL = off, the default) and the producer's own baseline
-- -- the last COMPLETE market value it saw, in the reporting currency it was
-- measured in. There is no daily portfolio-value snapshot in the schema (only
-- monthly monthly_account_balances.market_value), too coarse for a day-over-day
-- move, so the producer keeps this minimal baseline itself (spec D8). It is a
-- threshold plus a derived baseline, not a "preference", so it does not belong
-- on user_preferences.
--
-- baseline_currency is a snapshot of the resolved reporting currency
-- (preferredCurrency), deliberately NOT a currencies(code) foreign key: it is
-- derived, never user-entered, and deleting a currency must not cascade-delete a
-- user's alert baseline. A reporting-currency change re-baselines rather than
-- comparing across currencies (INV-PORTMOVE-003).
--
-- Exported by backups: it is user data (see export-table-queries.ts and
-- restore-plan.ts). User-owned, so the uniform direct policy AND its own ENABLE
-- (numbered after 123_rls_enable.sql, which derives its targets from pg_policies
-- at the moment it ran and never runs again on a deployed database).

CREATE TABLE IF NOT EXISTS notification_portfolio_state (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Opt-in threshold, in percent. NULL = the alert is off (the default). A
    -- stored value at or below zero disables it too, read at resolve time.
    move_alert_percent NUMERIC(9,4),
    -- The last COMPLETE portfolio value seen, and the currency it is in. Only a
    -- valuationComplete run ever writes these (INV-PORTMOVE-001), so a baseline
    -- is never a subtotal.
    baseline_value NUMERIC(20,4),
    baseline_currency VARCHAR(3),
    baseline_captured_on DATE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- One row per user; the PK's user_id is the only lookup key.
    PRIMARY KEY (user_id)
);

DROP POLICY IF EXISTS notification_portfolio_state_isolation ON notification_portfolio_state;
CREATE POLICY notification_portfolio_state_isolation ON notification_portfolio_state
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE notification_portfolio_state ENABLE ROW LEVEL SECURITY;

-- updated_at maintained by the GUC-aware trigger like every other table that
-- carries the column, so a raw UPDATE (the baseline upsert) advances it and a
-- restore under app.preserve_timestamps keeps the backed-up value.
DROP TRIGGER IF EXISTS update_notification_portfolio_state_updated_at
    ON notification_portfolio_state;
CREATE TRIGGER update_notification_portfolio_state_updated_at
    BEFORE UPDATE ON notification_portfolio_state
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
