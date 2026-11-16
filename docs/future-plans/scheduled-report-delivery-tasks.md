# Scheduled Report Delivery: Agent Task List

> Companion to [`scheduled-report-delivery.md`](./scheduled-report-delivery.md) (the design). One task per session/PR, in dependency order. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note instead.
- **The governing invariants apply to every task:** the email's figures are the page's figures (RDEL-002), the range is computed from the run date in the schedule's timezone (RDEL-003), and a schedule sends at most once per period (RDEL-001). An adapter that aggregates on its own, a cron body that reads the clock per user, or a send outside the claim is off the plan.
- **No new dependency.** v1 renders HTML with the string-template functions the other emails use. A PDF library is phase 3 and a maintainer decision.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `TZ=UTC npm run test:unit -- --coverage`; plus `npm run build && npm run test:integration` when a query, an entity or a migration changed; `npm run migration:lint` when a migration changed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:cov`, `npm run build`.
  - `node scripts/check-env-docs.mjs` when an env var is added (B4 adds two constants, not env vars; if a reviewer asks for configurability, the env table and `.env.example` change in that PR).
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only (backend `en/*.json` for the email), then `npm run i18n:pseudo` in both layers. The full-locale pass is Q3, once, at acceptance.
  - The doc line each task names lands in the same PR.
- **Terminology:** "the design" = `scheduled-report-delivery.md`; section references point there. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships a table, adapters, a renderer or endpoints that send nothing until a user creates a schedule. |
| **neutral** | Rewrites a live code path (a new notification category row, additive). Designed behaviour-preserving. |
| **live** | The cron starts selecting due rows every hour; with no rows it does nothing. |

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Discussion agreeing `scheduled-report-delivery.md`; label `approved-to-build`; R1-R3 answered | -- | none | [ ] |
| B1 | Migration + `schema.sql`: `report_schedules` with RLS; entity; backup classification incl. the `next_run_at` recompute on restore; `runOwnedDataDeletes` | S1 | inert | [ ] |
| B2 | `schedule-cadence.util.ts` (`nextRunAt`) and `delivery-range.util.ts` (`resolveDeliveryRange`), pure, with truth table A and the DST cases | S1 | none | [ ] |
| B3 | `DELIVERABLE_REPORTS` registry + the 16 adapters + `report-delivery.guard.spec.ts` (RDEL-002, RDEL-007) | S1 | inert | [ ] |
| B4 | `ReportSchedulesService` CRUD + DTOs + controller + `/deliverable` + the 20-per-user bound | B1, B2, B3 | inert | [ ] |
| B5 | `REPORTS` notification category and the two types on both layers; contract tests | S1 | neutral | [ ] |
| B6 | `report-email.template.ts` renderer (RDEL-004, RDEL-005) | B3 | none | [ ] |
| B7 | `ReportDeliveryService.deliverDue` cron with the conditional claim, outcomes (truth table B), `send-now` with its rate limit; `JobClaimType.ReportSendNow`; `WITH_CONTEXT_ALLOWLIST`; `docs/cron-jobs.md` row; `docs/external-side-effects.md` section 4 entry | B4, B5, B6 | live (no rows: no effect) | [ ] |
| F1 | `reportSchedulesApi`, types, `ScheduleReportButton` + modal on `ReportDetailHeader` | B4 | inert | [ ] |
| F2 | Settings "Scheduled reports" section with `ScheduledReportsList`, Send now, toggle, edit, delete | F1, B7 | inert | [ ] |
| F3 | Notification copy and the `REPORTS` row in the preferences matrix | B5 | neutral | [ ] |
| Q1 | Integration suite `report-delivery.integration.spec.ts`: two-connection claim, restore recompute, RLS bucket, backup round-trip, limit refusal | B7 | none | [ ] |
| Q2 | Playwright `tests/scheduled-reports.spec.ts` | F2 | none | [ ] |
| Q3 | Full-locale i18n pass, both layers (acceptance, final commit) | all above | none | [ ] |
| D1 | Wiki Reports page section, README line, `docs/system-invariants.md` RDEL-001..007 | Q1 | none | [ ] |
| P2 | Defect reports: `ReportsService` FX completeness and timezone (two issues, not fixed here) | S1 | none | [ ] |
| P3 | Phase 2 proposal: custom and investment report adapters, after P2's fixes merge | P2, D1 | none | [ ] (separate proposal) |
| P4 | Phase 3 decision: server PDF (dependency choice) | D1 | none | [ ] (maintainer decision) |

**Why B2, B3, B5 and B6 depend only on S1:** each is pure or additive and can be built in parallel sessions; they meet at B4 and B7.

---

## Task details

### S1 -- Proposal

Open a Discussion linking `scheduled-report-delivery.md`, summarising decisions 1-11, the table, the claim and the cron, and asking the maintainer to answer R1 (at-most-once), R2 (email default) and R3 (table in the email). Record the answers in the design before B1 starts.

### B1 -- Table, entity, backup

**Files:** `database/migrations/<UTC timestamp>_report_schedules.sql` (new), `database/schema.sql`, `backend/src/report-delivery/entities/report-schedule.entity.ts` (new), `backend/src/backup/export-table-queries.ts`, `backend/src/backup/restore-plan.ts`, `backend/src/backup/backup-format.ts`, `backend/src/backup/backup-restore-database.service.ts` (wipe + the `next_run_at` recompute after insert), `backend/src/backup/support-backup/support-backup-rules.ts`, `backend/src/backup/support-backup/support-backup-sections.ts`, `frontend/src/lib/restore-labels.ts`, `backend/src/users/users.service.ts` (`runOwnedDataDeletes`), `docs/backup-restore-contract.md` (one row).

- Design 6.1 exactly; direct policy and enable in the same file.
- The recompute on restore calls `nextRunAt` (B2) and is therefore sequenced after B2 in practice; if B1 lands first, the recompute is a `TODO` that B2 fills in the same release, noted on the task.

### B2 -- Cadence and range resolvers

**Files:** `backend/src/report-delivery/schedule-cadence.util.ts` + `.spec.ts`, `backend/src/report-delivery/delivery-range.util.ts` + `.spec.ts` (new).

- `nextRunAt(schedule, fromInstant: Date): Date` using `Intl.DateTimeFormat` with the schedule's timezone for the wall-clock to instant conversion (the `calculateNextBackupAt` technique); `resolveDeliveryRange(preset, runDateYmd, weekStartsOn)` in `YYYY-MM-DD` string arithmetic with `addDaysYMD`.
- Acceptance: truth table A every cell; the three numerical examples; DST both ways; February 28 and leap day.

### B3 -- Adapter registry

**Files:** `backend/src/report-delivery/deliverable-reports.ts` (the registry: `id -> { paramKeys, run(userId, range, params) }`), `backend/src/report-delivery/adapters/<report-id>.adapter.ts` + `.spec.ts` (16 new, one per served report), `backend/src/report-delivery/report-email-model.ts` (the type), `backend/src/report-delivery/report-delivery.guard.spec.ts` (new).

- Each adapter injects the feature service the controller injects for that route and maps its response to `ReportEmailModel`; a null total becomes a card with the reason.
- The guard scans `adapters/` for `@InjectRepository`, `dataSource`, `withScopedDb` or `SELECT` and fails any (RDEL-002); `paramKeys` must be a subset of the route's DTO fields (asserted by reading the DTO class metadata, or a hand-kept table checked both ways).

### B4 -- Schedules CRUD

**Files:** `backend/src/report-delivery/report-delivery.module.ts`, `report-schedules.service.ts` + `.spec.ts`, `report-schedules.controller.ts` + `.spec.ts`, `dto/create-report-schedule.dto.ts`, `dto/update-report-schedule.dto.ts`, `dto/report-schedule-response.dto.ts` (new), `backend/src/app.module.ts`, `docs/backend/README.md` (one row).

- `withScopedDb`; the 21st schedule refused inside the insert transaction; `params` validated against the adapter's `paramKeys` (RDEL-007); `timezone` through `isValidIanaTimezone`, defaulted from `getUsersByEffectiveTimezone`'s resolution for the one user; `next_run_at` from `nextRunAt`; `@UseGuards(AuthGuard('jwt'))`, `ParseUUIDPipe`, no `@AllowDelegate()`.

### B5 -- Notification category and types

**Files:** `backend/src/notification-center/entities/notification.entity.ts`, `backend/src/notification-center/notification-preference.service.ts`, `backend/src/notifications/notification-dispatch.service.ts` (`PUSH_CATEGORY_COPY`, push off so the copy is unused but the map is total), `frontend/src/types/notification.ts`, `frontend/src/lib/notification-preferences.ts`, `docs/specs/notification-preferences.md` (a `reports` row: in-app on, email on, push off).

### B6 -- Renderer

**Files:** `backend/src/notifications/report-email.template.ts` + `.spec.ts` (new), `backend/src/i18n/locales/en/*.json` (the email keys).

- The template takes `(firstName, model, appUrl, t, n)`; `escapeHtml` everywhere; the spec's `<b>x</b>` case; `de-DE` numbers; 50-row bound.

### B7 -- Delivery cron and send-now

**Files:** `backend/src/report-delivery/report-delivery.service.ts` + `.spec.ts` (new), `report-schedules.controller.ts` (`send-now`), `backend/src/common/jobs/job-claim.service.ts` (`JobClaimType.ReportSendNow`), `backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST`), `docs/cron-jobs.md` (one row, decorator verbatim, mechanism "conditional `UPDATE ... RETURNING`"), `docs/external-side-effects.md` (a section 4 entry naming the at-most-once choice).

- Design 6.3 in order; truth table B; `sendMail` inside `try/catch` (RDEL-006); the in-app row through `NotificationDispatchService.notify` with a `dedupeKey` of `report-delivery:<scheduleId>:<periodKey>`.
- Send now: `claimLease(JobClaimType.ReportSendNow, userId, "<YYYY-MM-DDTHH>:<n>")` for `n` in 1..3 until one succeeds, else 429 with the hour.

### F1 -- Schedule button and modal

**Files:** `frontend/src/lib/report-schedules.ts` + `.test.ts`, `frontend/src/types/report-schedule.ts`, `frontend/src/components/reports/ScheduleReportButton.tsx` + `.test.tsx`, `frontend/src/components/reports/ScheduleReportModal.tsx` + `.test.tsx` (new), `frontend/src/components/reports/ReportDetailHeader.tsx` + `.test.tsx`, `frontend/src/i18n/messages/en/reports.json`.

- `Modal`, `Select` for cadence and preset, a time input (the existing one, locate by `backup_time`'s control in the backup settings), `InfoTooltip` for "figures and tables, no chart"; the button renders only when the id is in `/deliverable`.

### F2 -- Settings section

**Files:** `frontend/src/app/settings/page.tsx`, `frontend/src/components/settings/ScheduledReportsList.tsx` + `.test.tsx` + `.mobileWrapped.test.tsx` (new), `frontend/src/components/settings/SettingsNav.tsx` (only if the nav needs an entry beyond `SETTINGS_SECTION_IDS`), `frontend/src/i18n/messages/en/settings.json`.

- `Th`/`Td`, `Badge` for status, `ConfirmDialog` for delete, dates in the schedule's timezone through `useDateFormat` with an explicit zone.

### F3 -- Notification copy and matrix row

**Files:** `frontend/src/hooks/useNotificationCopy.ts`, `frontend/src/i18n/messages/en/notifications.json`, `frontend/src/components/settings/NotificationPreferencesMatrix.tsx` + `.test.tsx` (the row appears from the constant; the test asserts it), `frontend/src/lib/notification-target.contract.test.ts`.

### Q1 -- Integration suite

**Files:** `backend/test/integration/report-delivery.integration.spec.ts` (new).

### Q2 -- E2E

**Files:** `e2e/tests/scheduled-reports.spec.ts` (new). The E2E stack has no SMTP: the assertion is the `skipped` status with its reason and the in-app row.

### Q3 -- Localization pass

Every locale, both layers, for `reports`, `settings`, `notifications` and the email keys. Final commit on the last PR.

### D1 -- Documentation

**Files:** the wiki's Reports page (a "Scheduled delivery" section), `README.md` (one feature line under Reports), `docs/system-invariants.md` (RDEL-001..007).

### P2 -- Defect reports (not fixes)

Two issues: `ReportsService` custom-report execution sums raw amounts across currencies with no completeness flag (the "a subtotal is not a total" rule), and `ReportsService.getDateRange` resolves presets on the server clock. Each names the rule it breaks and the fix shape; neither is changed in this plan.

### P3 -- Phase 2 proposal

Adapters for `custom` and `investment` kinds over `ReportsService.execute` and `InvestmentReportsService`'s execute, once P2's fixes have merged; a disabled-on-delete rule for a schedule whose saved report is gone.

### P4 -- Phase 3 decision

A maintainer decision on a server PDF: `pdfkit` (tables and cards, no chart, light) versus a headless browser (the page as rendered, heavy, a container change). Input: the adapter model from B3. Output: a dependency decision recorded in `docs/adr/`.
