-- The per-security closes a portfolio-movement baseline was valued at
-- (docs/specs/portfolio-movement-notifications.md, INV-PORTMOVE-008;
-- kenlasko/monize#1435).
--
-- One JSON array per user, beside the baseline it belongs to: for each security
-- held at the baseline, its total quantity, the close that valued it, the date
-- that close was struck on, and its currency. A run in which a close that was
-- already old at the baseline has been replaced restates the baseline at the
-- new close instead of booking the catch-up as the period's market move, and
-- instead of withholding the alert until the holding is priced again.
--
-- Nullable, and NULL on every existing row: a baseline without its closes is
-- replaced by the next complete run rather than compared against, so this is a
-- pure expand (no backfill, safe under a rolling deploy -- the previous release
-- neither reads nor writes the column).
ALTER TABLE notification_portfolio_state
    ADD COLUMN IF NOT EXISTS baseline_positions JSONB;
