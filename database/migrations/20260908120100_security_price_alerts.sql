-- Owner-scoped opt-in. Existing securities RLS and backup handling apply.
ALTER TABLE securities ADD COLUMN IF NOT EXISTS price_alert_percent DOUBLE PRECISION
  CHECK (price_alert_percent >= 0.1 AND price_alert_percent <= 1000);
