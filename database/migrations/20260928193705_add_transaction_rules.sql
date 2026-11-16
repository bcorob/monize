-- Transaction rules: per-user rules that add or remove tags and set the payee
-- or category of a transaction when it is created or imported, and
-- a trace table recording what each rule changed
-- (docs/future-plans/transaction-rules.md section 4, task D1).
--
-- Pure expand: two new tables, nothing existing is altered, so the previous
-- release keeps working against this schema during a rolling deploy.
--
-- transaction_rules
--   * position is the evaluation order, unique per user. The constraint is
--     DEFERRABLE INITIALLY DEFERRED so a reorder that rewrites several
--     positions in one transaction does not collide part-way through.
--   * condition / actions are validated by the application on write (bounds,
--     fields, operators, ownership of every id they name); the database holds
--     only the shape it can cheaply guarantee.
--   * revision is the compare-and-swap counter for updates.
--
-- transaction_rule_applications is the trace: one row per rule per transaction
-- it changed. It cascades from the rule and the transaction, and is trimmed by
-- a retention cron added with the manual-run task.
--
-- Defaults on triggers, source, condition, actions, changes and applied_at are
-- deliberate: the RLS enforcement spec's generic row seeder invents '{}' for an
-- array and a `t<n>` string for a text column with no default, which the
-- non-empty and enumerated CHECKs below would reject. The application always
-- writes these columns explicitly.
--
-- Both tables are user-owned: the ordinary direct policy, and the enable in
-- this file (database/CLAUDE.md, Row-level security rule 1).

CREATE TABLE IF NOT EXISTS transaction_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    position INTEGER NOT NULL,
    triggers TEXT[] NOT NULL DEFAULT ARRAY['create', 'import']::text[],
    condition JSONB NOT NULL DEFAULT '{}'::jsonb,
    actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    stop_processing BOOLEAN NOT NULL DEFAULT false,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_transaction_rules_name_length
      CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT ck_transaction_rules_position CHECK (position >= 0),
    CONSTRAINT ck_transaction_rules_revision CHECK (revision >= 1),
    CONSTRAINT ck_transaction_rules_triggers
      CHECK (cardinality(triggers) >= 1 AND triggers <@ ARRAY['create', 'import']::text[]),
    CONSTRAINT uq_transaction_rules_user_position
      UNIQUE (user_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_transaction_rules_user_position
    ON transaction_rules(user_id, position);

CREATE TABLE IF NOT EXISTS transaction_rule_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id UUID NOT NULL REFERENCES transaction_rules(id) ON DELETE CASCADE,
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    source VARCHAR(20) NOT NULL DEFAULT 'manual',
    changes JSONB NOT NULL DEFAULT '{}'::jsonb,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_transaction_rule_applications_source
      CHECK (source IN ('create', 'import', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_transaction_rule_applications_rule
    ON transaction_rule_applications(rule_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_transaction_rule_applications_transaction
    ON transaction_rule_applications(transaction_id);

-- The touch trigger every sibling table with an updated_at column has.
DROP TRIGGER IF EXISTS update_transaction_rules_updated_at ON transaction_rules;
CREATE TRIGGER update_transaction_rules_updated_at
  BEFORE UPDATE ON transaction_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE transaction_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_rule_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transaction_rules_isolation ON transaction_rules;
CREATE POLICY transaction_rules_isolation ON transaction_rules
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));

DROP POLICY IF EXISTS transaction_rule_applications_isolation ON transaction_rule_applications;
CREATE POLICY transaction_rule_applications_isolation ON transaction_rule_applications
    USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
    WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
