-- Allow budget_alerts without a linked budget (e.g. BILL_DUE, MORTGAGE_REMINDER alerts)
--
-- Guarded on the table's existence because migration 179 renames budget_alerts
-- to `notifications`, carrying both nullable columns with it. Every migration is
-- replayed on top of schema.sql at container start and in CI, and a statement
-- naming a table the schema no longer has aborts that replay -- so a database
-- that has reached 179 skips this, and one that has not runs it exactly as
-- before. PL/pgSQL plans a statement only when it is reached, which is what
-- makes the guard work: naming a missing table outside a DO block is a parse
-- error, not a skipped branch.
DO $migration_037_nullable$
BEGIN
    IF to_regclass('public.budget_alerts') IS NULL THEN
        RAISE NOTICE
            'budget_alerts has been renamed to notifications (migration 179), which carries both nullable columns; skipping';
        RETURN;
    END IF;

    ALTER TABLE budget_alerts ALTER COLUMN budget_id DROP NOT NULL;
    ALTER TABLE budget_alerts ALTER COLUMN budget_category_id DROP NOT NULL;
END
$migration_037_nullable$;
