---
title: SimpleFIN reservation deadlocked with discovery (FK key-share lock order)
author: Node
date: 2026-10-26
branch: claude/issue-1856
cost: { minutes: 8, tokens: 54651 }
touches:
  - backend/src/bank-sync/simplefin-request-budget.service.ts
  - backend/test/integration/simplefin-storage.integration.spec.ts
  - docs/concurrency-and-idempotency.md
  - docs/frontend/tables-and-registers.md
  - frontend/src/components/investments/GroupedHoldingsList.test.tsx
  - frontend/src/components/investments/GroupedHoldingsList.tsx
  - frontend/src/hooks/useColumnHeaderActions.test.tsx
  - frontend/src/hooks/useColumnHeaderActions.tsx
  - frontend/src/lib/holdings-sort.test.ts
  - frontend/src/lib/holdings-sort.ts
---

## Decided
- SimplefinRequestBudgetService.reserve takes `SELECT id FROM users WHERE id=$1 FOR KEY SHARE` before the credential FOR UPDATE, so every SimpleFIN writer locks user then credential (discovery and setup already did).
- Regression in simplefin-storage.integration.spec.ts: a raw pg Client holds users FOR UPDATE, a reservation starts, waitForLockWaiters(1), then the client locks the credential. It deadlocks without the fix.

## Tried and ruled out
- Treating the CI failure ("deadlock detected" in simplefin-discovery's concurrent case) as a flake: it is a real lock-order inversion.

## Watch out
- An INSERT/UPDATE of a foreign-key column takes FOR KEY SHARE on the referenced row, which conflicts with FOR UPDATE. A transaction that locks X and then inserts a row referencing users takes the users lock AFTER X, even though no statement names it.
