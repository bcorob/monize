# Transaction Trash: Agent Task List

> Companion to [`transaction-trash.md`](./transaction-trash.md) (the design). One task per session/PR, in dependency order. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note instead.
- **The governing invariants apply to every task:** the trash changes nothing a delete does for the user (TRASH-004), and a restore moves each account by exactly what the delete reversed (TRASH-002). A task that alters a delete's balance arithmetic, its locks or its cascades is off the plan -- except B2, which replaces the bulk path's hand-rolled reversal with `deletionBalanceEffect` and proves identical balances.
- **Every delete site is touched in one task** (B3), so the guard that holds TRASH-001 is green in that PR and never red on `main`.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `TZ=UTC npm run test:unit -- --coverage`; plus `npm run build && npm run test:integration` when a query, an entity or a migration changed; `npm run migration:lint` when a migration changed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:cov`, `npm run build`.
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q3, once, at acceptance.
  - The doc line each task names lands in the same PR.
- **Terminology:** "the design" = `transaction-trash.md`; section references point there. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships a table, a writer or endpoints that change nothing a user sees until the Trash page exists. |
| **neutral** | Rewrites a live code path (the delete sites gain an insert; the bulk path moves onto the shared helper). Designed behaviour-preserving; the delete suites' balance assertions are the gate. |
| **live** | Changes what a user sees on an existing surface (a line in a delete confirmation). |

B3 is the one task that touches live delete paths. It is neutral by design: the only addition is an insert inside the existing transaction, and the suite asserts balances before and after.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Discussion agreeing `transaction-trash.md`; label `approved-to-build`; T1-T3 answered in the design | -- | none | [ ] |
| B1 | Migration + `schema.sql`: `transaction_trash` with RLS, `user_preferences.trash_retention_days`; entity; backup classification; `runOwnedDataDeletes`; restore wipe; `TRASH_MAX_RETENTION_DAYS` env | S1 | inert | [ ] |
| B2 | `restorationBalanceEffect` in `deletion-balance.util.ts` with the inverse spec; `bulkDelete` moved onto `deletionBalanceEffect` (TRASH-004 regression) | S1 | neutral | [ ] |
| B3 | `TransactionTrashWriter` + the call at every delete site + `deletedVia` threading through `removeAny`, the controller, MCP and AI + `transaction-trash.guard.spec.ts` (TRASH-001) | B1 | neutral | [ ] |
| B4 | `TransactionTrashService`: list, detail (allowlisted rendering), purge one, empty; controller; DTOs | B1 | inert | [ ] |
| B5 | Restore (design 6.4): conditional claim, refusals, inserts, balances, holdings rebuild, action history, recalc; the rule-applier exemption | B2, B3, B4 | inert | [ ] |
| B6 | `TransactionTrashPurgeService` cron, `JobClaimType.TrashPurge`, `WITH_CONTEXT_ALLOWLIST`, `docs/cron-jobs.md` row, preferences DTO for retention | B1 | inert | [ ] |
| F1 | `transactionTrashApi`, types, `trash` namespace, Tools link, Trash page (list, filters, pagination, purge, empty, retention control) | B4, B6 | inert | [ ] |
| F2 | `TrashEntryDrawer` with Restore and the 409 messages; post-restore deep link | F1, B5 | inert | [ ] |
| F3 | Delete confirmations gain the retention line and the attachment warning | F1 | live | [ ] |
| Q1 | Integration suite `transaction-trash.integration.spec.ts`: TRASH-003 two-connection restore, RLS bucket, backup round-trip, holdings rebuild, reconciled lock | B5 | none | [ ] |
| Q2 | Playwright `tests/transaction-trash.spec.ts` | F2, F3 | none | [ ] |
| Q3 | Full-locale i18n pass (acceptance, final commit) | all above | none | [ ] |
| D1 | Wiki section under Transactions ("Trash"), README line, `docs/system-invariants.md` entries TRASH-001..007, `docs/financial-semantics.md` deletion section gains the inverse | Q1 | none | [ ] |
| P2 | Phase 2 spec: attachments survive the trash (design 12) | D1 | none | [ ] (separate proposal) |

---

## Task details

### S1 -- Proposal

Open a Discussion linking `transaction-trash.md` and issue #777, summarising decisions 1-14, the table, the restore order and the purge, and asking the maintainer to answer T1 (default retention), T2 (rules on restore) and T3 (AI restore surface). Record the answers as edits to the design before B1 starts.

### B1 -- Table, preference, env, backup classification

**Files:** `database/migrations/<UTC timestamp>_transaction_trash.sql` (new), `database/schema.sql`, `backend/src/transaction-trash/entities/transaction-trash.entity.ts` (new), `backend/src/users/entities/user-preference.entity.ts`, `backend/src/backup/export-table-queries.ts`, `backend/src/backup/restore-plan.ts`, `backend/src/backup/backup-format.ts`, `backend/src/backup/backup-restore-database.service.ts`, `backend/src/backup/support-backup/support-backup-rules.ts`, `backend/src/backup/support-backup/support-backup-sections.ts`, `frontend/src/lib/restore-labels.ts`, `backend/src/users/users.service.ts` (`runOwnedDataDeletes`), `.env.example`, the env table the backend documents numeric variables in (locate by `resolvePositiveInt`), `docs/backup-restore-contract.md` (one row).

- Design 6.1 DDL, the direct policy and enable in the same file, both indexes; the preference column with its CHECK.
- Acceptance: `migration:lint`, `verify-schema.sh`, `check-migration-prefixes.mjs`, `node scripts/check-env-docs.mjs`; the RLS bucket spec, the backup coverage guard and the support-backup golden test pass with the decisions recorded.

### B2 -- The inverse helper, and the bulk path onto the shared helper

**Files:** `backend/src/common/deletion-balance.util.ts` + `.spec.ts`, `backend/src/transactions/transaction-bulk-update.service.ts` + `.spec.ts`, `docs/financial-semantics.md` (the deletion paragraph gains one sentence naming the inverse).

- `restorationBalanceEffect(row)`; the spec asserts `restoration(row) + deletion(row) === 0` for every status and for past, today and future dates (truth table A).
- `bulkDelete` replaces `status !== VOID && !isTransactionInFuture` with `deletionBalanceEffect` and keeps its `needsRecalc` handling. Acceptance: the existing bulk-delete specs pass unchanged, plus a new case per status proving identical balances to the single-delete path (TRASH-004). If any existing balance assertion changes, stop: that is a finding to report, not to adjust.

### B3 -- The writer at every delete site

**Files:** `backend/src/transaction-trash/transaction-trash-writer.ts` + `.spec.ts`, `backend/src/transaction-trash/trash-snapshot.ts` + `.spec.ts`, `backend/src/transaction-trash/transaction-trash.guard.spec.ts`, `backend/src/transaction-trash/transaction-trash.module.ts` (all new), `backend/src/app.module.ts`, `backend/src/transactions/transactions.service.ts` (`remove`, `removeParentTransaction`, `removeSplit`, `removeAny`), `backend/src/transactions/transaction-transfer.service.ts` (`removeTransfer`, `removeTransferFromSplitInTransaction`, `removeCrossOwnerTransfer`), `backend/src/transactions/transaction-bulk-update.service.ts` (`bulkDelete`), `backend/src/securities/investment-transactions.service.ts` (`deleteCashTransactionInTransaction`, `removeAll`), `backend/src/transactions/transactions.controller.ts`, `backend/src/transactions/joint-register.service.ts`, `backend/src/mcp/tools/transactions.tool.ts`, `backend/src/ai/actions/ai-actions.service.ts`, `docs/backend/transactions-and-money.md` (one entry: "a deletion records its trash entry through `TransactionTrashWriter.record` inside the deleting transaction").

- The writer takes the ambient manager and the locked rows; it re-reads only the split tags and attachment metadata, inside the same transaction.
- `deletedVia` is a new parameter on `removeAny`, `remove`, `removeTransfer` and `bulkDelete` with no default, so every caller names itself; the compiler finds the call sites.
- The guard scans the named methods for a `DELETE FROM transactions` / `m.delete(Transaction` / `removeLockedTransactionLeg(` and requires a `trashWriter.record(` earlier in the same function body (the `reconciled-lock.guard.spec.ts` approach, with the covered list written out).
- Acceptance: the whole transactions, securities, MCP and AI unit suites green; every delete spec gains an assertion that one entry (or N for bulk) was recorded with the expected `kind` and `deleted_via`; balances identical (TRASH-004).

### B4 -- List, detail, purge, empty

**Files:** `backend/src/transaction-trash/transaction-trash.service.ts` + `.spec.ts`, `transaction-trash.controller.ts` + `.spec.ts`, `dto/trash-query.dto.ts`, `dto/trash-entry-response.dto.ts`, `dto/empty-trash.dto.ts` (new).

- `ILike` search; `limit` 1..100; `ParseUUIDPipe`; `ParseCalendarDatePipe` on `from`/`to`; the detail renders the snapshot through an allowlist (never the raw JSON); `@UseGuards(AuthGuard('jwt'))`, no `@AllowDelegate()`.
- Purge one and empty set `purged_at` only (TRASH-005); the bytes question is phase 2.

### B5 -- Restore

**Files:** `backend/src/transaction-trash/transaction-trash-restore.service.ts` + `.spec.ts` (new), `transaction-trash.controller.ts`, the rule applier's exemption list (locate by the undo entry named in `docs/future-plans/transaction-rules-tasks.md`), `backend/src/action-history/action-history.service.ts` (a description key for "restored"), `backend/src/transactions/reconciled-lock.util.ts` (`assertReconciledSnapshotMutable` over the snapshot's statuses, listed in `reconciled-lock.guard.spec.ts`'s covered set).

- Design 6.4 in order; the first statement is the conditional `UPDATE ... RETURNING` (TRASH-003); every refusal before the first insert (TRASH-006); `rebuildScopesFromTransactions` in the transaction (TRASH-007); `triggerDebouncedRecalc` after the commit.
- Acceptance: unit specs for truth table B and numerical examples 1-4; the two-connection test lands in Q1.

### B6 -- Purge cron and retention preference

**Files:** `backend/src/transaction-trash/transaction-trash-purge.service.ts` + `.spec.ts` (new), `backend/src/common/jobs/job-claim.service.ts` (`JobClaimType.TrashPurge`), `backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST`), `docs/cron-jobs.md` (one row, decorator verbatim, mechanism "claim"), `backend/src/users/dto/update-preferences.dto.ts`, `backend/src/users/users.service.ts`, `frontend/src/types/auth.ts`.

### F1 -- Trash page

**Files:** `frontend/src/lib/transaction-trash.ts` + `.test.ts`, `frontend/src/types/transaction-trash.ts`, the Trash page under the app router at route /trash with its test (new), `frontend/src/components/trash/TrashList.tsx` + `.test.tsx` + `.mobileWrapped.test.tsx`, `frontend/src/components/trash/TrashRetentionControl.tsx` + `.test.tsx` (all new), `frontend/src/i18n/messages.ts`, `frontend/src/i18n/messages/en/trash.json` (new), `frontend/src/lib/nav-links.ts`, `docs/frontend/ui-conventions.md` (one line if a new pattern is introduced; otherwise none).

- `Th`/`Td`, `useDensityPreference('trash')`, `Pagination`, `useLongPress` rows, `ConfirmDialog` for purge and empty, `useNumberFormat()`, dates through `useDateFormat`.

### F2 -- Entry drawer and restore

**Files:** `frontend/src/components/trash/TrashEntryDrawer.tsx` + `.test.tsx` (new), `frontend/src/lib/transaction-trash.ts` (`restore` calls `invalidateBalanceCaches`).

- Each 409 reason of truth table B rendered from the server's message; after success, the `/transactions?targetTransactionId=<id>` link.

### F3 -- Delete confirmations

**Files:** `frontend/src/components/transactions/TransactionList.tsx`, `frontend/src/app/transactions/page.tsx` (the bulk confirm), `frontend/src/components/transactions/TransactionActionSheet.tsx`, `frontend/src/i18n/messages/en/transactions.json`.

- One line: "Moved to Trash for N days" / "until you empty it", reading `trashRetentionDays` from preferences; the attachment warning when the row carries attachments (count from the row the list already holds). Live: the text changes for every user; nothing else does.

### Q1 -- Integration suite

**Files:** `backend/test/integration/transaction-trash.integration.spec.ts` (new).

### Q2 -- E2E

**Files:** `e2e/tests/transaction-trash.spec.ts` (new).

### Q3 -- Localization pass

Every locale for `trash`, `transactions`, `nav` and the backend keys. Final commit on the last PR.

### D1 -- Documentation

**Files:** the wiki's Transactions page (a "Trash" section after "Deleting"), `README.md` (one feature line), `docs/system-invariants.md` (TRASH-001..007 with mechanisms and status), `docs/financial-semantics.md`.

### P2 -- Phase 2 proposal

A spec in `docs/specs/` for attachment retention through the trash (design 12), its own discussion.
