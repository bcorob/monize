-- Which map service an address link opens.
--
-- Payees carry a free-text address that renders as a link; until now the target
-- was guessed from the user agent alone (Apple Maps on iOS, a geo: hand-off on
-- Android, OpenStreetMap elsewhere). That guess is a good default and a poor
-- rule -- somebody on a desktop who lives in Google Maps had no way to say so.
--
-- 'device' is a real value rather than NULL because "let the platform decide"
-- is a choice the user can deliberately return to, not an absence of one: NULL
-- would make "never set" and "explicitly wants the platform default"
-- indistinguishable, and the column could then never be NOT NULL.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS default_map_provider VARCHAR(20) NOT NULL DEFAULT 'device';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'user_preferences_default_map_provider_check'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_default_map_provider_check
      CHECK (default_map_provider IN ('device','openstreetmap','google','apple','bing','waze'));
  END IF;
END $$;
