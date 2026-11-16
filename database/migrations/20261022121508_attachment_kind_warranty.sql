-- A warranty's documents gain a fifth kind, `warranty`: the warranty
-- certificate itself (docs/specs/warranty-tracker.md, decision 7 and
-- section 6.3).
--
-- `chk_attachment_document_kind` is dropped and added again with the wider
-- list. Expand only: every row the previous release can write ('receipt',
-- 'manual', 'photo', 'other') still passes, so a rolling deployment's older
-- pods keep working against it.

ALTER TABLE transaction_attachments
    DROP CONSTRAINT IF EXISTS chk_attachment_document_kind;

ALTER TABLE transaction_attachments
    ADD CONSTRAINT chk_attachment_document_kind
    CHECK (document_kind IN ('receipt', 'manual', 'photo', 'warranty', 'other'));

COMMENT ON COLUMN transaction_attachments.document_kind IS
    'What a warranty''s document is: receipt, manual, photo, warranty (the certificate) or other. A transaction''s attachments are always other.';
