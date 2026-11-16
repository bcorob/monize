-- Retain the provider-reported balance instant independently of import time.
ALTER TABLE bank_sync_accounts ADD COLUMN IF NOT EXISTS bank_balance_at TIMESTAMPTZ;
