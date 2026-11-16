-- Two email modes plus the throttle window on notification_preferences
-- (discussion #1291; docs/specs/notification-preferences.md section 4).
--
-- Email is delivered in two modes and the matrix carries a column for each:
--   * the existing `email` column is the REPORT mode (the batch/digest emails
--     that ship today -- weekly/monthly summaries, the daily bill reminder,
--     budget-alert's batched critical email). It stays live and unthrottled.
--   * `email_notification` is the NOTIFICATION mode: an immediate, one-per-event
--     email. It is the channel the throttle governs, and it has no delivery
--     path yet -- it lands with the push dispatch (Phase 5), where push is the
--     other notification-mode fan-out sharing the same gate. Stored now,
--     rendered "coming soon" (the UnifiedPush pattern), so no later migration.
--   * `throttle_minutes` is the per-category cooldown for the notification-mode
--     fan-out; 0 disables. Stored now, enforced in Phase 5 with the dispatch it
--     gates. It never touches the in-app row (the bell shows every notification).
--
-- Both new columns are stored ahead of their consumer deliberately (as
-- user_preferences.notification_browser and the scaffolded UnifiedPush column
-- already are), so the matrix can render and persist the full model before the
-- Phase 5 dispatch reads it. DEFAULT FALSE / 0 means nothing changes for any
-- existing user until they opt in once the channel is live.

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS email_notification BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS throttle_minutes INTEGER NOT NULL DEFAULT 0;
