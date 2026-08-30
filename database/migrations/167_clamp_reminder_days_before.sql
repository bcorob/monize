-- Renumbered from prefix 165 to 167. Two merged pull requests each claimed 165,
-- and a duplicate prefix leaves apply order to alphabetical tie-breaking rather
-- than to the number that is supposed to decide it.
--
-- `schema_migrations` keys on filename, so a rename makes this file run once
-- more on any database that already applied it. That is safe here, and it is why
-- this is the half of the pair that moved: both statements below exclude their
-- own result, and the constraint is dropped before it is added. Its former pair,
-- `165_heal_semimonthly_scheduled_frequency.sql`, keeps the number because its
-- heal is dated against the day it runs.
--
-- Issue #1247 review: `reminder_days_before` accepted any non-negative number,
-- and a value past JavaScript's `Date` range made the reminder window's upper
-- bound serialize as the literal string "NaN-NaN-NaN". The occurrence expander
-- compares window bounds as text, and "2026-08-26" <= "NaN-NaN-NaN" is true
-- (digits sort before letters), so every one of that user's manual bills was
-- reported as due today, every day, each walked to the recurrence guard inside
-- the cron every tenant shares.
--
-- The DTO now bounds the field (MAX_REMINDER_DAYS_BEFORE in
-- backend/src/scheduled-transactions/reminder-window.ts, mirrored by the CHECK
-- below), and the reminder path clamps what it reads. This normalizes the rows
-- written before the bound existed: without it the write path contradicts the
-- read path, and because the schedule form resends the whole object, a row above
-- the ceiling would fail validation on EVERY later save -- a description-only
-- edit included -- leaving the schedule uneditable until the user worked out
-- which field to lower.
--
-- A year is more than any reminder needs (the longest real case is an annual
-- renewal, which wants notice measured in weeks), and the clamp preserves the
-- intent of every plausible value: nobody meaningfully asked to be reminded
-- more than a year ahead.
--
-- Idempotent by construction: a clamped row no longer matches the WHERE clause,
-- so re-running the statement is a no-op.
UPDATE scheduled_transactions
SET reminder_days_before = 366
WHERE reminder_days_before > 366;

-- Negative notice periods were never reachable through the API (`@Min(0)` has
-- always been there) but are cheap to rule out, and the CHECK below would
-- otherwise refuse to attach over one.
UPDATE scheduled_transactions
SET reminder_days_before = 0
WHERE reminder_days_before < 0;

-- The bound, in the one place a bad row cannot get past: the DTO is the API's
-- door, and this is the column's. Dropped first so the migration replays as a
-- no-op on a database that already carries it.
ALTER TABLE scheduled_transactions
    DROP CONSTRAINT IF EXISTS chk_scheduled_reminder_days_before;
ALTER TABLE scheduled_transactions
    ADD CONSTRAINT chk_scheduled_reminder_days_before
    CHECK (reminder_days_before IS NULL OR (reminder_days_before BETWEEN 0 AND 366));
