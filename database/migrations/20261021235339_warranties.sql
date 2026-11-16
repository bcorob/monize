-- Warranty tracker tables (docs/specs/warranty-tracker.md sections 6.1
-- and 6.2): `warranties`, one purchased item with its expiry, vendor, serial
-- and model numbers and an informational purchase price; and `warranty_claims`,
-- the claims made against one warranty.
--
-- A warranty never moves money: nothing sums `purchase_price`, and the link to
-- a transaction is ON DELETE SET NULL, so deleting the purchase keeps the
-- warranty. Status (lifetime, active, expiring, expired) is derived from
-- `expires_on` and `is_lifetime` by the application and never stored.
--
-- Both tables are in the Direct RLS bucket (`user_id`, owner only), so each
-- ships the uniform policy and its own ENABLE here, and joins `direct_tables`
-- in database/schema.sql.
--
-- `warranties.currency_code` references currencies(code), so the global
-- liveness gate (`currency_code_in_use_globally`) and the per-user data list
-- (`currency_codes_referenced_by_user_data`, from which
-- `currency_codes_referenced_by_user` derives) are redefined below to consult
-- it. `CREATE OR REPLACE` is idempotent; the bodies match database/schema.sql,
-- and currency-references.spec.ts fails if the two disagree.
--
-- Expand only: two new tables nothing earlier reads, and two functions that
-- answer the same question over one more column.

CREATE TABLE IF NOT EXISTS warranties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    vendor_name VARCHAR(200),
    payee_id UUID REFERENCES payees(id) ON DELETE SET NULL,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    model_number VARCHAR(100),
    serial_numbers TEXT[] NOT NULL DEFAULT '{}',
    warranty_kind VARCHAR(20) NOT NULL DEFAULT 'manufacturer'
        CHECK (warranty_kind IN ('manufacturer', 'extended', 'store', 'other')),
    purchase_date DATE NOT NULL,
    expires_on DATE,
    is_lifetime BOOLEAN NOT NULL DEFAULT false,
    purchase_price NUMERIC(20,4) CHECK (purchase_price IS NULL OR purchase_price >= 0),
    currency_code VARCHAR(3) REFERENCES currencies(code),
    product_url VARCHAR(500),
    notes VARCHAR(2000),
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_warranty_expiry CHECK (is_lifetime OR expires_on IS NOT NULL),
    CONSTRAINT chk_warranty_expiry_after_purchase
        CHECK (expires_on IS NULL OR expires_on >= purchase_date),
    CONSTRAINT chk_warranty_price_currency
        CHECK ((purchase_price IS NULL) = (currency_code IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_warranties_user_status
    ON warranties(user_id, archived_at, expires_on);
CREATE INDEX IF NOT EXISTS idx_warranties_transaction ON warranties(transaction_id);
CREATE INDEX IF NOT EXISTS idx_warranties_payee ON warranties(payee_id);

CREATE TABLE IF NOT EXISTS warranty_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    warranty_id UUID NOT NULL REFERENCES warranties(id) ON DELETE CASCADE,
    claim_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'approved', 'denied', 'resolved')),
    description VARCHAR(2000),
    resolution VARCHAR(2000),
    resolved_on DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warranty_claims_warranty ON warranty_claims(warranty_id);

DROP TRIGGER IF EXISTS update_warranties_updated_at ON warranties;
CREATE TRIGGER update_warranties_updated_at
  BEFORE UPDATE ON warranties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_warranty_claims_updated_at ON warranty_claims;
CREATE TRIGGER update_warranty_claims_updated_at
  BEFORE UPDATE ON warranty_claims
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE warranties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS warranties_isolation ON warranties;
CREATE POLICY warranties_isolation ON warranties
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

ALTER TABLE warranty_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS warranty_claims_isolation ON warranty_claims;
CREATE POLICY warranty_claims_isolation ON warranty_claims
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

CREATE OR REPLACE FUNCTION currency_code_in_use_globally(p_code VARCHAR)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_currency_preferences WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM exchange_rates
      WHERE from_currency = p_code OR to_currency = p_code
    UNION ALL SELECT 1 FROM exchange_rate_coverage
      WHERE from_currency = p_code OR to_currency = p_code
    UNION ALL SELECT 1 FROM accounts WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM transactions
      WHERE currency_code = p_code OR original_currency_code = p_code
    UNION ALL SELECT 1 FROM securities WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM bond_programs WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM bond_instruments WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM scheduled_transactions
      WHERE currency_code = p_code OR original_currency_code = p_code
    UNION ALL SELECT 1 FROM budgets WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM warranties WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM user_preferences WHERE default_currency = p_code
  )
$$;

CREATE OR REPLACE FUNCTION currency_codes_referenced_by_user_data(p_user_id uuid)
RETURNS SETOF varchar
LANGUAGE sql
STABLE
AS $$
  SELECT code FROM (
    SELECT default_currency AS code FROM user_preferences WHERE user_id = p_user_id
    UNION SELECT currency_code FROM accounts WHERE user_id = p_user_id
    UNION SELECT currency_code FROM transactions WHERE user_id = p_user_id
    UNION SELECT original_currency_code FROM transactions WHERE user_id = p_user_id
    UNION SELECT currency_code FROM securities WHERE user_id = p_user_id
    UNION SELECT currency_code FROM scheduled_transactions WHERE user_id = p_user_id
    UNION SELECT original_currency_code FROM scheduled_transactions WHERE user_id = p_user_id
    UNION SELECT currency_code FROM budgets WHERE user_id = p_user_id
    UNION SELECT currency_code FROM warranties WHERE user_id = p_user_id
  ) referenced
  WHERE code IS NOT NULL
$$;
