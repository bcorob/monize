-- Per-account balance-threshold alert configuration and its armed latch
-- (discussion #1291; docs/specs/balance-threshold-notifications.md).
--
-- low/high_balance_threshold are the user's opt-in thresholds in the account's
-- own currency (NULL = that kind is off, the default). low/high_alert_armed are
-- the durable latch that makes the crossing rule hold (INV-BALANCE-001): the
-- producer fires only when it finds the balance on the alerting side AND the
-- latch un-armed, flipping it in the same conditional UPDATE (a CAS,
-- INV-BALANCE-002), and clears it only when the balance returns.
--
-- accounts is already user-owned and under RLS, so these columns need no new
-- policy. No new SQL function, no trigger.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS low_balance_threshold NUMERIC(20, 4);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS high_balance_threshold NUMERIC(20, 4);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS low_alert_armed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS high_alert_armed BOOLEAN NOT NULL DEFAULT false;
