-- Intentionally a no-op. This migration used to clear password_hash, the
-- reset token and must_change_password on every SSO-linked account
-- (kenlasko/monize#1858). An SSO link now keeps the local password, and
-- OIDC_ALLOW_PASSWORD_LOGIN decides whether it may sign in, so nothing is
-- cleared here any more. The file stays because schema_migrations keys on the
-- filename (scripts/check-migration-prefixes.mjs); databases that already ran
-- the old body keep its effect.
SELECT 1;
