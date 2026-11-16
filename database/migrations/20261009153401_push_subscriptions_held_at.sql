-- A push device whose account signed out of this browser (issue #1630).
-- Delivery skips it until the same account signs in there again (the subscribe
-- upsert clears it), and the daily sweep deletes a hold nobody resumed.
-- Nullable with no default: every existing row stays deliverable.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS held_at TIMESTAMP;
