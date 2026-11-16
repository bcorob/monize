-- This deployment's OIDC provider signing keys, as one encrypted row.
--
-- `oidc-provider` generates a development key pair when none is configured, so
-- every replica currently signs ID tokens with its own keys and serves its own
-- `/oauth/jwks`. A client that fetched JWKS from one pod and verifies a token
-- minted by another finds no matching `kid` and rejects a perfectly good token;
-- a single pod does the same thing to itself across a restart. One row makes
-- the deployment's signing identity one identity.
--
-- Singleton, like push_instance_config: the key admits exactly one value, so
-- several replicas racing on first start collide on the primary key and the
-- loser re-reads the winner's row instead of minting a second identity.
--
-- jwks_enc is AES-256-GCM ciphertext under ENCRYPTION_KEY. A deployment
-- without that variable stores nothing here and keeps today's per-process
-- behaviour -- private signing keys in plaintext would be worse than keys that
-- do not survive a restart.
--
-- Deployment-wide state with no owner column, so the table is RLS-exempt for
-- the same reason push_instance_config is; see the marker block at the foot of
-- database/schema.sql and docs/row-level-security-contract.md.
--
-- rls-exempt: oauth_instance_config

CREATE TABLE IF NOT EXISTS oauth_instance_config (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    jwks_enc TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
