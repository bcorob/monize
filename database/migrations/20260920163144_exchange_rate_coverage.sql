-- What a rate provider is known to hold for one currency pair, and where the
-- next history fill should resume.
--
-- `ExchangeRateHistoryService` re-derived both facts on every press and could
-- keep neither. A pair whose provider history starts long after the reader's
-- own data does (Yahoo carries nothing for `USDCAD=X` before December 2003,
-- against a ledger opening in 1996) paid one provider call per dead year to
-- learn that again after every restart, and a stretch the provider has already
-- given its best for was re-asked for on the press after next.
--
-- One row per pair, in the canonical orientation only (`from_currency <
-- to_currency`, INV-FX-003): a rate window answers a pair, not a direction, so
-- two rows per pair is the same divergence `exchange_rates` was collapsed to
-- avoid. The CHECK is what holds it rather than a convention in the writer.
--
-- The table is global reference data like `exchange_rates` itself: what a
-- provider carries is the same fact for every user on the deployment, so it
-- has no owner column and is RLS-exempt (docs/row-level-security-contract.md).
--
-- Supersedes the withdrawn `currencies.provider_missing_through/_against`
-- columns, which put a fact about a PAIR on one of its two currencies and so
-- could hold only one pair per currency. The drops below are for a database
-- that applied that migration before it was withdrawn; on a fresh install they
-- are no-ops.
ALTER TABLE currencies DROP COLUMN IF EXISTS provider_missing_through;
ALTER TABLE currencies DROP COLUMN IF EXISTS provider_missing_against;

CREATE TABLE IF NOT EXISTS exchange_rate_coverage (
    id BIGSERIAL PRIMARY KEY,
    from_currency VARCHAR(3) NOT NULL REFERENCES currencies(code),
    to_currency VARCHAR(3) NOT NULL REFERENCES currencies(code),
    -- The earliest date the provider is known to carry a rate for the pair.
    -- NULL while nothing has established one. Nothing before it is ever asked
    -- for again.
    earliest_available_date DATE,
    -- The date the next fill resumes from: the earliest date whose gap has not
    -- yet been put to the provider. NULL means the pair has never been probed.
    -- It only ever moves forward, so a stretch the provider has already
    -- answered as well as it can does not consume the next press's budget.
    first_gap_date DATE,
    -- The earliest date any fill has planned over for this pair, which is what
    -- makes the pointer above safe. A reader who imports older transactions
    -- moves their own first use of the currency back behind everything probed
    -- so far; without this the pointer would hide those years for good.
    probed_from DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_exchange_rate_coverage_pair UNIQUE (from_currency, to_currency),
    CONSTRAINT ck_exchange_rate_coverage_canonical CHECK (from_currency < to_currency)
);

-- The new table holds two more `currencies(code)` references, so the global
-- liveness gate has to consult it: without this branch, deleting a currency a
-- coverage row still names is reported as free and then aborts on the foreign
-- key. `CREATE OR REPLACE` is idempotent; the body below matches
-- `database/schema.sql`, and `currency-references.spec.ts` fails if the two
-- disagree with each other or with the schema's set of references.
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
    UNION ALL SELECT 1 FROM scheduled_transactions
      WHERE currency_code = p_code OR original_currency_code = p_code
    UNION ALL SELECT 1 FROM budgets WHERE currency_code = p_code
    UNION ALL SELECT 1 FROM user_preferences WHERE default_currency = p_code
  )
$$;
