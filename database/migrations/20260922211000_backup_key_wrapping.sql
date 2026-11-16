-- Automatic backups are encrypted under a per-user data key instead of a stored
-- copy of the user's password (docs/specs/backup-envelope-key-wrapping.md).
--
-- backup_key_enc          the data key (base64) as EncryptionService ciphertext
--                         under ENCRYPTION_KEY, so the backup cron can encrypt
--                         without the password.
-- backup_key_wrap         the same data key wrapped under a scrypt key derived
--                         from the password that opens the user's backups
--                         (base64); copied into every automatic backup's header.
-- backup_key_password_ref SHA-256 of the password_hash the wrap was made for,
--                         NULL for an OIDC account's dedicated backup password;
--                         a stale value means the wrap is no longer usable.
--
-- Expand only. backup_password_enc stays: rows are converted by the
-- application (at the next sign-in or the next automatic backup), which clears
-- it. No password is decrypted here. Dropping the column is a later release.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS backup_key_enc TEXT,
    ADD COLUMN IF NOT EXISTS backup_key_wrap TEXT,
    ADD COLUMN IF NOT EXISTS backup_key_password_ref VARCHAR(64);
