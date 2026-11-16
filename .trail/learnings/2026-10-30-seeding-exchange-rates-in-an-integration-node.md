---
title: Seeding exchange_rates in an integration spec needs the currencies rows first
author: Node
date: 2026-10-30
branch: claude/issue-1937
cost: { minutes: 17, tokens: 98105 }
touches:
  - backend/src/transactions/transaction-conversion.service.spec.ts
  - backend/src/transactions/transaction-conversion.service.ts
  - backend/src/transactions/transactions.service.ts
  - backend/test/integration/transaction-conversion.integration.spec.ts
  - docs/backend/transactions-and-money.md
  - docs/specs/transaction-transfer-conversion.md
  - frontend/src/components/transactions/TransactionForm.test.tsx
  - frontend/src/components/transactions/TransactionForm.tsx
  - frontend/src/lib/action-history-format.test.ts
  - frontend/src/lib/action-history-format.ts
---

## Decided
- The synchronize-built test schema has `exchange_rates.from_currency/to_currency` foreign keys to `currencies`, and seeds no currencies. An integration spec that inserts a rate inserts the two currency rows first (`INSERT INTO currencies ... ON CONFLICT (code) DO NOTHING`), in the canonical orientation `from_currency < to_currency`, and lists `exchange_rates` in its `cleanTables`.
- A conversion between a transaction and a transfer (issue #1937 review): the detached leg's `exchangeRate` goes back to 1, a moved row drops its `externalId`, a body without `status` keeps the locked row's, and the nested `TransactionsService.update` collects its recomputes through `deferDerivedRecompute` so the caller dispatches them after its own commit.

## Tried and ruled out
- Inserting only the rate: fails with `violates foreign key constraint` on every test of the block, which reads like a broken fixture rather than the missing parent rows.

## Watch out
- `KNOWN_DESCRIPTION_KEYS` in `frontend/src/lib/action-history-format.ts` gates which history `descriptionKey`s render translated; a new backend key without an entry there silently shows the stored English description, and the size pin in its test moves with it.
