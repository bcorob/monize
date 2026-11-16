-- bond_instruments is insert only (INV-BOND-001): a security's link, the
-- instrument's id (derived from its series) and the currency check that prices
-- a lot all depend on a row never changing under them. Migration
-- 20261010170817_bond_reference_tables.sql guarded the terms and the announced
-- rates with bond_reject_mutation(), but the instrument rows themselves were
-- only insert-only by convention (the runtime role holds UPDATE and DELETE on
-- every table). The same trigger now refuses UPDATE and DELETE of an instrument and of a program (bond_programs,
-- the product a series belongs to; docs/specs/bond-program-securities.md 2.1).
-- TRUNCATE is not a row operation and stays available to test housekeeping.
-- Idempotent: the function is replaced by an identical body (so this file is
-- self-contained) and the trigger is dropped before it is created.
CREATE OR REPLACE FUNCTION bond_reject_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
      '% rows are immutable once written (INV-BOND-001); % is refused. Publish a new version instead.',
      TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS trg_bond_instruments_immutable ON bond_instruments;
CREATE TRIGGER trg_bond_instruments_immutable
    BEFORE UPDATE OR DELETE ON bond_instruments
    FOR EACH ROW EXECUTE FUNCTION bond_reject_mutation();

DROP TRIGGER IF EXISTS trg_bond_programs_immutable ON bond_programs;
CREATE TRIGGER trg_bond_programs_immutable
    BEFORE UPDATE OR DELETE ON bond_programs
    FOR EACH ROW EXECUTE FUNCTION bond_reject_mutation();
