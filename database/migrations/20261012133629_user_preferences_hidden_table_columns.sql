-- Per-table hidden-column preference, keyed by table kind (transactions,
-- investmentHoldings, investmentRegister). Stored as JSONB so each table kind
-- can persist its own set of hidden column ids. Cross-device by virtue of
-- living on user_preferences. Empty object = no columns hidden anywhere.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS hidden_table_columns JSONB NOT NULL DEFAULT '{}';
