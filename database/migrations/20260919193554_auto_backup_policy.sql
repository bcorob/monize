-- The deployment's automatic-backup policy, as one row.
--
-- The policy -- schedule, folder, retention, and whether automatic backups run
-- at all -- used to be stored on the `auto_backup_settings` row of whichever
-- administrator happened to be the earliest-created active one, because that is
-- the row the admin endpoints wrote. Three ordinary operations then rewrote a
-- deployment-wide setting with no warning: deactivating or demoting that
-- administrator handed ownership to the next one, whose row usually did not
-- exist, so every account silently reverted to the built-in defaults; deleting
-- them cascaded the policy away entirely; and restoring their own backup
-- replayed a months-old policy over the whole instance, with
-- `withPreserveTimestamps` keeping even `updated_at` from showing it had moved.
-- A policy that belongs to the deployment needs a row that belongs to the
-- deployment.
--
-- `auto_backup_settings` keeps exactly what is one account's: the bookkeeping
-- of that account's own runs (`last_backup_at`, `last_backup_status`,
-- `last_backup_error`, `next_backup_at`, which is also the cron's claim). Its
-- policy columns stay where they are -- the cron still reads them per row, and
-- `reconcileManagedUsers` writes this policy onto them -- so an older replica
-- mid-rollout keeps working off a row it understands (expand now, contract
-- later).
--
-- `manual_run_claimed_at` is the fan-out claim for "Back Up Every Account Now",
-- not a setting: that button walks every account in one request, and two
-- operators pressing it, or one pressing it twice through a proxy timeout,
-- otherwise interleave two full fan-outs over the same rows. The claim is a
-- conditional UPDATE against this row and it carries its own staleness bound,
-- so a replica killed mid-run frees it without an unlock to forget.
--
-- Singleton, like update_check_state and push_instance_config: one deployment
-- has one backup policy.
--
-- Deployment-wide state with no owner column, so RLS-exempt; see the marker
-- block at the foot of database/schema.sql and
-- docs/row-level-security-contract.md.
--
-- rls-exempt: auto_backup_policy

CREATE TABLE IF NOT EXISTS auto_backup_policy (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    enabled BOOLEAN NOT NULL DEFAULT true,
    folder_path VARCHAR(1024) NOT NULL DEFAULT '',
    frequency VARCHAR(20) NOT NULL DEFAULT 'daily',
    backup_time VARCHAR(5) NOT NULL DEFAULT '02:00',
    timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
    retention_daily SMALLINT NOT NULL DEFAULT 7,
    retention_weekly SMALLINT NOT NULL DEFAULT 4,
    retention_monthly SMALLINT NOT NULL DEFAULT 6,
    -- When a manual fan-out took this row, and which run holds it. NULL
    -- means nobody does. Released BY TOKEN, so a run that outran the
    -- staleness bound cannot free the claim a later one now holds.
    manual_run_claimed_at TIMESTAMP,
    manual_run_claim_token UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Carry the incumbent policy forward, so an upgrade keeps the schedule the
-- operator configured instead of snapping back to the defaults. The source is
-- the same row the old code read: the earliest-created active administrator's.
-- `ON CONFLICT DO NOTHING` is what makes the whole file replay as a no-op.
INSERT INTO auto_backup_policy (
    id, enabled, folder_path, frequency, backup_time, timezone,
    retention_daily, retention_weekly, retention_monthly
)
SELECT TRUE, s.enabled, s.folder_path, s.frequency, s.backup_time, s.timezone,
       s.retention_daily, s.retention_weekly, s.retention_monthly
  FROM auto_backup_settings s
  JOIN users u ON u.id = s.user_id
 WHERE u.role = 'admin'
   AND u.is_active
 ORDER BY u.created_at ASC, u.id ASC
 LIMIT 1
ON CONFLICT (id) DO NOTHING;
