---
title: "transactions.external_id: origin and purpose"
author: Ken
date: 2026-10-20
branch: main
touches:
  - backend/src/transactions/transaction-external-id.ts
---

## Decided
- transactions.external_id added 2026-10-12 (commit d6fb45965, issue #1713, migration 20261012145720_transactions_external_id.sql).
- Purpose: idempotency key for API-created transactions. Retry with same key returns existing row.
- Guarantee = partial unique index idx_transactions_account_external_id on (account_id, external_id) WHERE external_id IS NOT NULL. Pre-insert lookup is advisory only.
- Race handling: isExternalIdConflict() in backend/src/transactions/transaction-external-id.ts matches 23505 + index name, then re-reads winner.

## Tried and ruled out
- Nothing; answered from migration comment, helper file, entity, git log.

## Watch out
- Index declared in both migration and transaction.entity.ts (@Index) because DB-backed test suites build schema from entities. Change both together.
- NULL for all app-created / legacy rows; scoped per account, same shape as bank_sync_imported_transactions(account_id, external_key).
