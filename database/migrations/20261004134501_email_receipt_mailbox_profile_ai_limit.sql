-- A switch the user controls (docs/future-plans/email-receipts.md section 7.1):
-- whether a confirmed proposal that a saved parser profile built (the
-- deterministic reading, never an AI-built proposal) counts toward the daily AI
-- write limit. true (the default) keeps today's behaviour: every confirm counts.
--
-- Expand only: a nullable-free column with a constant default, so the previous
-- release (which never names it) inserts rows that read `true` and keeps
-- working during a rolling deploy.

ALTER TABLE email_receipt_mailboxes
    ADD COLUMN IF NOT EXISTS profile_proposals_count_toward_ai_limit BOOLEAN NOT NULL DEFAULT true;
