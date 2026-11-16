-- Prepayment mode of a LINEAR mortgage (docs/specs/mortgage-types.md, decisions
-- 4 and 10, task P2-B1): what an extra repayment does to the constant
-- principal. 'SHORTEN_TERM' keeps the principal and ends the loan earlier;
-- 'LOWER_INSTALLMENT' re-derives it as the remaining debt over the remaining
-- scheduled payments and keeps the end date.
--
-- Expand only, and inert: the column is nullable with no default, a null reads
-- as 'SHORTEN_TERM', and no existing row is LINEAR, so nothing is backfilled.
-- The second CHECK keeps the column null on every other type, so a stored mode
-- can never describe a mortgage whose method has no use for it; the service
-- writes null whenever the saved type is not LINEAR.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS prepayment_mode VARCHAR(20);

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_prepayment_mode_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_prepayment_mode_check
  CHECK (prepayment_mode IN ('SHORTEN_TERM', 'LOWER_INSTALLMENT'));

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_prepayment_mode_linear_only;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_prepayment_mode_linear_only
  CHECK (prepayment_mode IS NULL OR mortgage_type = 'LINEAR');
