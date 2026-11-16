-- System-level alerts (BACKUP_FAILED, PROVIDER_OUTAGE, SMTP_FAILURE, ...) live
-- in budget_alerts with budget_id NULL, and idx_budget_alerts_fingerprint
-- cannot arbitrate those rows: budget_id is not COALESCE'd there, and NULL
-- never equals NULL in a unique index. Every replica runs every cron, so
-- without a database key each replica would insert its own copy of the same
-- alert and each copy would try to email the administrators.
--
-- dedupe_key is the explicit fingerprint a system alert carries
-- (e.g. 'BACKUP_FAILED:<userId>:<date>'); the partial unique index makes
-- INSERT ... ON CONFLICT DO NOTHING RETURNING id the cross-replica arbiter for
-- both the row and its email (only the insert winner sends). Budget-generated
-- alerts keep dedupe_key NULL and stay governed by the fingerprint index.
-- Guarded on the table's existence because migration 179 renames budget_alerts
-- to `notifications` and carries the column and the index across with it. A
-- database that has not reached 179 still calls the table budget_alerts and runs
-- this exactly as it always did; one that has -- a fresh install built from
-- schema.sql, and the replay CI runs on top of it -- already has both. PL/pgSQL
-- plans a statement only when it is reached, which is what makes the guard work:
-- naming a missing table outside a DO block is a parse error, not a skipped
-- branch.
DO $migration_170_dedupe$
BEGIN
    IF to_regclass('public.budget_alerts') IS NULL THEN
        RAISE NOTICE
            'budget_alerts has been renamed to notifications (migration 179), which carries dedupe_key and its index; skipping';
        RETURN;
    END IF;

    ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(120);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_alerts_dedupe
        ON budget_alerts(user_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL;
END
$migration_170_dedupe$;
