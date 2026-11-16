-- 173: Automatic payee contact lookup
--
-- Two things in one migration because they are one feature:
--
-- 1. user_preferences.payee_contact_lookup_enabled -- the opt-in. While it is
--    on, a payee created without any contact details is looked up through the
--    user's configured AI provider (with the provider's web search where it has
--    one): the New Payee form prefills its empty fields for review, and a
--    name-only create (transaction form, AI assistant, MCP) is enriched in the
--    background after the row commits. Default false: nothing about existing
--    users' data changes until they turn it on.
--
-- 2. payees.contact_lookup_at / contact_lookup_source -- provenance for a
--    write nobody typed. contact_lookup_at stamps an attempt that got an answer
--    (found something, or established there was nothing to find), so the
--    background path runs at most once per payee -- the enrichment UPDATE is
--    keyed on `contact_lookup_at IS NULL`. contact_lookup_source is set only
--    when at least one field was actually written by a lookup, which is what
--    the detail page's "looked up automatically" badge keys off. A failed
--    attempt (provider offline, no answer) stamps neither, so a later attempt
--    can still run.
--
-- TIMESTAMPTZ rather than the TIMESTAMP of the neighbouring logo_fetched_at:
-- a stamp compared against "now" by code in one zone and displayed in
-- another should carry its zone (same choice as migration 169).

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS payee_contact_lookup_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE payees ADD COLUMN IF NOT EXISTS contact_lookup_at TIMESTAMPTZ;
ALTER TABLE payees ADD COLUMN IF NOT EXISTS contact_lookup_source VARCHAR(32);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'payees_contact_lookup_source_check'
  ) THEN
    ALTER TABLE payees
      ADD CONSTRAINT payees_contact_lookup_source_check
      CHECK (contact_lookup_source IS NULL
             OR contact_lookup_source IN ('ai-web-search','ai-knowledge','ai-relay','google-places'));
  END IF;
END $$;
