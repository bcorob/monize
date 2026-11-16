-- 188: Google Places as a payee contact lookup source
--
-- The payee contact lookup (website, address, email, phone) has answered
-- through the user's AI provider since migration 173. Google Places answers the
-- same question from a business directory rather than a language model, so a
-- deployment or a user who configures it gets deterministic addresses and
-- phone numbers, and pays Google per request instead of paying an LLM per
-- token. It has no email, which is why the AI adapter stays.
--
-- Three tables, because the key has two possible owners and each owner's
-- spending has to be counted separately:
--
-- 1. payee_lookup_settings -- one row per user, holding THEIR key and cap.
--    Written only when a user configures Places for themselves; an absent row
--    means "not configured", so nothing is seeded for existing users.
--
-- 2. payee_lookup_usage -- (user, month) request counter for a user's own key.
--
-- 3. google_places_instance_usage -- (month) counter for the OPERATOR's key
--    (GOOGLE_PLACES_API_KEY). Deployment-wide with no owner column, exactly
--    like provider_health: one operator key is one bill, whoever's lookup
--    spent it. RLS-exempt for that reason; see docs/row-level-security-contract.md.
--
-- The cap defaults to 1000, not to a round number: a Text Search whose field
-- mask asks for websiteUri or internationalPhoneNumber is billed at Google's
-- Text Search Enterprise SKU, whose free allowance is 1,000 requests per
-- calendar month. (The 10,000 figure belongs to the Essentials SKU, which
-- cannot return a website or a phone number and so cannot answer this lookup.)
-- cap_enabled is a separate column from monthly_cap so switching the cap off
-- and on again does not lose the number the user chose.
--
-- The month is a 'YYYY-MM' string computed by PostgreSQL inside the claim
-- statement, so every replica rolls over on one clock -- and it is computed in
-- America/Los_Angeles, not UTC, because Google's free monthly allowance resets
-- on the first of the month at midnight Pacific. Rolling over at UTC midnight
-- would release the user's cap seven or eight hours before Google releases the
-- allowance it rations, and every request in that window is billed.
--
-- api_key_enc is ciphertext under ENCRYPTION_KEY and is named to match
-- ai_provider_configs.api_key_enc, because the backup's key transport
-- (backend/src/backup/ai-provider-key-transport.ts) is keyed on that column
-- name: the key is decrypted on export and re-encrypted on import, or it
-- restores onto another instance populated and unreadable.
--
-- Both user-owned tables ship their policy AND their ENABLE here: migration
-- 123_rls_enable.sql derived its targets from pg_policies at the moment it ran
-- and never runs again on a deployed database.

CREATE TABLE IF NOT EXISTS payee_lookup_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Encrypted Google Places API key. NULL means this user has configured no
    -- key of their own; the operator's key (if any) still applies.
    api_key_enc TEXT,
    -- The on/off the user sees in both modes. True by default so configuring a
    -- key is the only step needed to start using it.
    google_places_enabled BOOLEAN NOT NULL DEFAULT true,
    cap_enabled BOOLEAN NOT NULL DEFAULT true,
    monthly_cap INTEGER NOT NULL DEFAULT 1000,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payee_lookup_settings_monthly_cap_check
        CHECK (monthly_cap BETWEEN 1 AND 1000000)
);

DROP TRIGGER IF EXISTS update_payee_lookup_settings_updated_at ON payee_lookup_settings;
CREATE TRIGGER update_payee_lookup_settings_updated_at
    BEFORE UPDATE ON payee_lookup_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP POLICY IF EXISTS payee_lookup_settings_isolation ON payee_lookup_settings;
CREATE POLICY payee_lookup_settings_isolation ON payee_lookup_settings
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE payee_lookup_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS payee_lookup_usage (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Pacific calendar month, 'YYYY-MM' -- Google's billing month. Written by
    -- to_char(now() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM') inside the
    -- claim, so the boundary is the database's and is the same instant the
    -- allowance being rationed resets on.
    month CHAR(7) NOT NULL,
    google_places_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
);

DROP POLICY IF EXISTS payee_lookup_usage_isolation ON payee_lookup_usage;
CREATE POLICY payee_lookup_usage_isolation ON payee_lookup_usage
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE payee_lookup_usage ENABLE ROW LEVEL SECURITY;

-- Deliberately no user_id and no policy: this counts the OPERATOR's key, which
-- has no owner. See the rls-exempt block at the foot of database/schema.sql.
CREATE TABLE IF NOT EXISTS google_places_instance_usage (
    month CHAR(7) PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0
);
