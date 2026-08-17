-- Single-use ledger for OIDC destructive step-up proofs.
--
-- A step-up proof authorises ONE destructive action (restore, delete-account,
-- delete-data, emergency access). Spending it in a process-local Map only holds
-- for one Node process: on k8s with more than one backend replica, two restore
-- requests carrying the same cookie can be routed to different replicas, each
-- find its own map empty, and both proceed. With N replicas the same proof is
-- accepted up to N times under favourable routing.
--
-- The claim therefore lives in the database, where `INSERT ... ON CONFLICT DO
-- NOTHING` is atomic across every replica: whoever inserts the row has the
-- proof, and everyone else gets zero rows affected and is refused.
--
-- Rows expire logically at `expires_at` (the proof's own `exp`), but nothing
-- reaps them on a schedule: each claim opportunistically deletes rows already
-- past their expiry in the same statement, and under RLS enforcement that sweep
-- sees only the acting user's rows. Nothing ever reads a row back -- only the
-- insert's success or conflict matters -- so a lingering expired row is
-- harmless growth, not a correctness risk. A system-context retention job is
-- where bounded cleanup would go if that growth ever mattered.
--
-- Not user-owned data in the backup sense -- it is transient auth bookkeeping
-- with a five-minute lifetime, listed in INTENTIONALLY_EXCLUDED_TABLES beside
-- `refresh_tokens` and `oauth_payloads`.

CREATE TABLE IF NOT EXISTS oidc_step_up_claims (
  -- The proof's `jti`. PRIMARY KEY is what makes the claim atomic.
  jti           text        PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       text        NOT NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

-- Sweeping expired claims.
CREATE INDEX IF NOT EXISTS idx_oidc_step_up_claims_expires
  ON oidc_step_up_claims(expires_at);

-- RLS: the claim is written on the authenticated request that spends the proof,
-- so the ordinary per-user policy applies. The ENABLE is a no-op on databases
-- where the dynamic loop has already run, but the post-123 convention requires
-- every policy migration to ship its own.
ALTER TABLE oidc_step_up_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oidc_step_up_claims_isolation ON oidc_step_up_claims;
CREATE POLICY oidc_step_up_claims_isolation ON oidc_step_up_claims
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
