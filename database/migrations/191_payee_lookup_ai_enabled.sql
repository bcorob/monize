-- 191: an on/off switch for the AI half of the payee contact lookup
--
-- Google Places has had one since migration 188 (google_places_enabled). The AI
-- source had none: it answered whenever it was reachable, so a user who wanted
-- Places only had no way to say so short of deleting an AI provider they use
-- for the assistant. The two sources are now symmetric -- each row in the
-- settings list carries its own switch.
--
-- Default true, and nothing is backfilled: every existing row keeps the
-- behaviour it has today, where a configured AI provider can answer a lookup.
--
-- Disabled means the source is NOT REACHED AT ALL -- not first, and not as the
-- fallback when the Places cap is spent. A switch that still let the source
-- answer "sometimes" would be worse than no switch, because the one thing the
-- user asked for is that it stops costing them money.
--
-- With both switches off nothing can answer a lookup, which is a state the
-- settings screen renders rather than prevents: the automatic-lookup toggle
-- shows off and disabled, because an automatic lookup with no source is
-- exactly what it would do.

ALTER TABLE payee_lookup_settings
    ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true;
