# Savings Goals: Agent Task List

> Companion to [`savings-goals.md`](./savings-goals.md) (the design). This file breaks the plan into tasks sized for one AI-agent session each. Do the tasks in dependency order; never start a task whose dependencies are unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note instead.
- **The governing invariant applies to every task:** a goal never writes a ledger row, a balance or a holding (GOAL-001). A task that finds itself calling a transaction, account or holdings writer is off the plan.
- **Every figure is the server's** (GOAL-002). A component that sums, divides or compares dates to decide "on track" is off the plan; put the rule in `SavingsGoalProgressService` and read it.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `TZ=UTC npm run test:unit -- --coverage`; plus `npm run build && npm run test:integration` when a query, an entity or a migration changed; `npm run migration:lint` when a migration changed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:cov`, `npm run build`.
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q3, once, at acceptance.
  - The doc line each task names lands in the same PR.
- **Terminology:** "the design" = `savings-goals.md`; section references point there. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships real code, a table or endpoints that change nothing until a user creates a goal (or until a later task calls them). |
| **neutral** | Rewrites a live code path (an additive enum value, a new notification category row). Designed behaviour-preserving; the full unit suite of the touched module is the gate. |

Every task is safe to merge in any order that respects its dependencies: the table is empty until a user writes to it, the cron finds no goals, the widget is off by default (`defaultEnabled: false`) and the Tools link leads to an empty list.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Discussion agreeing `savings-goals.md`; label `approved-to-build`; answers to G1 and G2 recorded in the design | -- | none | [ ] |
| B1 | Migration + `schema.sql`: `savings_goals` with RLS; entity; backup classification (export query, `RESTORE_PLAN`, `BackupData`, restore wipe, support-backup rules, `RESTORE_LABELS`); `runOwnedDataDeletes` | S1 | inert | [ ] |
| B2 | `SavingsGoalsModule`: service CRUD with GOAL-003 and GOAL-006, DTOs, controller, `savings-goals.guard.spec.ts` (GOAL-001) | B1 | inert | [ ] |
| B3 | `SavingsGoalProgressService`: funded per source (truth table A), derived figures (decisions 6, 7), missing-data policy; `GET /savings-goals` returns progress | B2 | inert | [ ] |
| B4 | Notification types, `GOALS` category and channels on both layers; contract tests | S1 | neutral | [ ] |
| B5 | `SavingsGoalAlertService` cron, `JobClaimType.SavingsGoal`, `WITH_CONTEXT_ALLOWLIST`, `docs/cron-jobs.md` row, two-replica test | B3, B4 | inert | [ ] |
| F1 | `savingsGoalsApi`, types, `goals` i18n namespace, Tools link, Goals page (list, form, archive, delete) | B3 | inert | [ ] |
| F2 | Goal detail page (`/goals/[id]`) with the balance line for an account goal and the Transactions drill-down for a tag or category goal | F1 | inert | [ ] |
| F3 | `SavingsGoalsWidget` in the dashboard registry (`defaultEnabled: false`), icon, title section | F1 | inert | [ ] |
| F4 | Notification copy (`useNotificationCopy`, `notifications.json`) and the `/goals/<id>` target | B4, F1 | inert | [ ] |
| F5 | Account, tag and category delete dialogs name the goals the cascade removes (a count from `GET /savings-goals?sourceId=`) | F1 | neutral | [ ] |
| A1 | `list_savings_goals` on MCP and the in-app assistant over one `getLlmGoals` method; tool-count and byte-budget specs | B3 | inert | [ ] |
| Q1 | Backend integration suite `savings-goals.integration.spec.ts` (RLS bucket, ownership refusal, backup round-trip, funded per source on real PostgreSQL) | B3 | none | [ ] |
| Q2 | Playwright `tests/savings-goals.spec.ts` | F1, F3 | none | [ ] |
| Q3 | Full-locale i18n pass (acceptance, final commit) | all above | none | [ ] |
| D1 | Wiki page `Savings-Goals.md` and a README feature line | F3 | none | [ ] |

**Why B4 depends only on S1:** the category and the two types are additive constants; they can land before the producer exists, exactly as the notification-preferences spec planned ("arrives with its producer" is satisfied by B5 landing before Q3).

---

## Task details

### S1 -- Proposal

Open a Discussion linking `savings-goals.md`, summarising decisions 1-10, the table and the cron, and asking the maintainer to answer G1 (liability accounts as a source) and G2 (celebration window). Record the answers as edits to the design before B1 starts.

### B1 -- Table, entity, backup classification

**Files:** `database/migrations/<UTC timestamp>_savings_goals.sql` (new), `database/schema.sql`, `backend/src/savings-goals/entities/savings-goal.entity.ts` (new), `backend/src/backup/export-table-queries.ts`, `backend/src/backup/restore-plan.ts`, `backend/src/backup/backup-format.ts`, `backend/src/backup/backup-restore-database.service.ts`, `backend/src/backup/support-backup/support-backup-rules.ts`, `backend/src/backup/support-backup/support-backup-sections.ts`, `frontend/src/lib/restore-labels.ts`, `backend/src/users/users.service.ts` (`runOwnedDataDeletes`), `docs/backup-restore-contract.md` (one row).

- The DDL of design 6.1, the uniform direct policy and `ENABLE ROW LEVEL SECURITY` in the same file, `update_updated_at_column` trigger, indexes on `(user_id, archived_at)` and on each source column.
- Acceptance: `npm run migration:lint`, `scripts/verify-schema.sh`, `node scripts/check-migration-prefixes.mjs`; `rls-enforcement.integration.spec.ts` places the table in the direct bucket; `backup-restore.integration.spec.ts` coverage guard passes; the support-backup golden test passes with the decision made (`name`, `notes` masked).
- Inert: nothing reads or writes the table until B2.

### B2 -- Module, CRUD, guard

**Files:** `backend/src/savings-goals/savings-goals.module.ts`, `savings-goals.service.ts` + `.spec.ts`, `savings-goals.controller.ts` + `.spec.ts`, `dto/create-savings-goal.dto.ts`, `dto/update-savings-goal.dto.ts`, `dto/savings-goal-response.dto.ts`, `savings-goals.guard.spec.ts` (all new), `backend/src/app.module.ts`, `docs/backend/README.md` (one row naming the module and GOAL-001).

- `withScopedDb` only. The create path loads the named source inside the same transaction as the insert and derives `currency_code` (GOAL-003); a missing source is `NotFoundException` with `tr(...)` and nothing written (GOAL-006).
- The DTO: `@ArrayMaxSize` is not needed (no arrays); `@ValidateIf((_o, v) => v !== null && v !== "")` beside every optional formatted field; the class-level "exactly one source" validator mirrors the CHECK constraint.
- `savings-goals.guard.spec.ts`: scans `backend/src/savings-goals/**/*.ts` (excluding specs) and fails an import of `TransactionsService`, `AccountsService` write methods, `HoldingsService` or `InvestmentTransactionsService` (GOAL-001). Name the invariant in the failure message.
- `@UseGuards(AuthGuard('jwt'))`, `ParseUUIDPipe` on `:id`, no `@AllowDelegate()` (decision 8).
- Acceptance: unit specs for CRUD, refusal and currency derivation; `module-graph.spec.ts` green.

### B3 -- Progress read model

**Files:** `backend/src/savings-goals/savings-goal-progress.service.ts` + `.spec.ts` (new), `backend/src/savings-goals/goal-pace.util.ts` + `.spec.ts` (new, pure: `monthsRemaining`, `requiredMonthly`, `pace`, `projectedDate`), `savings-goals.service.ts`, `savings-goals.controller.ts`, `docs/financial-semantics.md` (a short "Savings goals" section stating decisions 3, 4, 6 and 7).

- Account source: `current_balance`, or `AccountsService.getDailyBalances` for the two boundary days. Tag and category sources: one SQL per source over parent rows and split lines with `investmentExclusionSql`, the VOID exclusion and `t.parent_transaction_id IS NULL`, grouped by currency; `FxAggregate` with `resolveFxRate` per row date (INV-FX-001). `TO_CHAR` for dates, `Number(...)` at the boundary.
- Dates stepped with `addDaysYMD` / `enumerateDaysYMD`; no `Date` at the boundary.
- Acceptance: the truth tables A and B and the three numerical examples of design 8 as unit tests; integration cases in Q1.

### B4 -- Notification types and category

**Files:** `backend/src/notification-center/entities/notification.entity.ts`, `backend/src/notification-center/notification-preference.service.ts`, `backend/src/notifications/notification-dispatch.service.ts` (`PUSH_CATEGORY_COPY`), `backend/src/i18n/locales/en/*.json` (the push key), `frontend/src/types/notification.ts`, `frontend/src/lib/notification-preferences.ts`, `docs/specs/notification-preferences.md` (the reserved `goals` row becomes real).

- Acceptance: `notification-category.spec.ts` maps both types to `GOALS`; `notification.contract.test.ts` and `notification-preferences.contract.test.ts` green; the preferences matrix shows a Goals row with in-app on and email configurable.

### B5 -- Alert cron

**Files:** `backend/src/savings-goals/savings-goal-alert.service.ts` + `.spec.ts` (new), `backend/src/common/jobs/job-claim.service.ts` (`JobClaimType.SavingsGoal`), `backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST`), `docs/cron-jobs.md` (one row; `cron-doc.spec.ts` checks the decorator verbatim and the mechanism vocabulary), `backend/test/integration/savings-goal-alerts.integration.spec.ts` (new).

- Design 6.4 exactly: `withSystemContext` to list, `withUserContext` per user, `claimOnce` then the conditional `UPDATE ... RETURNING` for reached, `claimOnce` for behind, `notify` with the same string as `dedupeKey` (GOAL-005).
- Acceptance: the two-connection test proves one notification across two concurrent ticks; a null-funded goal produces nothing; a reached goal that later dips does not re-fire.

### F1 -- API client, types, page, form

**Files:** `frontend/src/lib/savings-goals.ts` + `.test.ts`, `frontend/src/types/savings-goal.ts`, the Goals page under the app router at route /goals with its test (new), `frontend/src/components/goals/SavingsGoalCard.tsx` + `.test.tsx`, `frontend/src/components/goals/SavingsGoalForm.tsx` + `.test.tsx` (all new), `frontend/src/i18n/messages.ts`, `frontend/src/i18n/messages/en/goals.json` (new), `frontend/src/lib/nav-links.ts`, `docs/frontend/ui-conventions.md` (one line: a goal progress bar is `BudgetProgressBar`).

- `Card`, `Modal`, `DateInput`, `CurrencyInput`, `EmptyState`, `Badge`, `useNumberFormat()`, `useFinancialToday()` only for display of "today"; `BudgetProgressBar` for the bar.
- The card prints `funded`, `remaining`, `requiredMonthly`, `projectedDate`, `onTrack` from the response and prints the `unknownReason` copy when a figure is null (design 9). No arithmetic in the component (GOAL-002).
- Acceptance: tests for loading, empty, list, form validation (exactly one source, target > 0), the three unknown reasons rendered.

### F2 -- Detail page

**Files:** the goal detail page at route /goals/<id> with its test (new), `frontend/src/components/goals/GoalBalanceChart.tsx` + `.test.tsx` (new).

- Account goal: a line of `getDailyBalances` from `start_date` (or the account's first day) to today, with the target as a reference line; Recharts, `chartColors` tokens, `CHART_MAX_POINTS` sampling via `chart-sampling.ts` (INV-REPORT-002: the sampled series reaches no figure).
- Tag or category goal: a "View transactions" link to `/transactions?tagIds=` or `?categoryId=` with `startDate`.

### F3 -- Dashboard widget

**Files:** `frontend/src/components/dashboard/SavingsGoalsWidget.tsx` + `.test.tsx` (new), `frontend/src/components/dashboard/widget-registry.tsx` + `.test.tsx`, `frontend/src/components/dashboard/widget-meta.tsx`, `frontend/src/i18n/messages/en/dashboard.json`.

- Self-fetching (the `SectorWeightingsWidget` pattern); `defaultEnabled: false`; `titleHref="/goals"`; up to five goals.
- Acceptance: `widget-registry.test.tsx` green; the widget renders the server's figures.

### F4 -- Notification copy

**Files:** `frontend/src/hooks/useNotificationCopy.ts`, `frontend/src/i18n/messages/en/notifications.json`, `frontend/src/lib/notification-target.contract.test.ts` (the `/goals/<id>` route is now real).

### F5 -- Cascade warnings

**Files:** the account, tag and category delete confirmations (`frontend/src/components/accounts/`, `frontend/src/app/tags/`, `frontend/src/app/categories/` -- locate by the `ConfirmDialog` each uses), `savings-goals.controller.ts` (a `sourceId` query filter on the list route).

- Neutral: the dialogs gain a line only when the count is non-zero.

### A1 -- AI tools

**Files:** `backend/src/mcp/tools/goals.tool.ts` + `.spec.ts` (new), `backend/src/mcp/tool-output-schemas.ts`, `backend/src/mcp/mcp.module.ts`, `backend/src/mcp/mcp-server.service.ts`, `backend/src/mcp/mcp-annotations.spec.ts` (`EXPECTED_TOOL_COUNT`), `backend/src/mcp/tools-list-budget.spec.ts`, `backend/src/ai/query/tool-definitions.ts` + `.spec.ts`, `backend/src/ai/query/tool-input-schemas.ts`, `backend/src/ai/query/tool-executor.service.ts` + `.spec.ts`, `savings-goals.service.ts` (`getLlmGoals`), `docs/backend/mcp.md` and `docs/backend/ai-and-payees.md` (one line each).

- Read-only annotations; `requireScope(user.scopes, "read")`; `valuationComplete` and `unknownReason` carried into the LLM shape.

### Q1 -- Integration suite

**Files:** `backend/test/integration/savings-goals.integration.spec.ts` (new).

### Q2 -- E2E

**Files:** `e2e/tests/savings-goals.spec.ts` (new). Create an account goal, assert the card's figures match the account balance, archive, delete.

### Q3 -- Localization pass

Every locale in `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts` for the `goals`, `dashboard`, `notifications` and backend keys. Final commit on the last PR.

### D1 -- Documentation

**Files:** the wiki repository's Savings-Goals page (new), `README.md` (one feature line), `docs/system-invariants.md` (GOAL-001..006 admitted with their mechanisms and an honest status).
