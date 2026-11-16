-- Widen the quote-provider CHECK constraints for the LSE and Deutsche Börse
-- providers.
--
-- Adds 'lse' (London Stock Exchange, historical prices via the financial.com
-- chart widget) and 'deutsche_boerse' (Börse Frankfurt, historical prices over
-- the market-data websocket) to the allowed set on both the per-security
-- override (securities.quote_provider) and the per-user default
-- (user_preferences.default_quote_provider). Widen-only: existing 'yahoo'/'msn'
-- rows stay valid. VARCHAR(20) already fits the longest new value.

ALTER TABLE securities
  DROP CONSTRAINT IF EXISTS securities_quote_provider_check;
ALTER TABLE securities
  ADD CONSTRAINT securities_quote_provider_check
  CHECK (
    quote_provider IS NULL
    OR quote_provider IN ('yahoo', 'msn', 'lse', 'deutsche_boerse')
  );

ALTER TABLE user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_default_quote_provider_check;
ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_default_quote_provider_check
  CHECK (
    default_quote_provider IN ('yahoo', 'msn', 'lse', 'deutsche_boerse')
  );
