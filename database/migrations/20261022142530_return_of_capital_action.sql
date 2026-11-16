-- Return of Capital investment action (issue #1800)
--
-- Microsoft Money's "Return of Capital" activity: a distribution that pays back
-- part of what the shares cost rather than paying income. Its cash arrives like
-- a dividend's, it moves no shares, and it reduces the position's cost basis;
-- only what exceeds the basis is a realized gain. `docs/specs/return-of-capital.md`
-- is the definition, and `applyReturnOfCapital` in
-- backend/src/securities/investment-replay.util.ts is the one place the basis
-- rule lives.
--
-- ADD VALUE IF NOT EXISTS is idempotent, and the value is not used within this
-- migration, so running inside the migration runner's transaction is safe on
-- PostgreSQL 16.

ALTER TYPE investment_action ADD VALUE IF NOT EXISTS 'RETURN_OF_CAPITAL';
