-- 162: Record the currency pair a scheduled investment's FX rate was resolved for
--
-- A scheduled investment (and an embedded investment split) can persist an FX
-- rate that converts the security's currency into the settlement account's
-- currency. That rate was a bare scalar with no record of the pair it belonged
-- to, so a later currency change on the referenced security or account (id
-- unchanged) left the stored rate applying to a pair that no longer exists --
-- the posting then converted the cash at a rate for the wrong pair (issue
-- #1167, the residual edge left by #1154).
--
-- These columns make the rate self-describing: the posting path re-derives the
-- current (source currency, settlement currency) pair and reuses the stored
-- rate only when it still matches, otherwise re-resolves. Nullable and derived
-- server-side whenever a rate is stored; a NULL pair (a pre-existing row, or a
-- rate round-tripped through an edit) is treated as unknown, so the stored
-- scalar is re-resolved rather than trusted (no backfill -- deriving the pair in
-- SQL would be a second copy of the derivation the contract keeps in one place).
-- The override surface stores its pair inside the splits jsonb, so it needs no
-- column here.

ALTER TABLE scheduled_transactions
  ADD COLUMN IF NOT EXISTS investment_exchange_rate_from_currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS investment_exchange_rate_to_currency VARCHAR(3);

ALTER TABLE scheduled_transaction_splits
  ADD COLUMN IF NOT EXISTS investment_exchange_rate_from_currency VARCHAR(3),
  ADD COLUMN IF NOT EXISTS investment_exchange_rate_to_currency VARCHAR(3);
