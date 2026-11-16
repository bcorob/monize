-- Payroll deduction rules (docs/specs/payroll-deductions.md): a yearly
-- maximum per deduction category on one payroll scheduled bill, read when an
-- occurrence posts and when the cash-flow forecast is drawn. A rule never
-- changes a posted transaction (INV-PAYROLL-001).
--
-- Expand only; idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS payroll_deduction_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scheduled_transaction_id UUID NOT NULL REFERENCES scheduled_transactions(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    -- The most the category collects in one period, as a magnitude in the
    -- bill's account currency.
    yearly_maximum NUMERIC(20,4) NOT NULL CHECK (yearly_maximum >= 0),
    reset_period VARCHAR(20) NOT NULL DEFAULT 'YEARLY' CHECK (reset_period IN ('YEARLY')),
    -- The anchor: a period runs from one anniversary of this day to the day
    -- before the next.
    reset_date DATE NOT NULL,
    -- Read only when the bill carries no split line for the category; the
    -- line's own magnitude is the expected amount otherwise.
    expected_per_paycheque NUMERIC(20,4) CHECK (expected_per_paycheque IS NULL OR expected_per_paycheque >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_payroll_deduction_rule_line UNIQUE (scheduled_transaction_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_deduction_rules_user
    ON payroll_deduction_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_payroll_deduction_rules_scheduled
    ON payroll_deduction_rules(scheduled_transaction_id);
CREATE INDEX IF NOT EXISTS idx_payroll_deduction_rules_category
    ON payroll_deduction_rules(category_id);

DROP TRIGGER IF EXISTS update_payroll_deduction_rules_updated_at ON payroll_deduction_rules;
CREATE TRIGGER update_payroll_deduction_rules_updated_at
  BEFORE UPDATE ON payroll_deduction_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE payroll_deduction_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_deduction_rules_isolation ON payroll_deduction_rules;
CREATE POLICY payroll_deduction_rules_isolation ON payroll_deduction_rules
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
