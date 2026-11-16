-- 190: which AI provider answers a payee contact lookup
--
-- Migration 189 let the user order the two sources. This names WHICH AI, for
-- the user who has more than one provider configured: the assistant tries every
-- active provider in priority order and falls through on failure, which is the
-- right behaviour for a chat turn and the wrong one for a lookup the user is
-- paying per call for. A user with a cheap local Ollama beside an expensive
-- hosted model wants the lookup pinned to one of them, not "whichever answers".
--
-- NULL means "no preference", which is the existing behaviour and stays the
-- default: every active provider, in priority order. Nothing is backfilled.
--
-- ON DELETE SET NULL rather than CASCADE: deleting the provider must not delete
-- the user's whole payee-lookup configuration -- their Google Places key lives
-- in the same row. Clearing the pin returns them to "no preference", which is
-- the honest reading of "the provider you chose no longer exists".
--
-- A provider merely DEACTIVATED is the case the foreign key cannot reach: the
-- pin survives and resolves to nothing, and the lookup then reports
-- `no_provider` rather than silently spending a different provider's budget.
-- Falling through to another model would be the one outcome a pin exists to
-- prevent.

ALTER TABLE payee_lookup_settings
    ADD COLUMN IF NOT EXISTS ai_provider_config_id UUID
        REFERENCES ai_provider_configs(id) ON DELETE SET NULL;
