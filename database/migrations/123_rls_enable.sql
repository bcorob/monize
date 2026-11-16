-- Row-Level Security: the enable step. This is FLIP B.
--
-- Migrations 111-118 shipped the helper functions and one policy per owned
-- table, all deliberately inert: a policy on a table without ENABLE ROW LEVEL
-- SECURITY is never consulted by the planner. This file is what makes them
-- live, and it is the only migration in the RLS series that is not safe to
-- deploy on its own schedule.
--
-- Sequencing (see docs/rls-runbook.md): flip A is
-- the privilege drop -- the app connects as the unprivileged monize_app role
-- instead of the owner, with policies still inert, which proves the role, its
-- grants and every context-wrapping path work without changing a single query
-- result. Only after flip A has soaked does this file ship. Deploying the two
-- together would turn any missing withUserContext/withSystemContext wrap into a
-- silent zero-rows bug in production instead of a caught one in staging.
--
-- Why this is nonetheless harmless on a FRESH install, where schema.sql applies
-- it immediately: enabling RLS does not affect the table OWNER, and at
-- RLS_MODE=off (the default, and the only mode a new deployment starts in) the
-- app connects as the owner. Ownership bypass is also what keeps db-init,
-- db-migrate and backup restore working. That bypass is exactly why FORCE ROW
-- LEVEL SECURITY is NOT used here: forcing it would apply policies to the owner
-- too and break every one of those paths, and would make this file a behaviour
-- change rather than a no-op at RLS_MODE=off.

-- ---------------------------------------------------------------------------
-- Derived from pg_policies rather than a hard-coded table list.
--
-- A static list is wrong for two reasons. It goes stale between authoring and
-- deployment -- this file waits for flip A, and tables keep landing in the
-- meantime (import_staged_files, import_jobs and security_documents all
-- postdate the policy migrations). And it can disagree with what is actually
-- policied: enabling RLS on a table with NO policy makes it deny-all for every
-- non-owner, which is a silent outage, not a safe default. Reading the catalog
-- makes both failure modes impossible -- exactly the tables that have a policy
-- get that policy enforced, and the four deliberately-exempt tables
-- (currencies, exchange_rates, oauth_payloads, schema_migrations) have no
-- policy and are therefore never touched.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY on an already-enabled table is a no-op,
-- and the loop re-derives its target list on every run.
--
-- NOTE for any migration added AFTER this one: a new user-owned table must ship
-- its own ENABLE ROW LEVEL SECURITY alongside its policy. This loop has already
-- run on existing deployments and will not run again, so a policy added later
-- is inert on exactly the databases that matter. See database/CLAUDE.md.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT DISTINCT tablename
          FROM pg_policies
         WHERE schemaname = 'public'
         ORDER BY tablename
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;
