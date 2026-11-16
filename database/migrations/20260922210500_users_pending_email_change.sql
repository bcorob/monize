-- Two-step email change for self-service accounts.
--
-- Changing the account email used to write users.email the moment the current
-- password matched, with nothing sent to either address. An account holder could
-- therefore park somebody else's address on their own row (and have the OIDC
-- link flow later offer that row to the real owner of the address). With SMTP
-- configured the change is now staged: the requested address waits in
-- pending_email, a single-use token is emailed to it (only its sha256 hash is
-- stored, like reset_token and email_verification_token), and users.email only
-- changes when that link is followed before email_change_token_expiry.
--
-- All three columns are nullable and unset for every existing row, so the
-- previous release keeps working against this schema during a rollout.

ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token_expiry TIMESTAMP;

-- Partial index for the confirmation-token lookup (mirrors
-- idx_users_email_verification_token).
CREATE INDEX IF NOT EXISTS idx_users_email_change_token
  ON users(email_change_token) WHERE email_change_token IS NOT NULL;
