-- A parser-draft request (kind email_parser_draft) may now name emails of up to
-- five sender domains, at most five per domain (docs/specs/email-receipt-linked-receipts.md
-- section 10a): the CHECK on email_receipt_ids widens from 5 to 25 ids. The
-- per-domain and domain-count limits are the application's.
--
-- Expand only: the bound is relaxed, so every row the previous release writes
-- (at most five ids) still satisfies it during a rolling deploy.

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_email_receipt_ids;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_email_receipt_ids
    CHECK (email_receipt_ids IS NULL OR cardinality(email_receipt_ids) <= 25);
