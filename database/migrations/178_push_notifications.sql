-- Web Push transport for the notification centre (discussion #1291, phase 2).
--
-- Two tables with deliberately different lifetimes:
--
--   * push_instance_config is the deployment's push identity -- one VAPID key
--     pair per Monize instance, generated on first start so a self-hosted
--     administrator registers nothing with Google, Apple or Firebase. The
--     private half is AES-256-GCM ciphertext under ENCRYPTION_KEY, so an
--     instance without that variable stores no key at all rather than a
--     plaintext secret. Deployment-wide state with no owner column, so the
--     table is RLS-exempt for the same reason provider_health is; the rationale
--     is in docs/row-level-security-contract.md and the list itself lives once,
--     in backend/src/common/db/rls-exempt-tables.ts.
--
--   * push_subscriptions is what a browser handed us: an endpoint at the push
--     service plus the two keys that encrypt to it. User-owned, so it carries
--     the uniform direct policy AND its own ENABLE (this migration is numbered
--     after 123_rls_enable.sql, which never runs again on a deployed database).
--
-- Neither table is exported by a backup: see INTENTIONALLY_EXCLUDED_TABLES in
-- backend/src/backup/export-table-queries.ts. A subscription names a browser on
-- one machine talking to one origin under one VAPID key, and restoring a
-- production backup onto a test instance must not hand that instance the right
-- to push to real phones.

CREATE TABLE IF NOT EXISTS push_instance_config (
    -- Singleton. The key admits exactly one value, so a second insert is a
    -- conflict rather than a second push identity for one deployment.
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    vapid_public_key VARCHAR(200) NOT NULL,
    vapid_private_key_enc TEXT NOT NULL,
    vapid_generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Instance kill-switch. Off hides the whole push surface from every
    -- account's settings and makes the sender a no-op; it does not delete
    -- subscriptions, so turning it back on restores the devices as they were.
    web_push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    -- SHA-256 hex of the endpoint. The endpoint itself is unbounded text and a
    -- btree index has a row-size limit, so the hash is what gets indexed.
    endpoint_hash VARCHAR(64) NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    device_name VARCHAR(100),
    user_agent VARCHAR(255),
    -- The instance identity this subscription was minted under. A rotation
    -- makes every older subscription undeliverable -- the push service checks
    -- the VAPID signature against the key the subscription was created with --
    -- so the column is what lets the sender skip a stale row even if the
    -- rotation that should have disabled it was interrupted.
    vapid_public_key VARCHAR(200) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_success_at TIMESTAMP,
    failure_count INTEGER NOT NULL DEFAULT 0,
    disabled_at TIMESTAMP,
    disabled_reason VARCHAR(40)
);

-- Globally unique, not unique per user, and that is the security property.
--
-- A push subscription belongs to a browser profile and an origin, NOT to a
-- Monize session: two people sharing one browser get the same endpoint and the
-- same encryption keys from pushManager.subscribe(). Scoped per user, both rows
-- would survive and a notification addressed to the first account would be
-- decrypted and displayed on the device the second account is now using.
--
-- One row per endpoint, and the second subscriber is REFUSED rather than
-- allowed to take the row over: an endpoint is a string the caller supplied,
-- and no ownership check covers it, so a takeover would be a cross-tenant
-- delete on an unverified identifier -- and a silent one. The client answers
-- the refusal by unsubscribing and subscribing again, which mints a fresh
-- endpoint nobody holds, and logging out releases the endpoint the same way.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint
    ON push_subscriptions(endpoint_hash);

-- Every send starts with "which of this user's devices are still live".
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_live
    ON push_subscriptions(user_id)
    WHERE disabled_at IS NULL;

DROP POLICY IF EXISTS push_subscriptions_isolation ON push_subscriptions;
CREATE POLICY push_subscriptions_isolation ON push_subscriptions
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
