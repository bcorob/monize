# Scheduled report delivery

Design for emailing a report on a schedule: a user picks a report, a date
range preset, a cadence and a time, and receives the report's figures as an
HTML email in their language and number locale, with a link that opens the
live report over the same range. The task list is
[`scheduled-report-delivery-tasks.md`](./scheduled-report-delivery-tasks.md).

Status: **proposal**. It needs its own discussion with the `approved-to-build`
label before any task starts (`CONTRIBUTING.md`). It sends email on a
schedule and reports money, so sections 4 to 9 are the specification
`docs/financial-calculation-contract.md` section 9 asks for, and
`docs/external-side-effects.md` section 4 governs the send.

## 1. Where this comes from, and what is true today

Every PDF Monize produces is built in the browser (`exportToPdf`,
`frontend/src/lib/pdf-export.ts`, over jsPDF and the live Recharts DOM). The
backend has no HTML-to-PDF capability and no chart renderer beyond the
label-less `renderPriceChart` used for push images. Of the 46 built-in
reports, 16 are served by `backend/src/built-in-reports/`; the other 30 are
composed in the browser from other modules' endpoints. Custom reports
(`backend/src/reports/`) sum raw amounts across currencies and resolve
their date range on the server clock.

So "email me the PDF I can download" is not a feature the server can
provide today without a new dependency, and the maintainer must decide that
separately (`AGENTS.md`: adding a dependency is ask-first). This plan
delivers what the server can already compute, honestly: the 16
server-served built-in reports as HTML emails of figures and tables, with a
registry that grows one adapter at a time, and a decision point for PDF
after it has shipped.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| The report's figures | the feature services behind `BuiltInReportsService` (`backend/src/built-in-reports/built-in-reports.service.ts`), e.g. `SpendingReportsService.getSpendingByCategory`, `IncomeReportsService.getIncomeVsExpenses` | The email calls the same method the page calls. One aggregation, two renderings. |
| The response envelope | `totalSpending: number \| null`, `knownSpending`, `missingCurrencies`, `excludedCount` | Carried into the email as the figure or its reason. |
| The sender | `EmailService.sendMail(to, subject, html, { attachments? })` (`backend/src/notifications/email.service.ts`) | Attachments are typed `{ filename, content: Buffer, contentType }`; `getStatus().configured` first. |
| Templates and escaping | `backend/src/notifications/email-templates.ts`, `escapeHtml` (`backend/src/common/escape-html.util.ts`) | Every user value escaped. |
| Recipient locale and numbers | `resolveUserEmailFormats` (`backend/src/i18n/resolve-user-email-locale.ts`), `emailTranslator` (`backend/src/i18n/email-translator.ts`), `numberFormatterFor` (`backend/src/common/number-locale.util.ts`) | INV-DISPLAY-001 for a figure composed outside a request. |
| Report-mode email switch | `NotificationPreferenceService.resolveEmail(userId, category)`; `docs/specs/notification-preferences.md` section 4 | A digest is "report mode": never throttled, gated by the master switch and the category row. |
| A schedule row with a conditional claim | `AutoBackupService.claimDueBackup`, `calculateNextBackupAt` (`backend/src/backup/auto-backup.service.ts`) | `UPDATE ... SET next_... WHERE ... AND next_... <= $now RETURNING` advances before the work: at-most-once per period. |
| Effective timezone | `getUsersByEffectiveTimezone` (`backend/src/common/users-by-timezone.util.ts`), `todayInTimezone` (`backend/src/common/date-utils.ts`) | `withUserContext` seeds no timezone; the run passes the date in. |
| Email as a side effect | `docs/external-side-effects.md` section 4 (lease plus delivery record, or conditional claim) | This plan uses the conditional claim (decision 6). |
| Range presets | `resolveRangePreset` (`frontend/src/lib/date-range.ts`) | Client-only today; the server gains its own resolver for the schedule's presets (decision 4). |
| Where a Schedule button goes | `ReportDetailHeader` (`frontend/src/components/reports/ReportDetailHeader.tsx`) | Per-report actions live there. |
| Settings sections | `SETTINGS_SECTION_IDS` (`frontend/src/app/settings/page.tsx`), `SettingsNav` | A "Scheduled reports" section. |
| Favourites | `user_preferences.favourite_report_ids` | Unrelated; a schedule is its own row. |

## 3. Product decisions

1. **v1 delivers the server-served built-in reports only.** A registry
   `DELIVERABLE_REPORTS` maps a built-in report id to an adapter that calls
   the existing service and returns one `ReportEmailModel`. The 16 ids the
   controller serves are the initial set; a report without an adapter does
   not show the Schedule button. Custom and investment reports follow in
   phase 2 after their FX and timezone defects are fixed (section 12).
2. **The email is figures and tables, not a picture.** Summary cards (the
   report's totals, or the reason a total is unknown), the report's main
   table (bounded to 50 rows with a "and N more" line), the range, and one
   link to the live report with the same `startDate`/`endDate` in the query
   string. No chart. A chart needs either a browser or a new dependency.
3. **One schedule, one report, one range preset.** `last_week`,
   `last_month`, `last_quarter`, `last_year`, `month_to_date`,
   `year_to_date`, `last_30_days`, `last_90_days`. The preset resolves at
   run time in the schedule's timezone from the run date (decision 5).
4. **Cadence is weekly, monthly, quarterly or yearly**, with a day
   (weekday 0-6, or day-of-month 1-28 so every month has it), a send time
   `HH:MM` and an IANA timezone defaulted from the user's effective
   timezone at creation. The server's resolver is `nextRunAt(schedule,
   fromInstant)` in `backend/src/report-delivery/schedule-cadence.util.ts`;
   `calculateNextBackupAt` is the precedent, not shared (its cadence set
   differs).
5. **The range is a function of the run date in the schedule's timezone.**
   `resolveDeliveryRange(preset, runDateYmd)` -> `{ startDate, endDate }`,
   pure string arithmetic on `YYYY-MM-DD`. The run date is computed once per
   tick from `next_run_at` and the timezone and passed down (the
   mortgage-reminder per-user clock read is the gap this avoids).
6. **At most once per period, by conditional claim.** The hourly cron
   advances `next_run_at` in a conditional `UPDATE ... RETURNING` before
   composing; a schedule another replica already advanced is skipped. A
   failed send is recorded on the row (`last_run_status`, `last_run_error`),
   surfaces as an in-app notification, and is not retried by the cron: the
   user's "Send now" is the retry. This is the at-most-once pattern
   `docs/external-side-effects.md` section 4 names, chosen because a
   duplicate monthly report is more annoying than a missed one that says
   it was missed.
7. **"Send now" composes through the same path** with `runDate = today` in
   the schedule's timezone, so what the user previews is what the schedule
   sends. It is rate-limited to `REPORT_DELIVERY_SEND_NOW_PER_HOUR` (3) per
   user through a `claimLease` on `(userId, 'send-now', <hour>)` counted in
   the claim key, and does not advance `next_run_at`.
8. **Email is gated by the report-mode switch of a new `REPORTS`
   notification category**: in-app on, `email` on by default, push off,
   mirrored on both layers. A user whose master `notification_email` is off
   gets the in-app row only, and the schedule's row says so.
9. **An in-app notification is always written** (INV-DISPATCH-002):
   `report_delivered` with the range and a link to the live report, or
   `report_delivery_failed` with the reason. The email itself is composed
   separately (the bill-reminder pattern), because the dispatch seam carries
   no custom body.
10. **A schedule is bounded**: `REPORT_SCHEDULES_PER_USER` (20) and the
    table row bounds in the DTO. `params` is a JSONB of the report's own
    query fields (`accountIds`, `bucket`, `rollupToParent`, `tagKey`),
    validated against the adapter's declared allowlist so a schedule cannot
    carry a field the report does not take.
11. **Owner-only in v1.** No `@AllowDelegate()`.

## 4. Definitions

- `runInstant`: `next_run_at` at the moment the claim succeeds.
- `runDateYmd`: `runInstant` rendered as a date in the schedule's timezone.
- `period key`: `runInstant` as ISO; unique per schedule because
  `next_run_at` only moves forward.
- `ReportEmailModel`: `{ reportId; title; range: { startDate; endDate;
  label }; currency; cards: Array<{ label; value: number | null; kind:
  'money' | 'count' | 'percent'; reason?: string }>; table: { headers:
  string[]; rows: Array<Array<string | number | null>>; moreCount: number
  }; incomplete?: { missingCurrencies: string[]; excludedCount: number };
  liveUrl: string }`.

## 5. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| RDEL-001 | A schedule produces at most one email per period across replicas | `UPDATE report_schedules SET next_run_at = $next, last_run_at = $now WHERE id = $1 AND enabled AND next_run_at <= $now RETURNING id`; only the returning replica composes. INV-CRON-001. |
| RDEL-002 | The email's figures are the page's figures | The adapter calls the same service method the controller calls; `report-delivery.guard.spec.ts` fails an adapter that imports a repository or writes SQL. |
| RDEL-003 | The range is computed from the run date in the schedule's timezone | `resolveDeliveryRange` takes `runDateYmd`; the cron computes it once per claim; the spec asserts the DST and month-end cases. |
| RDEL-004 | An unknown figure says why, never 0 | A card with `value: null` renders the reason (`missingCurrencies`, `excludedCount`) through the same copy the page uses; the renderer's spec asserts no `0` is printed for a null. |
| RDEL-005 | Every user value in the email is escaped and localized | `escapeHtml` on every string, `numberFormatterFor` on every number, `emailTranslator` on every label; the template spec checks a payee named `<b>x</b>`. |
| RDEL-006 | A failed send is recorded and reported, never raised | `try/catch` around `sendMail`; `last_run_status = 'failed'`, `last_run_error` bounded to 1024 chars; the in-app row written; the cron continues (INV-DISPATCH-004 analogue). |
| RDEL-007 | A schedule carries only fields its report accepts | The adapter declares `paramKeys`; the DTO validator refuses any other key (`forbidNonWhitelisted` at the JSONB level, implemented in a custom validator). |

## 6. Data contracts (new)

### 6.1 Table `report_schedules`

```sql
CREATE TABLE IF NOT EXISTS report_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_kind VARCHAR(12) NOT NULL CHECK (report_kind IN ('built_in','custom','investment')),
  report_id VARCHAR(64) NOT NULL,              -- built-in id, or the uuid of a saved report
  name VARCHAR(100) NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  range_preset VARCHAR(16) NOT NULL,
  cadence VARCHAR(10) NOT NULL CHECK (cadence IN ('weekly','monthly','quarterly','yearly')),
  day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month SMALLINT CHECK (day_of_month BETWEEN 1 AND 28),
  month_of_year SMALLINT CHECK (month_of_year BETWEEN 1 AND 12),
  send_time VARCHAR(5) NOT NULL,               -- HH:MM
  timezone VARCHAR(64) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_run_status VARCHAR(10) CHECK (last_run_status IS NULL OR last_run_status IN ('sent','skipped','failed')),
  last_run_error VARCHAR(1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_due ON report_schedules (next_run_at) WHERE enabled;
```

Direct RLS bucket. `skipped` is the status when email was off for the user
(the in-app row still says the report was ready). Backup: exported, with a
`RESTORE_PLAN` row; `next_run_at` is recomputed on restore from the cadence
(a restored schedule must not fire for a period that passed while the
backup sat on disk) in `backup-restore-database.service.ts`'s post-insert
step. Support backup: `name` masked, `params` dropped (`const '{}'` since
NOT NULL), the rest kept. `runOwnedDataDeletes` deletes it.

### 6.2 Endpoints

- `GET /report-schedules`, `POST /report-schedules`, `PATCH
  /report-schedules/:id`, `DELETE /report-schedules/:id`, `POST
  /report-schedules/:id/send-now`, `GET /report-schedules/deliverable` (the
  ids with an adapter and their `paramKeys`, so the UI shows the button only
  where it works).
- The create DTO: `reportKind`, `reportId`, `name`, `params`, `rangePreset`,
  `cadence`, `dayOfWeek?`, `dayOfMonth?`, `monthOfYear?`, `sendTime`,
  `timezone?` (defaults to the effective timezone; `isValidIanaTimezone`).
  The service computes `next_run_at` and refuses a 21st schedule inside the
  insert transaction.

### 6.3 The cron

`ReportDeliveryService.deliverDue` at `5 * * * *` (server time; the claim
makes the server's timezone irrelevant). `withSystemContext` selects
`enabled AND next_run_at <= NOW()` ids; per row, `withUserContext(userId)`:
the conditional claim (RDEL-001), `runDateYmd` from the claimed
`next_run_at` and the row's timezone, `resolveDeliveryRange`, the adapter,
`resolveEmail(userId, REPORTS)`, the render, `sendMail`, the status, the
in-app row. `SMTP not configured` is `skipped` with its reason, once per
row, not an error.

### 6.4 The renderer

`report-email.template.ts`: `reportEmailTemplate(firstName, model, appUrl,
t, n)` beside the other templates; a cards row, the table (50 rows, then
"and N more"), the incomplete banner, the live link; every string through
`escapeHtml`, every number through `n`, every label through `t`.

## 7. Truth tables

### A. Range from the run date (schedule timezone)

| preset | runDateYmd 2026-10-01 | runDateYmd 2027-01-04 (Monday) |
|---|---|---|
| last_week | 2026-09-21 .. 2026-09-27 (Mon..Sun, `week_starts_on` honoured) | 2026-12-28 .. 2027-01-03 |
| last_month | 2026-09-01 .. 2026-09-30 | 2026-12-01 .. 2026-12-31 |
| last_quarter | 2026-07-01 .. 2026-09-30 | 2026-10-01 .. 2026-12-31 |
| last_year | 2025-01-01 .. 2025-12-31 | 2026-01-01 .. 2026-12-31 |
| month_to_date | 2026-10-01 .. 2026-10-01 | 2027-01-01 .. 2027-01-04 |
| year_to_date | 2026-01-01 .. 2026-10-01 | 2027-01-01 .. 2027-01-04 |
| last_30_days | 2026-09-01 .. 2026-09-30 | 2026-12-05 .. 2027-01-03 |

### B. Run outcome

| claim returned | email switch | SMTP | send | status | in-app row |
|---|---|---|---|---|---|
| no | any | any | none | unchanged | none |
| yes | off | any | none | `skipped` | `report_delivered` (link only, "email is off for Reports") |
| yes | on | not configured | none | `skipped` | `report_delivered` + reason |
| yes | on | accepts | one | `sent` | `report_delivered` |
| yes | on | rejects or throws | none | `failed` + error | `report_delivery_failed` |

## 8. Numerical examples

1. Monthly, day 1, 07:00, `America/Toronto`, created 2026-09-30 15:00
   local: `next_run_at` = 2026-10-01T07:00-04:00 = 2026-10-01T11:00:00Z.
   The 11:05Z tick claims it; `runDateYmd` 2026-10-01; `last_month` =
   2026-09-01 .. 2026-09-30; the next `next_run_at` = 2026-11-01T07:00-04:00
   (DST ends 2026-11-01 at 02:00, so this is 11:00Z, and December's is
   12:00Z).
2. Spending by Category for that range returns `totalSpending: null`,
   `knownSpending: 2,410.55`, `missingCurrencies: ["USD"]`: the card prints
   "2,410.55 CAD counted; USD rows could not be converted (no USD->CAD rate
   in September)" and the table lists every category with its known figure.
3. Weekly, Monday, 06:30, `Europe/Berlin`, `last_week`, `week_starts_on` 1:
   run 2027-01-04T06:30+01:00; range 2026-12-28 .. 2027-01-03.

## 9. Missing-data policy

- A report whose total is null: RDEL-004; the email never prints a 0 for an
  unknown.
- The report's own `excludedCount`: a banner "N transactions were left out
  because their currency could not be converted", the page's copy.
- An adapter that throws (a report bug): `failed`, the error bounded, the
  in-app row; the cron continues with the next schedule.
- A user with no email address on file: `skipped`, reason "no email
  address", in-app row.
- A deleted saved report (phase 2): the schedule is disabled with
  `last_run_error` "report no longer exists".

## 10. Frontend structure

- `frontend/src/components/reports/ScheduleReportButton.tsx` and
  `ScheduleReportModal.tsx`: on `ReportDetailHeader` when the id is in
  `GET /report-schedules/deliverable`; the modal takes name, preset,
  cadence with its day, time, timezone (defaulted), and the report's
  current params (accounts, bucket, ...) as the schedule's params.
- `frontend/src/app/settings/page.tsx`: a "Scheduled reports" section with
  `ScheduledReportsList.tsx`: name, report, cadence, next run (in the
  schedule's timezone), last status with the error, enable toggle, Send now,
  edit, delete.
- `frontend/src/lib/report-schedules.ts`: `reportSchedulesApi`;
  `frontend/src/types/report-schedule.ts`.
- Notification copy for the two types in `useNotificationCopy`; the `REPORTS`
  category in `frontend/src/lib/notification-preferences.ts` and the matrix.

## 11. Test matrix

| Area | Cases |
|---|---|
| Cadence | `nextRunAt` for each cadence from a given instant; DST transitions both ways; day 28 in February; `month_of_year` for yearly; timezone validity |
| Range (RDEL-003) | truth table A, every cell; `week_starts_on` 0 and 1; leap day |
| Claim (RDEL-001) | two connections, one schedule due: one composes; a disabled schedule never claims; a schedule claimed advances before the adapter runs |
| Adapters | each of the 16 maps its response to a model; the guard refuses a repository import (RDEL-002); unknown totals carry reasons (RDEL-004); `paramKeys` validation (RDEL-007) |
| Renderer (RDEL-005) | a payee `<b>x</b>` escaped; numbers in `de-DE`; labels in `fr`; 51 rows -> 50 + "and 1 more"; the live link carries the range |
| Outcomes (RDEL-006) | truth table B, every row; the error bounded to 1024 |
| Send now | rate limit 3 per hour by claim; does not advance `next_run_at`; composes the same model as the cron for the same run date |
| Limits | 21st schedule refused inside the transaction and nothing written |
| Restore | `next_run_at` recomputed after a backup restore (no past period fires) |
| RLS and backup | direct bucket; export round-trip; support-backup golden |
| Frontend | button only for deliverable ids; modal validation; settings list with each status; Send now feedback; notification copy and target contract tests |
| E2E | schedule Spending by Category, Send now, see the in-app notification (the E2E stack has no SMTP: assert `skipped` with its reason) |

## 12. Explicit v1 scope cuts and later phases

- **No PDF and no chart in v1** (decision 2). Phase 3 is a dependency
  decision for the maintainer: a server PDF needs `pdfkit` (tables and
  cards, no chart) or a headless browser (the page as the user sees it,
  heavy). The adapter model is the input either way; nothing in v1 is
  thrown away.
- **Custom and investment reports are phase 2**, after two defect fixes
  that are their own PRs and are reported here, not fixed in passing:
  `ReportsService` sums raw amounts across currencies with no completeness
  flag, and `ReportsService.getDateRange` reads the server clock. A
  scheduled run of a report that cannot say its currency is not honest.
- **The 30 browser-composed built-in reports** gain adapters one at a time
  as their logic moves server-side; each is its own small task once the
  registry exists. They are not in this plan's task list.
- **No delegate access** (decision 11).
- **No per-schedule recipient list**: the email goes to the user's own
  address. Sending a report to an accountant is the Shared Access feature's
  job.

## 13. Open questions

- **R1.** At-most-once (this plan) or at-least-once with a lease and a
  delivery record (the bill-reminder pattern)? This plan argues a report is
  not a reminder: a duplicate is worse than a recorded miss with a Send now.
- **R2.** Should the `REPORTS` category's email default be on? This plan
  says on: the schedule itself is the opt-in.
- **R3.** Should the email embed the table at all, or only the summary cards
  and the link? This plan says both, bounded to 50 rows.

## 14. Companion task list

[`scheduled-report-delivery-tasks.md`](./scheduled-report-delivery-tasks.md).
