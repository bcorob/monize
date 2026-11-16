-- Trade confirmations in email receipts (docs/specs/email-receipt-trades.md):
-- a profile with a `trade` section reads a brokerage "order filled" email as ONE
-- investment transaction to create, not as the purchase a bank transaction paid
-- for. The reading is stored on the email in `trade`, and the proposal is a
-- request of the new kind `email_trade` in the AI review queue. That request is
-- about an email, not about an existing transaction, so it has no
-- transaction_id (like an `email_parser_draft`) and carries email_receipt_id.
--
-- Expand only, so the previous release keeps working against this schema during
-- a rolling deploy: the new column is nullable, the kind CHECK gains a value
-- and the transaction-required CHECK is relaxed for it (both only widen what is
-- accepted), and the new shape CHECK is satisfied by every row the previous
-- release writes (it only constrains the new kind).
--
-- Shape of an email_trade request, held by the CHECKs:
--   transaction_id NULL, and no parser-draft columns (email_receipt_ids and
--   parser_domain, which ck_ai_review_requests_parser_draft_shape already holds
--   to NULL for every kind but email_parser_draft). email_receipt_id names the
--   email but may become NULL when the email is deleted (ON DELETE SET NULL),
--   so the CHECK does not require it.
--
-- investment_transaction_id is the ledger row a trade email accounts for: the
-- row its approved proposal created, the row a person linked it to, or the row
-- that was already there when it arrived (trade_exists). It is how a second,
-- identical fill is told from a duplicate email: a matching row that no email
-- accounts for yet is a duplicate; one another email already accounts for is
-- not. ON DELETE SET NULL, so deleting the trade frees the email.
--
-- uq_ai_review_requests_open is deliberately NOT changed (the running release's
-- ON CONFLICT infers its predicate); NULL transaction ids are distinct in it, so
-- a trade request never conflicts there. At most one OPEN trade request per
-- email is held by its own partial unique index.

ALTER TABLE email_receipts ADD COLUMN IF NOT EXISTS trade JSONB;
ALTER TABLE email_receipts ADD COLUMN IF NOT EXISTS investment_transaction_id UUID;
ALTER TABLE email_receipts DROP CONSTRAINT IF EXISTS fk_email_receipts_investment_transaction;
ALTER TABLE email_receipts
    ADD CONSTRAINT fk_email_receipts_investment_transaction
    FOREIGN KEY (investment_transaction_id) REFERENCES investment_transactions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_receipts_investment_transaction
    ON email_receipts(investment_transaction_id) WHERE investment_transaction_id IS NOT NULL;

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_kind;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_kind
    CHECK (kind IN ('transaction_review', 'email_receipt', 'email_parser_draft', 'email_trade'));

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_transaction_required;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_transaction_required
    CHECK (kind IN ('email_parser_draft', 'email_trade') OR transaction_id IS NOT NULL);

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_trade_shape;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_trade_shape
    CHECK (kind <> 'email_trade' OR transaction_id IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_review_requests_trade_open
    ON ai_review_requests(email_receipt_id)
    WHERE kind = 'email_trade' AND status IN ('pending', 'claimed', 'proposed');
