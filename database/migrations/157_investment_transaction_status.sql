-- 157: Reconciliation status on investment transactions
--
-- investment_transactions gains the same status column transactions carry
-- ('UNRECONCILED', 'CLEARED', 'RECONCILED', 'VOID'). A VOID investment row
-- moves no shares and no cash; the linked cash transaction shares the VOID
-- boundary with it. Spec: docs/specs/investment-transaction-status.md.
--
-- Backfill: a row with a linked cash transaction takes the cash leg's status,
-- an embedded row takes its parent split transaction's status -- EXCEPT VOID,
-- which backfills as UNRECONCILED. Historical half-void states exist (a Money
-- import wrote a voided trade's status onto the cash leg only, because this
-- column did not exist), and backfilling VOID would silently change holdings,
-- gains and net-worth history at migration time with no rebuild triggered.
-- UNRECONCILED changes no computed number anywhere; the user makes the pair
-- coherent by voiding the investment row, which reverses the holdings and
-- skips the already-VOID cash leg.

ALTER TABLE investment_transactions
  ADD COLUMN IF NOT EXISTS status VARCHAR(20);

UPDATE investment_transactions it
SET status = CASE WHEN t.status = 'VOID' THEN 'UNRECONCILED' ELSE COALESCE(t.status, 'UNRECONCILED') END
FROM transactions t
WHERE it.transaction_id = t.id
  AND it.status IS NULL;

UPDATE investment_transactions it
SET status = CASE WHEN t.status = 'VOID' THEN 'UNRECONCILED' ELSE COALESCE(t.status, 'UNRECONCILED') END
FROM transaction_splits ts
JOIN transactions t ON t.id = ts.transaction_id
WHERE it.transaction_split_id = ts.id
  AND it.status IS NULL;

UPDATE investment_transactions
SET status = 'UNRECONCILED'
WHERE status IS NULL;

ALTER TABLE investment_transactions
  ALTER COLUMN status SET DEFAULT 'UNRECONCILED';

ALTER TABLE investment_transactions
  ALTER COLUMN status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_investment_transactions_status
  ON investment_transactions(status);
