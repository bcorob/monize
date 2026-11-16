-- Row-Level Security, task M2 (3/3): tables with bespoke owner columns, plus
-- the documented list of tables deliberately left uncovered.
--
-- INERT (no ENABLE here -- that is M3 / flip B) and free of role and grant
-- statements, for the reasons given in 112_rls_policies_direct.sql.
--
-- None of these five tables has a user_id column: applying the direct-policy
-- template to them would fail at migration time with
-- `column "user_id" does not exist` and crash-loop the deployment. Their owner
-- columns were read off database/schema.sql.
--
-- These are also where both identity GUCs matter. app.current_user_id is the
-- effective user (the OWNER when a delegate is acting); app.real_user_id is the
-- authenticated identity (the DELEGATE while acting). Outside delegation they
-- hold the same id, so every real-arm below is redundant then and load-bearing
-- only while a delegate acts.
--
-- See docs/specs/row-level-security.md (Phase 3).

-- ---------------------------------------------------------------------------
-- users -- self-access through EITHER identity.
--
-- A delegate acting for an owner must still reach their OWN row: changePassword
-- deliberately targets req.user.realUserId, as do the 2FA and trusted-device
-- endpoints. Under a current-only policy those reads return no row and the
-- endpoints 404 while a delegate is acting.
--
-- Cross-user reads that legitimately precede a session -- login by email, OIDC
-- account lookup, admin -- carry no identity yet and go through
-- withSystemContext, i.e. the bypass arm.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS users_self ON users;
CREATE POLICY users_self ON users
  USING (id = (SELECT app_current_user_id())
      OR id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (id = (SELECT app_current_user_id())
      OR id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- account_delegates -- visible from both sides of the delegation.
--
-- The owner reaches it through app.current_user_id (managing who they share
-- with). The delegate reaches it through app.real_user_id, which works both in
-- their own session (current = real = delegate) and while acting for the owner
-- (current = owner, real = delegate) -- the latter is what lets the delegate
-- guard resolve its own grant row on every acting request.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS account_delegates_isolation ON account_delegates;
CREATE POLICY account_delegates_isolation ON account_delegates
  USING (owner_user_id = (SELECT app_current_user_id())
      OR delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (owner_user_id = (SELECT app_current_user_id())
      OR delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- delegate_account_favourites -- belongs to the delegate personally.
--
-- Keyed by the delegate's own identity even while they act as the owner
-- (current = owner, real = delegate), so this is the one table scoped by
-- app.real_user_id alone. Matching app.current_user_id as well would let an
-- owner read the private favourites of the delegates they share with.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS delegate_account_favourites_isolation ON delegate_account_favourites;
CREATE POLICY delegate_account_favourites_isolation ON delegate_account_favourites
  USING (delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- emergency_access_settings / emergency_access_contacts -- owner-keyed only.
--
-- The authenticated surface (emergency-access.controller.ts, class-guarded by
-- AuthGuard('jwt') + StepUpGuard, no @AllowDelegate) is entirely owner-keyed:
-- every service call passes req.user.id as the owner and every query filters
-- owner_user_id. There is no "who named me as an emergency contact" lookup, so
-- no grantee-side arm is needed (audited in task C4).
--
-- The grantee-facing side is the public claim flow, which identifies the
-- grantee by emailed claim token rather than by user id and runs entirely under
-- withSystemContext -- the bypass arm.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS emergency_access_settings_isolation ON emergency_access_settings;
CREATE POLICY emergency_access_settings_isolation ON emergency_access_settings
  USING (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS emergency_access_contacts_isolation ON emergency_access_contacts;
CREATE POLICY emergency_access_contacts_isolation ON emergency_access_contacts
  USING (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

-- ---------------------------------------------------------------------------
-- Deliberately NOT policied (and therefore never enabled in M3).
--
-- The exemption set and the rationale for each entry are no longer written out
-- here. This file has already been applied on every deployed database, so
-- db-migrate will never re-read it (the tracker keys off the filename, not the
-- content) -- which makes it the worst of the five places this list was kept,
-- and the one that drifted furthest: it documented four tables while the schema
-- and both integration specs carried six, and claimed the catalog-driven test
-- asserted "this exact list" when by then the test asserted a different one.
--
-- Canonical, in order of authority:
--   docs/row-level-security-contract.md         -- the rationale and boundaries
--   backend/src/common/db/rls-exempt-tables.ts  -- the machine-readable set
--   database/schema.sql                         -- `rls-exempt:` marker block
--
-- backend/src/common/db/rls-exempt-tables.spec.ts checks the last two against
-- each other in both directions without a database.
--
-- One correction worth stating where the wrong claim was made: this block used
-- to assert that all oauth_payloads access "runs under withSystemContext
-- regardless". It does not, and never did. node-oidc-provider is mounted as raw
-- Express middleware outside Nest's request pipeline, so PostgresAdapter runs
-- with no ambient identity context at all. The exemption is still correct --
-- the table has no owner column and is keyed by opaque provider ids -- but for
-- the reasons the contract gives, not that one.
-- ---------------------------------------------------------------------------

-- Verification helper (run manually; not part of the migration's effect):
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public' ORDER BY tablename;
-- Expected: 50 policies -- 26 direct + 4 real-user-keyed (112),
--           15 indirect (113), 5 special (114).
