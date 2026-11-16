-- Per-category notification_preferences.push supersedes the dormant browser flag.
-- Do not map the old flag into the matrix: it never gated delivery, and doing so
-- would overwrite the user's actual per-category choices. Older backup rows have
-- this column stripped by the restore's live-schema column allowlist.
ALTER TABLE user_preferences DROP COLUMN IF EXISTS notification_browser;
