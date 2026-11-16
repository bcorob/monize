-- A deleted user's custom currencies stop being offered to everybody.
--
-- currencies.created_by_user_id is ON DELETE SET NULL, and a row with no creator
-- is a system currency: until now a user's custom currency became an ACTIVE
-- system currency, listed to every user, that nobody could edit or delete. A
-- BEFORE UPDATE trigger now deactivates a currency the moment its creator is
-- cleared, from every deletion path (self-delete, admin delete, any direct
-- DELETE FROM users), because the foreign key's SET NULL fires it. Users who
-- activated the currency keep it through their own user_currency_preferences
-- row; a deleting application path removes the unreferenced ones afterwards.
--
-- Idempotent: the function is replaced by an identical body and the trigger is
-- dropped before it is created. Existing rows are not touched.
CREATE OR REPLACE FUNCTION currencies_creator_cleared_deactivate() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.is_active := false;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS currencies_creator_cleared_deactivate ON currencies;
CREATE TRIGGER currencies_creator_cleared_deactivate
    BEFORE UPDATE OF created_by_user_id ON currencies
    FOR EACH ROW
    WHEN (OLD.created_by_user_id IS NOT NULL AND NEW.created_by_user_id IS NULL)
    EXECUTE FUNCTION currencies_creator_cleared_deactivate();
