-- Delegate READ section `warranties` (docs/specs/warranty-tracker.md,
-- decision 9 and section 6.4): the sixth app section an owner can share with
-- a delegate, beside the five of 071_account_delegate_sections.sql. It gates
-- the warranty read routes, a warranty's documents and its claims; every
-- warranty write stays owner-only in application code. The linked purchase
-- is additionally narrowed to the delegate's READ-granted accounts (WTY-007),
-- which no column here can express.
--
-- Defaults to false, so nothing changes for an existing delegation until the
-- owner grants it. Expand only; idempotent: safe to run multiple times.

ALTER TABLE account_delegates
    ADD COLUMN IF NOT EXISTS warranties_can_read BOOLEAN NOT NULL DEFAULT false;

-- Backfill: `DelegationService.grantsWholeLedger` requires every section, so
-- without this a delegate who could reach the AI assistant yesterday (every
-- section and a READ grant on every account the owner owns, closed ones
-- included, on an active delegation) would lose it on deploy until the owner
-- visits the modal. A delegation that already grants the whole ledger keeps
-- its whole-ledger standing; a partial delegation gains nothing. The WHERE
-- mirrors exactly the condition the service evaluated before this column
-- existed (the five sections plus the per-account READ grants; the manage
-- capabilities play no part in it). Idempotent: the final predicate makes a
-- second run match no row.
UPDATE account_delegates d
   SET warranties_can_read = true
 WHERE d.status = 'active'
   AND d.bills_can_read
   AND d.investments_can_read
   AND d.budgets_can_read
   AND d.reports_can_read
   AND d.ai_can_read
   AND NOT d.warranties_can_read
   AND NOT EXISTS (
         SELECT 1
           FROM accounts a
          WHERE a.user_id = d.owner_user_id
            AND NOT EXISTS (
                  SELECT 1
                    FROM account_delegate_grants g
                   WHERE g.delegation_id = d.id
                     AND g.account_id = a.id
                     AND g.can_read
                )
       );
