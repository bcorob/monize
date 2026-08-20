-- Issue #1214: a transfer created with a blank payee used to have
-- "Transfer to/from <account>" stamped into payee_name at creation time. The
-- stamp went stale when the counterpart account was renamed and could not
-- follow the reader's language. Blank transfer payees are now persisted blank
-- and every read surface resolves the label from the counterpart account's
-- CURRENT name (backend/src/transactions/transfer-payee-label.util.ts;
-- frontend usePayeeDisplay).
--
-- Retroactively blank the rows the old writers stamped. A stamped row is
-- recognised exactly: a transfer leg with no linked payee entity whose
-- payee_name equals 'Transfer to <counterpart>' or 'Transfer from
-- <counterpart>' against the counterpart account's current name -- so the
-- resolved display is byte-identical to what the row showed before. A
-- hand-typed payee, a stamp gone stale through a rename (indistinguishable
-- from one), or a leg whose counterpart was deleted (nothing to resolve from)
-- is deliberately left untouched; stale stamps are additionally healed at
-- edit time when the transfer's account moves
-- (transaction-transfer.service.ts).
--
-- Idempotent by construction: a blanked row no longer matches the WHERE
-- clause, so re-running the statement is a no-op.
UPDATE transactions t
SET payee_name = NULL
FROM transactions lt
JOIN accounts la ON la.id = lt.account_id
WHERE lt.id = t.linked_transaction_id
  AND t.is_transfer = true
  AND t.payee_id IS NULL
  AND t.payee_name IN ('Transfer to ' || la.name, 'Transfer from ' || la.name);
