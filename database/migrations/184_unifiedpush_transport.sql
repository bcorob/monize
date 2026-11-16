-- The UnifiedPush transport (discussion #1291; docs/specs/notification-preferences.md
-- section 15). A UnifiedPush subscription IS a Web Push subscription -- endpoint
-- plus the two RFC 8291 keys, signed under this instance's VAPID key pair -- so
-- WebPushSender is reused unchanged (delivery isolation, INV-PUSH). Two columns
-- make it a distinct channel:
--
-- 1. push_subscriptions.transport tags which wire a subscription is for, so the
--    per-user unifiedpush toggle can gate it independently of web push. DEFAULT
--    'webpush' leaves every existing row on today's behaviour. The CHECK bounds
--    it to the two known transports; a bad value is a bug, not a row to store.
--    push_subscriptions is in EXCLUDED_FROM_EXPORT (a device credential minted
--    under this deployment's VAPID key), so this column needs no backup rule.
--
-- 2. notification_preferences.unifiedpush is the per-category channel toggle,
--    read by the Phase 5 dispatch beside push. DEFAULT FALSE for the push reason:
--    a matrix cell cannot register a distributor, so the channel stays off until
--    a UnifiedPush subscription exists and the category is toggled. Nothing
--    changes for any existing user.
--
-- Both tables keep their existing RLS policies -- adding a column changes no
-- policy. Idempotent: ADD COLUMN IF NOT EXISTS, and DROP CONSTRAINT IF EXISTS
-- before ADD CONSTRAINT so a re-apply is a no-op (database/CLAUDE.md).

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS transport VARCHAR(20) NOT NULL DEFAULT 'webpush';

ALTER TABLE push_subscriptions
    DROP CONSTRAINT IF EXISTS push_subscriptions_transport_check;
ALTER TABLE push_subscriptions
    ADD CONSTRAINT push_subscriptions_transport_check
        CHECK (transport IN ('webpush', 'unifiedpush'));

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS unifiedpush BOOLEAN NOT NULL DEFAULT FALSE;
