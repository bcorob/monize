-- 189: which source answers a payee contact lookup first
--
-- Migration 188 made Google Places REPLACE the AI lookup wherever it was
-- configured, with AI reached again only when the monthly cap was spent. That
-- is the right default -- Places is cheaper per answer and returns facts from a
-- directory rather than a model's recollection -- but it is not the right
-- answer for everyone: Google holds no email address, so a user who mainly
-- wants email has their better source permanently behind their worse one.
--
-- So the order becomes a setting. 'google-places' keeps 188's behaviour and is
-- the default, including for every row that already exists; 'ai' asks the
-- user's AI provider first and falls through to Places.
--
-- Deliberately an ORDER, not a switch: the second source is still reached when
-- the first cannot answer for a configuration or budget reason (no AI provider
-- configured, or the Places cap spent). A source that FAILS -- a rejected key,
-- an open breaker -- still surfaces as a failure rather than being papered over
-- by silently paying the other one, which is the rule 188 established and this
-- migration does not change.
--
-- A CHECK rather than an enum type: two values that the application already
-- models as a union, and adding a third to a CHECK is one ALTER rather than an
-- ALTER TYPE that cannot run in a transaction alongside its own backfill.

ALTER TABLE payee_lookup_settings
    ADD COLUMN IF NOT EXISTS preferred_source VARCHAR(20) NOT NULL DEFAULT 'google-places';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'payee_lookup_settings_preferred_source_check'
    ) THEN
        ALTER TABLE payee_lookup_settings
            ADD CONSTRAINT payee_lookup_settings_preferred_source_check
            CHECK (preferred_source IN ('google-places', 'ai'));
    END IF;
END $$;
