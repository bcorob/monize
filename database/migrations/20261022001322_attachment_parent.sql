-- Attachments gain a second parent (docs/specs/warranty-tracker.md,
-- decision 7 and section 6.3; invariant WTY-003).
--
-- A warranty's receipt, manual and photos are attachments too, stored in the
-- same table and through the same service, storage providers, tombstone
-- trigger, orphan sweeper and storage migrator as a transaction's receipts.
-- So `transaction_id` becomes nullable, `warranty_id` joins it, and
-- `chk_attachment_one_parent` requires exactly one of the two: an attachment
-- never has no parent and never has two. `document_kind` says what a
-- warranty's document is; a transaction's attachments keep the default
-- `other`. Ownership stays `user_id` on this row, so the attachment_blobs
-- policy and everything keyed by attachment id are untouched.
--
-- The table keeps its historical name: renaming it would touch every consumer
-- for no behaviour.
--
-- Expand only: dropping the NOT NULL widens what the previous release's writer
-- (which always sets transaction_id) may still insert, the new columns have
-- defaults or are nullable, and the CHECK constraints admit every existing
-- row (transaction_id set, document_kind 'other').

ALTER TABLE transaction_attachments ALTER COLUMN transaction_id DROP NOT NULL;

ALTER TABLE transaction_attachments
    ADD COLUMN IF NOT EXISTS warranty_id UUID REFERENCES warranties(id) ON DELETE CASCADE;

ALTER TABLE transaction_attachments
    ADD COLUMN IF NOT EXISTS document_kind VARCHAR(20) NOT NULL DEFAULT 'other';

COMMENT ON COLUMN transaction_attachments.warranty_id IS
    'The warranty this document belongs to; exactly one of transaction_id and warranty_id is set (chk_attachment_one_parent).';

COMMENT ON COLUMN transaction_attachments.document_kind IS
    'What a warranty''s document is: receipt, manual, photo or other. A transaction''s attachments are always other.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_attachment_document_kind'
    ) THEN
        ALTER TABLE transaction_attachments
            ADD CONSTRAINT chk_attachment_document_kind
            CHECK (document_kind IN ('receipt', 'manual', 'photo', 'other'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_attachment_one_parent'
    ) THEN
        ALTER TABLE transaction_attachments
            ADD CONSTRAINT chk_attachment_one_parent
            CHECK (((transaction_id IS NOT NULL)::int + (warranty_id IS NOT NULL)::int) = 1);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transaction_attachments_warranty
    ON transaction_attachments(warranty_id);
