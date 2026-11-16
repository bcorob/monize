-- bond_programs.currency_code and bond_instruments.currency_code reference
-- currencies(code) (migration 20261010170817_bond_reference_tables.sql), so the global liveness gate has to
-- consult it: without this branch a custom currency (PLN on an install that
-- created it itself) that only a bond program or instrument still names is reported as
-- free, the currency delete or the backup restore's cleanup runs, and the
-- foreign key aborts the whole transaction. `CREATE OR REPLACE` is idempotent;
-- the body matches `database/schema.sql`, and `currency-references.spec.ts`
-- fails if the two disagree. The per-user functions stay as they are: the
-- table has no user_id.
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
    UNION ALL SELECT 1 FROM user_preferences WHERE default_currency = p_code
  )
$$;
