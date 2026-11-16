-- Matching configured by the parser profile (docs/future-plans/email-receipts.md
-- section 5.5, docs/specs/email-receipt-matching.md section 3a): a profile's
-- `match.by` list names the strategies tried in order, and the strategy that
-- found the transaction is stored as the receipt's match_kind. Two new values:
--   reference    the profile's `reference` field (an identifier the shop or the
--                payment gateway puts into the bank operation) was found in the
--                transaction's text
--   amount_date  the amount, within the profile's tolerance, inside the
--                profile's date window (no payee signal)
-- `amount_only` stays in the CHECK and in the code: it is what rows matched
-- before this change carry, and it is never written again (the same strategy is
-- now `amount_date`).
--
-- Expand only: the CHECK gains two values and accepts every row the previous
-- release writes, so a rolling deploy keeps working.

ALTER TABLE email_receipts DROP CONSTRAINT IF EXISTS ck_email_receipts_match_kind;
ALTER TABLE email_receipts
    ADD CONSTRAINT ck_email_receipts_match_kind
    CHECK (match_kind IS NULL
           OR match_kind IN ('order_id', 'reference', 'amount_payee',
                             'amount_date', 'amount_only', 'manual'));
