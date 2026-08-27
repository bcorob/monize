-- A loan or mortgage schedule's end_date bounded one payment too many.
--
-- `paymentStartDate` is payment number 1, so a schedule of N payments advances
-- N - 1 intervals -- but calculateEndDate and calculateMortgageEndDate advanced
-- N. `postOccurrence` deactivates only when the new next_due_date is strictly
-- greater than end_date, so the schedule reached occurrence N + 1: one extra
-- installment against a loan the amortization already reports as repaid. The
-- code fix stops new ones; this heals the bounds already written.
--
-- The correction is always "one interval earlier", because both formulas step
-- the same cadence from the same anchor. What is not always invertible is the
-- STEP, so this heals only the rows where subtracting an interval provably
-- reproduces what the current code would write:
--
--   * WEEKLY / BIWEEKLY -- fixed day counts, no clamping anywhere, so the
--     inverse is exact. Guarded on the gap being a whole number of intervals.
--   * MONTHLY / QUARTERLY / YEARLY on a day of month <= 28 -- a day no month is
--     too short to hold, so neither the old stepper (Date.setMonth, which
--     OVERFLOWS) nor the new one (addMonthsClamped) ever adjusted the day, and
--     subtracting the interval lands exactly where the new code would.
--
-- Deliberately NOT healed, because the old value cannot be inverted rather than
-- because the rows are fine:
--
--   * A month cadence anchored on the 29th, 30th or 31st. The old stepper
--     overflowed (31 January to 3 March) and then carried the new day forward,
--     so the stored date is not "the anchor plus N months" in any calendar and
--     PostgreSQL's own clamping INTERVAL arithmetic would not undo it.
--   * SEMIMONTHLY. The old mortgage stepper used the 1st and the 15th while the
--     recurrence engine uses the 15th and the last day of the month, so those
--     end dates sit on a different calendar entirely -- subtracting anything
--     from them would be arithmetic on a value that was never right.
--
-- Both remaining cases are recorded in docs/system-invariants.md under
-- INV-LOAN-005. Correcting them needs the recurrence engine, which SQL does not
-- have; the safe repair is to re-run the payment setup for those accounts.
--
-- This body is NOT re-runnable, and that is the one place this file departs
-- from the rest of the directory. The healed value is still a whole number of
-- intervals from start_date -- the only signature a machine-written bound has --
-- so the WHERE cannot exclude its own result, and a second pass would step the
-- bound back again and retire the schedule one payment EARLY. The mechanism
-- that makes it run once is schema_migrations: db-migrate reads the applied
-- filenames before each pass and executes only the ones missing. It is
-- registered in NON_RERUNNABLE_DATA_MIGRATIONS (backend/scripts/migration-lint.mjs)
-- so the lint's summary line stops claiming a property this file does not have.
-- Do not replay it by hand against a populated database.
--
-- Scope, narrowest first:
--   * the schedule is the one a LOAN or MORTGAGE account NAMES as its payment
--     schedule (accounts.scheduled_transaction_id), which is written by exactly
--     the two paths that write this end_date and by nothing else. Matching on
--     "a transfer split points at a debt account" instead would have caught a
--     user's own extra-principal transfer to their mortgage: an ordinary
--     "monthly, for ten years" bound is a whole number of intervals from its
--     start date too, so the interval test below cannot tell it apart, and this
--     body is not re-runnable. LoanPaymentSetupService sets the same link but
--     writes no end_date, so those rows fall out on end_date IS NOT NULL;
--   * it is still active, so its bound can still change what posts;
--   * its end_date is still in the future, so nothing already posted is being
--     rewritten -- an extra installment that has already happened is a
--     transaction to reverse, not a bound to move;
--   * the gap between start_date and end_date is a whole positive number of the
--     schedule's own intervals -- what a machine-written bound looks like;
--   * the schedule has not yet advanced past the healed bound, so the repair
--     cannot itself retire a live schedule.
--
-- One residual risk, stated rather than argued away: a borrower who noticed the
-- extra installment and corrected the end date BY HAND has written the same
-- value the heal produces, and nothing distinguishes the two -- a monthly
-- cadence's every anchor-day date is a whole number of intervals from its start.
-- Such a schedule is moved one period further back and retires a payment early.
-- The population is small (it needs the defect to have been noticed and fixed on
-- the debt account's own payment schedule) and the error is one payment in the
-- opposite direction, against leaving every uncorrected bound one payment long.
-- The next_due_date guard keeps that error from ever being immediate.
--
-- Exercised against PostgreSQL 16 over a fixture covering both directions: the
-- five healed cadences (including an accelerated mortgage's biweekly bound on
-- day 28) each moved back exactly one interval, and every excluded row was left
-- untouched -- the 29th/30th/31st anchors, SEMIMONTHLY, an inactive schedule, a
-- bound already in the past, a schedule no debt account names (including a
-- user's own extra-principal transfer whose split points at the mortgage), one
-- whose end date is not a whole number of intervals from its start, one with no
-- end date, and a single-payment schedule.
UPDATE scheduled_transactions AS st
SET end_date = CASE st.frequency
        WHEN 'WEEKLY' THEN st.end_date - INTERVAL '7 days'
        WHEN 'BIWEEKLY' THEN st.end_date - INTERVAL '14 days'
        WHEN 'MONTHLY' THEN st.end_date - INTERVAL '1 month'
        WHEN 'QUARTERLY' THEN st.end_date - INTERVAL '3 months'
        WHEN 'YEARLY' THEN st.end_date - INTERVAL '1 year'
        -- Unreachable: the WHERE admits only the five above. Present because a
        -- CASE with no ELSE yields NULL, and NULL here would not be a wrong
        -- bound, it would be NO bound -- a schedule that never retires.
        ELSE st.end_date
    END
WHERE st.is_active
  AND st.end_date IS NOT NULL
  AND st.end_date > CURRENT_DATE
  AND st.end_date > st.start_date
  -- The healed bound must still be ahead of where the schedule has got to, so
  -- the repair can shorten a schedule but never retire one outright.
  AND st.next_due_date <= st.end_date - CASE st.frequency
        WHEN 'WEEKLY' THEN INTERVAL '7 days'
        WHEN 'BIWEEKLY' THEN INTERVAL '14 days'
        WHEN 'MONTHLY' THEN INTERVAL '1 month'
        WHEN 'QUARTERLY' THEN INTERVAL '3 months'
        WHEN 'YEARLY' THEN INTERVAL '1 year'
        ELSE INTERVAL '0'
      END
  AND EXISTS (
      SELECT 1
      FROM accounts a
      WHERE a.scheduled_transaction_id = st.id
        AND a.account_type IN ('LOAN', 'MORTGAGE')
  )
  AND (
      (st.frequency = 'WEEKLY' AND (st.end_date - st.start_date) % 7 = 0)
   OR (st.frequency = 'BIWEEKLY' AND (st.end_date - st.start_date) % 14 = 0)
   OR (
        st.frequency IN ('MONTHLY', 'QUARTERLY', 'YEARLY')
        AND EXTRACT(DAY FROM st.start_date) <= 28
        AND EXTRACT(DAY FROM st.end_date) = EXTRACT(DAY FROM st.start_date)
        AND (
            (
                (EXTRACT(YEAR FROM st.end_date) - EXTRACT(YEAR FROM st.start_date)) * 12
              + (EXTRACT(MONTH FROM st.end_date) - EXTRACT(MONTH FROM st.start_date))
            ) % CASE st.frequency
                    WHEN 'MONTHLY' THEN 1
                    WHEN 'QUARTERLY' THEN 3
                    ELSE 12
                END
        ) = 0
      )
  );
