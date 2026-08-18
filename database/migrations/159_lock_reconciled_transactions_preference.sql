-- 159: Strict reconciled-transaction lock preference
--
-- Microsoft Money prompts before an edit to a reconciled transaction and then
-- lets it through; that prompt already exists in the transaction form. This
-- flag is the user's option to make the refusal absolute: while it is on, the
-- server refuses to alter, delete or unreconcile a RECONCILED row at all, and
-- the way to make such a change is to turn the flag back off in Settings.
--
-- Default false, so existing users keep the prompt-and-allow behaviour.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS lock_reconciled_transactions BOOLEAN NOT NULL DEFAULT false;
