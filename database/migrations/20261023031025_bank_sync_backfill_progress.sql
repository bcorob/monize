-- Retain committed historical batches without advancing the successful-sync watermark.
ALTER TABLE bank_sync_accounts ADD COLUMN IF NOT EXISTS backfill_through DATE;
