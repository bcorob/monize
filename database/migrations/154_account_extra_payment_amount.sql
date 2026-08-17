-- 154: Record a loan's standing extra-principal instruction on the account
--
-- The scheduled-payment recalculation that runs after each posting derives the
-- next installment from the template's own splits, so any clamp it wrote --
-- an interest spike consuming the extra for one period, a final payment
-- shrinking everything -- became the configured value on the next pass: a
-- one-way ratchet with nothing durable to grow back from (review #1131).
-- payment_amount already gives the parent that durable source; this gives the
-- extra-principal child its own. Set at payment setup, synced when the user
-- edits the loan's scheduled transaction, read (with the template split as a
-- fallback for rows that predate the column) by the recalculation.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS extra_payment_amount NUMERIC(20, 4);
