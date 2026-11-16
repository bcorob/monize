-- A caller-supplied key for a transaction created through the API (issue #1713).
-- A client that loses the response to a create retries with the same key and
-- gets the row it already made instead of a second one. Unique per account, as
-- bank sync's bank_sync_imported_transactions(account_id, external_key) is:
-- the partial unique index is the guarantee, the service's lookup before the
-- insert only produces the friendlier answer. Nullable with no default: every
-- existing row, and every row the app creates for itself, carries none. The
-- index covers only the rows that carry a key, so it starts out empty.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_account_external_id
  ON transactions(account_id, external_id)
  WHERE external_id IS NOT NULL;
