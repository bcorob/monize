-- Loan installment settlement (docs/specs/loan-installment-settlement.md, task
-- B1): the columns a settlement claim needs on scheduled_transaction_postings,
-- and the pointer from a loan account to the rule that settles its
-- installments.
--
-- A posting row is the claim on one occurrence of a schedule. It gains the
-- transaction that paid the occurrence (released with it: ON DELETE CASCADE,
-- and at most one claim per transaction), whether the bill's own post or a
-- rule made it, the rule that did, and the priced breakdown the rule booked.
--
-- Expand only, and inert: every new column is nullable except `source`, whose
-- constant default labels every existing row correctly ('post' is the only
-- writer today). Nothing writes the new columns yet.
ALTER TABLE scheduled_transaction_postings
  ADD COLUMN IF NOT EXISTS transaction_id UUID NULL REFERENCES transactions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'post',
  ADD COLUMN IF NOT EXISTS rule_id UUID NULL REFERENCES transaction_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pricing JSONB NULL;

ALTER TABLE scheduled_transaction_postings
  DROP CONSTRAINT IF EXISTS chk_stp_source;
ALTER TABLE scheduled_transaction_postings
  ADD CONSTRAINT chk_stp_source CHECK (source IN ('post', 'rule'));

-- A rule claim always names the transaction it settled; a post claim may not
-- (an investment post, a retired debt, every row written before the writer).
ALTER TABLE scheduled_transaction_postings
  DROP CONSTRAINT IF EXISTS chk_stp_rule_claim_transaction;
ALTER TABLE scheduled_transaction_postings
  ADD CONSTRAINT chk_stp_rule_claim_transaction
  CHECK (source = 'post' OR transaction_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stp_transaction
  ON scheduled_transaction_postings(transaction_id)
  WHERE transaction_id IS NOT NULL;

-- The rule a loan's "Payment matching" created. SET NULL on the rule's delete:
-- the loan survives its rule, and the panel offers to create another.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS payment_matching_rule_id UUID NULL;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS fk_accounts_payment_matching_rule;
ALTER TABLE accounts
  ADD CONSTRAINT fk_accounts_payment_matching_rule
  FOREIGN KEY (payment_matching_rule_id) REFERENCES transaction_rules(id) ON DELETE SET NULL;
