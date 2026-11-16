-- Link a security to a bond program, and a share-moving investment transaction
-- to the series it acts on (docs/specs/bond-program-securities.md sections 2.2
-- and 2.3; supersedes the one-security-per-series link of
-- docs/specs/polish-retail-bonds.md section 12.1, which never shipped). A
-- linked security is priced by the bond engine and never by a quote provider;
-- the link is refused unless the two currencies agree (INV-PRICE-001), which
-- the application checks in the write's own transaction.
--
-- bond_programs and bond_instruments are global reference data that a user
-- backup does not carry, so the restore keeps these columns only where the
-- program or the series exists on the target deployment and writes NULL
-- otherwise (backend/src/backup).
--
-- Expand only: nullable columns without a default and one flag with a constant
-- default, nothing reads them until the writer ships. ON DELETE RESTRICT keeps
-- a program or a series from being deleted from under a security or a
-- transaction that points at it. The partial indexes serve the daily fan-out
-- ("every linked security", "every program switched on") and the RESTRICT check.
ALTER TABLE securities
  ADD COLUMN IF NOT EXISTS bond_program_id UUID NULL;

ALTER TABLE securities
  ADD COLUMN IF NOT EXISTS bond_auto_fetch BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE securities
  DROP CONSTRAINT IF EXISTS fk_securities_bond_program;
ALTER TABLE securities
  ADD CONSTRAINT fk_securities_bond_program
  FOREIGN KEY (bond_program_id) REFERENCES bond_programs(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_securities_bond_program
  ON securities(bond_program_id)
  WHERE bond_program_id IS NOT NULL;

ALTER TABLE investment_transactions
  ADD COLUMN IF NOT EXISTS bond_instrument_id UUID NULL;

ALTER TABLE investment_transactions
  DROP CONSTRAINT IF EXISTS fk_investment_transactions_bond_instrument;
ALTER TABLE investment_transactions
  ADD CONSTRAINT fk_investment_transactions_bond_instrument
  FOREIGN KEY (bond_instrument_id) REFERENCES bond_instruments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_investment_transactions_bond_instrument
  ON investment_transactions(bond_instrument_id)
  WHERE bond_instrument_id IS NOT NULL;
