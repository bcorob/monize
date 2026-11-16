-- The address a push subscription was registered from, so the device list can
-- identify one endpoint among several (issue: "show more identifying
-- information about each registered endpoint").
--
-- `device_name` is derived from the User-Agent, so two browsers on one machine
-- are listed under identical words; a reader deciding whether to REVOKE a
-- registration has to be able to tell them apart first. The endpoint digest
-- answers "which row", the address answers "from where".
--
-- It is REGISTERED_IP, not "current IP", and the name is the claim: a push is
-- delivered from this server to the push SERVICE, which delivers to the device
-- over a connection this deployment never sees, so the address a device is
-- reachable at today is not knowable here. The column holds the address of the
-- request that created the row, refreshed on each re-registration (the same
-- moment `last_seen_at` moves) and never at delivery time.
--
-- INET rather than TEXT, matching trusted_devices.ip_address -- the one other
-- place this deployment stores a client address. Nullable: every existing row
-- predates the column, and a proxy chain that yields no address is "unknown"
-- rather than a value to invent.
--
-- push_subscriptions is in EXCLUDED_FROM_EXPORT (a device credential minted
-- under this deployment's VAPID key pair), so this column needs no backup rule,
-- and adding a column changes no RLS policy. Idempotent: ADD COLUMN IF NOT
-- EXISTS, so a re-apply on top of schema.sql is a no-op (database/CLAUDE.md).

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS registered_ip INET;
