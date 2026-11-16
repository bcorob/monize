-- skip_price_updates becomes the user's own "disable price updates" switch:
-- refresh now honours the flag alone, where a provider override or MSN
-- Instrument ID used to override it. A row that still carries both was being
-- refreshed, so the flag is cleared on it to keep it refreshing.
-- Idempotent: a second pass matches no row.
UPDATE securities
   SET skip_price_updates = false
 WHERE skip_price_updates = true
   AND (quote_provider IS NOT NULL OR msn_instrument_id IS NOT NULL);
