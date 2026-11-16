-- Country-agnostic reference tables for sovereign bonds (docs/specs/polish-retail-bonds.md
-- sections 3 and 7; Polish retail bonds are the first instruments, not the schema).
--
-- A bond instrument's terms, a published period rate, an NBP reference rate or a
-- CPI print has no owner: one published series serves every account and every
-- country's instrument, exactly as an exchange rate or a market index close does.
-- These six tables are global reference data with no owner column, RLS-exempt
-- rather than policied (see the exemption block at the foot of database/schema.sql
-- and docs/row-level-security-contract.md). No rows are seeded here.
--
--   bond_programs          one row per program (the product, e.g. EDO), keyed (issuer country, issuer, program); insert only
--                          (docs/specs/bond-program-securities.md section 2.1)
--   bond_instruments       one row per series, keyed (issuer country, issuer, series); insert only
--   bond_terms_versions    the instrument terms as published, versioned, with a content hash; immutable
--   bond_period_rates      the rate of each interest period; immutable
--   benchmark_series       a reference series (STEP: effective-from dates; MONTHLY: reference months)
--   benchmark_values       the observations of a benchmark series; a correction is an update
--
-- INV-BOND-001: a terms version and a period rate, once written, are never
-- changed or removed -- a holding valued today must be reproducible tomorrow.
-- bond_reject_mutation() enforces it in the database as a row-level BEFORE
-- UPDATE OR DELETE trigger, so no code path (the refresh, a restore, a manual
-- UPDATE or DELETE) can rewrite history. A row-level trigger does not fire for
-- TRUNCATE, so TRUNCATE is NOT covered: it is an operator action, and the
-- integration suites reset every table with TRUNCATE ... CASCADE, which a
-- statement-level guard would break. ON DELETE RESTRICT on the foreign keys
-- keeps an instrument or a series from being deleted from under its dependants.
--
-- Rates are NUMERIC(20,10): an exchange-rate-like quantity, not money.

CREATE TABLE IF NOT EXISTS bond_programs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issuer_country_code CHAR(2) NOT NULL,
    issuer_code         VARCHAR(40) NOT NULL,
    program_code        VARCHAR(40) NOT NULL,
    currency_code       VARCHAR(3) NOT NULL REFERENCES currencies(code),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issuer_country_code, issuer_code, program_code)
);

CREATE TABLE IF NOT EXISTS bond_instruments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issuer_country_code CHAR(2) NOT NULL,
    issuer_code         VARCHAR(40) NOT NULL,
    program_code        VARCHAR(40) NOT NULL,
    bond_program_id     UUID NOT NULL REFERENCES bond_programs(id) ON DELETE RESTRICT,
    series_code         VARCHAR(40) NOT NULL,
    currency_code       VARCHAR(3) NOT NULL REFERENCES currencies(code),
    marketability       VARCHAR(30) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (issuer_country_code, issuer_code, series_code)
);

CREATE TABLE IF NOT EXISTS bond_terms_versions (
    bond_instrument_id UUID NOT NULL REFERENCES bond_instruments(id) ON DELETE RESTRICT,
    version            INTEGER NOT NULL CHECK (version >= 1),
    terms              JSONB NOT NULL,
    content_hash       VARCHAR(64) NOT NULL,
    source_url         TEXT NOT NULL,
    published_at       DATE,
    retrieved_at       TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bond_instrument_id, version)
);

CREATE TABLE IF NOT EXISTS bond_period_rates (
    bond_instrument_id UUID NOT NULL REFERENCES bond_instruments(id) ON DELETE RESTRICT,
    period_number      INTEGER NOT NULL CHECK (period_number >= 1),
    annual_rate        NUMERIC(20, 10) NOT NULL,
    source_url         TEXT NOT NULL,
    retrieved_at       TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bond_instrument_id, period_number)
);

CREATE TABLE IF NOT EXISTS benchmark_series (
    code            VARCHAR(40) PRIMARY KEY,
    kind            VARCHAR(10) NOT NULL CHECK (kind IN ('STEP', 'MONTHLY')),
    publisher       VARCHAR(40) NOT NULL,
    source_url      TEXT NOT NULL,
    unit            VARCHAR(20) NOT NULL,
    covered_through DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS benchmark_values (
    benchmark_code   VARCHAR(40) NOT NULL REFERENCES benchmark_series(code) ON DELETE RESTRICT,
    observation_date DATE NOT NULL,
    value            NUMERIC(20, 10) NOT NULL,
    published_on     DATE,
    source_url       TEXT NOT NULL,
    retrieved_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (benchmark_code, observation_date)
);

CREATE OR REPLACE FUNCTION bond_reject_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
      '% rows are immutable once written (INV-BOND-001); % is refused. Publish a new version instead.',
      TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS trg_bond_terms_versions_immutable ON bond_terms_versions;
CREATE TRIGGER trg_bond_terms_versions_immutable
    BEFORE UPDATE OR DELETE ON bond_terms_versions
    FOR EACH ROW EXECUTE FUNCTION bond_reject_mutation();

DROP TRIGGER IF EXISTS trg_bond_period_rates_immutable ON bond_period_rates;
CREATE TRIGGER trg_bond_period_rates_immutable
    BEFORE UPDATE OR DELETE ON bond_period_rates
    FOR EACH ROW EXECUTE FUNCTION bond_reject_mutation();

COMMENT ON TABLE bond_programs IS
  'Sovereign bond programs (the product a person holds, e.g. EDO), any issuer country. Global reference data with no owner column; insert only.';
COMMENT ON TABLE bond_instruments IS
  'Sovereign bond series, any issuer country. Global reference data with no owner column; insert only.';
COMMENT ON TABLE bond_terms_versions IS
  'Published instrument terms, versioned per instrument. Immutable (INV-BOND-001).';
COMMENT ON TABLE bond_period_rates IS
  'Rate per interest period of an instrument. Immutable (INV-BOND-001).';
COMMENT ON TABLE benchmark_series IS
  'Reference series (policy rates, CPI) that floating or indexed bonds read. Global; covered_through only moves forward.';
COMMENT ON TABLE benchmark_values IS
  'Observations of a benchmark series. Global; a correction is an update.';
