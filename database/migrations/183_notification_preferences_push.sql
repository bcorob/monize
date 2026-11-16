-- Per-category push channel on notification_preferences (discussion #1291;
-- docs/specs/notification-preferences.md sections 3 and 14).
--
-- Push is the other notification-mode fan-out beside the immediate email, and
-- shares the same throttle gate. It lands now with the Phase 5 dispatch that
-- reads it (unlike email_notification, which was stored ahead in migration 181):
-- resolvePush consults this column, and NotificationDispatchService fans out to
-- the user's live devices when it is on.
--
-- DEFAULT FALSE, because a matrix cell cannot turn a device on -- push requires
-- per-device enablement first (a browser permission granted from a user
-- gesture), so a preference-less user is off until they both enable a device and
-- turn the category on. Nothing changes for any existing user.

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS push BOOLEAN NOT NULL DEFAULT FALSE;
