-- Repeating / one-time notification reminders (discussion #1291,
-- docs/specs/notification-preferences.md Section 13).
--
-- One row per active reminder a user asked for. The row carries the TEMPLATE the
-- fire re-emits (the same public fields a notification row has), so a fire never
-- has to reload the source notification, which the user may have dismissed. Each
-- fire re-emits through the dispatch seam (NotificationDispatchService.notify,
-- which writes through the one write door) with a per-fire dedupe key, so every
-- re-delivery is a fresh in-app row -- the in-app channel is always written
-- (Section 3) -- fanned out by push/email per the matrix and throttle.
--
-- source_notification_id is ON DELETE SET NULL, not CASCADE: the reminder is
-- stopped when its source is dismissed (a nag cannot outlive its cause), and a
-- deleted source must not silently delete the reminder mid-fire.
--
-- Exported by backups: it is user data (see export-table-queries.ts,
-- restore-plan.ts after notifications, and support-backup-rules.ts). User-owned,
-- so the uniform direct policy AND its own ENABLE (this migration is numbered
-- after 123_rls_enable.sql, which derives its targets from pg_policies at the
-- moment it runs and never runs again on a deployed database).

CREATE TABLE IF NOT EXISTS notification_reminders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
    -- The template a fire re-emits. alert_type is a NotificationType; kept at the
    -- same VARCHAR(30) bound as notifications.alert_type.
    alert_type VARCHAR(30) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    -- Nullable like notifications.data so the support backup drops it the same
    -- way (amounts/names can appear in the template JSON).
    data JSONB DEFAULT '{}',
    target VARCHAR(255),
    -- Base for the per-fire dedupe key; each fire appends the fire ordinal so a
    -- re-emit is always a fresh bell row. Bounded so base + ":rem:<uuid>:<n>"
    -- stays inside notifications.dedupe_key (VARCHAR(120)).
    dedupe_base VARCHAR(80),
    -- 'once' (deliver, one follow-up, stop) or 'repeat' (until stopped). The
    -- preference-level 'off' from Section 5 means no row exists, so it is not a
    -- stored value here.
    repeat_mode VARCHAR(10) NOT NULL,
    -- Minutes between fires; >= REMINDER_MIN_INTERVAL_MINUTES (5), clamped up by
    -- the service so a stored value below the floor is never fired below it.
    interval_minutes INTEGER NOT NULL,
    next_fire_at TIMESTAMP NOT NULL,
    last_fired_at TIMESTAMP,
    fire_count INTEGER NOT NULL DEFAULT 0,
    stopped_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The firing cron scans due, non-stopped rows across all users each minute; the
-- partial index keeps that scan off the stopped history.
CREATE INDEX IF NOT EXISTS idx_notification_reminders_due
    ON notification_reminders (next_fire_at) WHERE stopped_at IS NULL;

-- Stopping a reminder when its source notification is dismissed reads by source.
CREATE INDEX IF NOT EXISTS idx_notification_reminders_source
    ON notification_reminders (source_notification_id)
    WHERE source_notification_id IS NOT NULL;

-- At most one ACTIVE reminder per (user, source): a second "remind me" on the
-- same notification (a double-submit, or a re-configure) must not create a
-- parallel nag. Stopped reminders are excluded so the user can set a new one
-- after stopping; NULL sources are excluded (there are none today, and a future
-- standalone reminder is not keyed on a source).
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_reminders_active_source
    ON notification_reminders (user_id, source_notification_id)
    WHERE stopped_at IS NULL AND source_notification_id IS NOT NULL;

DROP POLICY IF EXISTS notification_reminders_isolation ON notification_reminders;
CREATE POLICY notification_reminders_isolation ON notification_reminders
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE notification_reminders ENABLE ROW LEVEL SECURITY;

-- updated_at maintained by the GUC-aware trigger like every table carrying the
-- column, so the atomic-claim UPDATE advances it and a restore under
-- app.preserve_timestamps keeps the backed-up value.
DROP TRIGGER IF EXISTS update_notification_reminders_updated_at
    ON notification_reminders;
CREATE TRIGGER update_notification_reminders_updated_at
    BEFORE UPDATE ON notification_reminders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
