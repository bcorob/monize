-- No stored constant payment for a LINEAR or INTEREST_ONLY mortgage
-- (docs/specs/mortgage-types.md, decision 11 and section 5.6, task P2-B1).
-- Those methods have no constant installment: each one is priced at its due
-- date from the dated debt and rate, so a figure in payment_amount could only
-- be a snapshot that goes stale on the first repayment. The CHECK makes a
-- writer that was missed fail at the constraint instead of storing it.
--
-- Inert: every existing row is ANNUITY, CANADIAN_FIXED or null (the DTOs
-- refused the other two types until this release), so every row satisfies it
-- and nothing is rewritten.
ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_payment_amount_method_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_payment_amount_method_check
  CHECK (
    payment_amount IS NULL
    OR mortgage_type IS NULL
    OR mortgage_type IN ('ANNUITY', 'CANADIAN_FIXED')
  );
