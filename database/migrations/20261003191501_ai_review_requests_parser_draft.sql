-- The `email_parser_draft` kind of the AI review queue
-- (docs/future-plans/email-receipts.md sections 4 and 6): a request that asks an
-- assistant or an MCP agent to write a receipt parser from up to five stored
-- order emails of one sender. It is about emails, not a transaction.
--
-- Expand only, so the previous release keeps working against this schema during
-- a rolling deploy: the kind CHECK gains a value and transaction_id stops being
-- NOT NULL (both relaxations), the new columns are nullable, and the two new
-- CHECKs accept every row the previous release writes (a request of the old kinds
-- always has a transaction and neither new column).
--
-- Shape, held by the CHECKs:
--   email_parser_draft  transaction_id NULL, email_receipt_ids (1..5 ids, no
--                       foreign key: an array cannot have one; a deleted email is
--                       simply not found when the request is claimed),
--                       parser_domain (the sender domain the draft is for).
--   any other kind      a transaction, and neither new column.
--
-- uq_ai_review_requests_open is deliberately NOT changed (the running release's
-- ON CONFLICT infers its predicate); NULL transaction ids are distinct in it, so
-- a parser-draft request never conflicts there. At most one OPEN parser-draft
-- request per user and sender domain is held by its own partial unique index,
-- which the application's replace-then-insert (under an advisory lock) leans on
-- as the backstop.

ALTER TABLE ai_review_requests ALTER COLUMN transaction_id DROP NOT NULL;

ALTER TABLE ai_review_requests ADD COLUMN IF NOT EXISTS email_receipt_ids UUID[];
ALTER TABLE ai_review_requests ADD COLUMN IF NOT EXISTS parser_domain VARCHAR(255);

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_kind;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_kind
    CHECK (kind IN ('transaction_review', 'email_receipt', 'email_parser_draft'));

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_email_receipt_ids;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_email_receipt_ids
    CHECK (email_receipt_ids IS NULL OR cardinality(email_receipt_ids) <= 5);

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_transaction_required;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_transaction_required
    CHECK (kind = 'email_parser_draft' OR transaction_id IS NOT NULL);

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_parser_draft_shape;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_parser_draft_shape
    CHECK (
      (kind = 'email_parser_draft'
        AND transaction_id IS NULL
        AND email_receipt_ids IS NOT NULL
        AND cardinality(email_receipt_ids) >= 1
        AND parser_domain IS NOT NULL)
      OR
      (kind <> 'email_parser_draft'
        AND email_receipt_ids IS NULL
        AND parser_domain IS NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_review_requests_parser_draft_open
    ON ai_review_requests(user_id, parser_domain)
    WHERE kind = 'email_parser_draft' AND status IN ('pending', 'claimed', 'proposed');
