-- A delegation and its grants are issued by the owner, in the owner's own
-- session, and only over the owner's own accounts (A26-M06 / A26-S04-03).
--
-- The policies from migrations 113 and 114 used one expression for USING and
-- WITH CHECK, so the delegate's read arm (`delegate_user_id = real user`) also
-- admitted writes: a statement in a delegate's own session could INSERT an
-- `account_delegates` row naming any owner, then a grant on any account, and
-- the joint read arms (migrations 132, 134) then showed it that owner's ledger.
--
-- USING keeps both arms (the delegate lists its own delegations and grants).
-- WITH CHECK is the owner's own session only: current = real = owner, so a
-- delegate acting as the owner (current = owner, real = delegate) is refused
-- too. Every application writer is the owner's session or system context
-- (delegation.service.ts), and the delegation controller is not
-- @AllowDelegate().
--
-- The grant's account must belong to the delegation's owner. The check cannot
-- read `accounts` in the policy: the accounts policy reads
-- `account_delegate_grants`, and PostgreSQL refuses that cycle with "infinite
-- recursion detected in policy". `delegation_grant_account_is_owners` reads
-- both rows as the definer instead. It returns one boolean about two ids the
-- caller supplies; EXECUTE stays with PUBLIC because a policy expression runs
-- with the caller's privileges.

CREATE OR REPLACE FUNCTION delegation_grant_account_is_owners(
  p_delegation_id UUID,
  p_account_id UUID
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM account_delegates ad
      JOIN accounts a ON a.user_id = ad.owner_user_id
     WHERE ad.id = p_delegation_id
       AND a.id = p_account_id
  )
$$;

COMMENT ON FUNCTION delegation_grant_account_is_owners(UUID, UUID) IS
  'True when the account belongs to the owner of the delegation. SECURITY '
  'DEFINER because the account_delegate_grants WITH CHECK cannot read accounts '
  'under RLS: the accounts policy reads account_delegate_grants (a policy cycle).';

DROP POLICY IF EXISTS account_delegates_isolation ON account_delegates;
CREATE POLICY account_delegates_isolation ON account_delegates
  USING (owner_user_id = (SELECT app_current_user_id())
      OR delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK ((owner_user_id = (SELECT app_current_user_id())
               AND owner_user_id = (SELECT app_real_user_id()))
      OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS account_delegate_grants_isolation ON account_delegate_grants;
CREATE POLICY account_delegate_grants_isolation ON account_delegate_grants
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM account_delegates ad
    WHERE ad.id = account_delegate_grants.delegation_id
      AND (ad.owner_user_id = (SELECT app_current_user_id())
        OR ad.delegate_user_id = (SELECT app_real_user_id()))))
  WITH CHECK ((SELECT app_bypass_rls()) OR (EXISTS (
    SELECT 1 FROM account_delegates ad
    WHERE ad.id = account_delegate_grants.delegation_id
      AND ad.owner_user_id = (SELECT app_current_user_id())
      AND ad.owner_user_id = (SELECT app_real_user_id()))
    AND delegation_grant_account_is_owners(
      account_delegate_grants.delegation_id,
      account_delegate_grants.account_id)));

-- Each table a post-M3 policy names enables RLS in the same file
-- (database/CLAUDE.md, rule 1); both already are wherever 123 ran, so this is a
-- no-op there and inert at RLS_MODE=off/shadow.
ALTER TABLE account_delegates ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_delegate_grants ENABLE ROW LEVEL SECURITY;
