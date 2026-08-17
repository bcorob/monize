-- 158: Microsoft Money's full investment activity vocabulary (issue #1149)
--
-- Money distinguishes reinvested interest, short- versus long-term capital
-- gain distributions (paid to cash and reinvested), and CD/bond redemption.
-- Collapsing those onto the existing actions at import time lost the income
-- kind -- short- and long-term gains are taxed differently, and reinvested
-- interest is interest -- so the enum now carries the distinctions and the
-- importers preserve them.
--
-- Each new value is a refinement of a base action and moves shares and cash
-- exactly as the base does (REINVEST_* like REINVEST, CAPITAL_GAIN_* like
-- CAPITAL_GAIN, REDEEM like SELL); `baseInvestmentAction` in
-- backend/src/securities/investment-replay.util.ts is the single place that
-- mapping lives.
--
-- ADD VALUE IF NOT EXISTS is idempotent, and the values are not used within
-- this migration, so running inside the migration runner's transaction is
-- safe on PostgreSQL 16.

ALTER TYPE investment_action ADD VALUE IF NOT EXISTS 'REINVEST_INTEREST';
ALTER TYPE investment_action ADD VALUE IF NOT EXISTS 'REINVEST_CAPITAL_GAIN_SHORT';
ALTER TYPE investment_action ADD VALUE IF NOT EXISTS 'REINVEST_CAPITAL_GAIN_LONG';
ALTER TYPE investment_action ADD VALUE IF NOT EXISTS 'CAPITAL_GAIN_SHORT';
ALTER TYPE investment_action ADD VALUE IF NOT EXISTS 'CAPITAL_GAIN_LONG';
ALTER TYPE investment_action ADD VALUE IF NOT EXISTS 'REDEEM';
