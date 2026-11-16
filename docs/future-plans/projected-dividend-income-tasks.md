# Projected Dividend Income: Agent Task List

> Companion to [`projected-dividend-income.md`](./projected-dividend-income.md) (the design). One task per session/PR, in dependency order. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note instead.
- **The governing invariants apply to every task:** a projection never writes (DIV-001), the quantity is the replay's (DIV-002), a provider value never overwrites a manual one (DIV-003), and every provider call goes through the breaker (DIV-006). A task that queries `holdings` directly, calls `fetch`, or writes a `securities` row without the `dividend_manual = false` predicate is off the plan.
- **Every figure is the server's.** The card, the widget and the AI tools format the response; none of them lays a schedule, infers a frequency or sums across currencies.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `TZ=UTC npm run test:unit -- --coverage`; plus `npm run build && npm run test:integration` when a query, an entity or a migration changed; `npm run migration:lint` when a migration changed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:cov`, `npm run build`.
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q3, once, at acceptance.
  - The doc line each task names lands in the same PR.
- **Terminology:** "the design" = `projected-dividend-income.md`; section references point there. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships columns, a table, a fetch or endpoints that change nothing a user sees until the card lands (or until the cron first runs, which writes dividend facts only). |
| **neutral** | Rewrites a live code path (an optional method on the provider interface, an additive DTO field). Designed behaviour-preserving. |
| **live** | The cron starts calling Yahoo for one more module per held security; bounded by the lease, the batch size and the breaker. |

B3 is the only task that adds provider traffic. Its acceptance names the bound (100 securities per tick, 7-day staleness, breaker-gated).

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Discussion agreeing `projected-dividend-income.md`; label `approved-to-build`; V1 and V2 answered | -- | none | [ ] |
| B1 | Migration + `schema.sql`: `securities` columns, `security_dividends` with indirect RLS; entities; backup classification; support-backup rules | S1 | inert | [ ] |
| B2 | `YahooFinanceService.fetchDividendProfile` / `fetchDividendEvents`; `QuoteProvider` optional methods; `supportsDividends`; `dividend-frequency.util.ts` | S1 | neutral | [ ] |
| B3 | `DividendDataService` (`refreshDue`, `refreshOne`, DIV-003/004 writes), the cron, `FetchSyncJob.SecurityDividends`, `docs/cron-jobs.md` row, `POST /securities/:id/dividends/refresh`, `PATCH /securities/:id` manual fields | B1, B2 | live (bounded) | [ ] |
| B4 | `DividendProjectionService` + `GET /portfolio/projected-dividends` (design 6.4, truth tables A and B), `dividend-projection.guard.spec.ts` | B1, B3 | inert | [ ] |
| F1 | API client + types; `ProjectedDividendsCard` on the Investments page | B4 | inert | [ ] |
| F2 | `SecurityDividendCard` on the security detail with the manual form and the events table | B3 | inert | [ ] |
| F3 | `UpcomingDividendsWidget` (`defaultEnabled: false`) | F1 | inert | [ ] |
| A1 | `get_projected_dividends` on MCP and the in-app assistant over `getLlmProjectedDividends` | B4 | inert | [ ] |
| Q1 | Integration suite `security-dividends.integration.spec.ts` (RLS indirect bucket, upsert idempotency, DIV-003 predicate, backup round-trip, lease across two ticks) | B3, B4 | none | [ ] |
| Q2 | Playwright `tests/projected-dividends.spec.ts` | F1, F2, F3 | none | [ ] |
| Q3 | Full-locale i18n pass (acceptance, final commit) | all above | none | [ ] |
| D1 | Wiki Investments page section, README line, `docs/system-invariants.md` DIV-001..008, `docs/backend/securities-and-providers.md` entry | Q1 | none | [ ] |
| M1 | `DividendYieldGrowthReport` reads the server's `frequency`; the browser inference is removed | B4, D1 | neutral | [ ] (follow-up, per V2) |
| M2 | `dividends` calendar layer on `InvestmentCalendarView` | F1 | inert | [ ] (phase 2) |

---

## Task details

### S1 -- Proposal

Open a Discussion linking `projected-dividend-income.md`, summarising decisions 1-10, the two schema changes, the fetch bound and the endpoint, and asking the maintainer to answer V1 (lazy first fetch) and V2 (report migration timing). Record the answers in the design before B1 starts.

### B1 -- Schema, entities, backup

**Files:** `database/migrations/<UTC timestamp>_security_dividends.sql` (new), `database/schema.sql`, `backend/src/securities/entities/security.entity.ts`, `backend/src/securities/entities/security-dividend.entity.ts` (new), `backend/src/backup/export-table-queries.ts`, `backend/src/backup/restore-plan.ts`, `backend/src/backup/backup-format.ts`, `backend/src/backup/backup-restore-database.service.ts`, `backend/src/backup/support-backup/support-backup-rules.ts`, `backend/src/backup/support-backup/support-backup-sections.ts`, `frontend/src/lib/restore-labels.ts`, `backend/test/integration/rls-enforcement.integration.spec.ts` (the indirect map entry), `docs/row-level-security-contract.md` (one row), `docs/backup-restore-contract.md` (one row).

- Design 6.1 and 6.2 exactly; the indirect policy (`EXISTS (SELECT 1 FROM securities s WHERE s.id = security_id AND (s.user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())))`) and `ENABLE ROW LEVEL SECURITY` in the same file.
- Acceptance: `migration:lint`, `verify-schema.sh`, `check-migration-prefixes.mjs`; the RLS bucket spec; the backup coverage guard; the support-backup golden test.

### B2 -- Provider methods and the frequency rule

**Files:** `backend/src/securities/yahoo-finance.service.ts` + `.spec.ts`, `backend/src/securities/providers/quote-provider.interface.ts`, `backend/src/securities/providers/quote-provider.registry.ts` + `.spec.ts`, `backend/src/securities/dividend-frequency.util.ts` + `.spec.ts` (new), `docs/backend/securities-and-providers.md` (one entry naming the two methods and DIV-006).

- Both methods through `fetchV10` / `throttledFetch` and `readBody`; `null` on refusal or failure; GBX to GBP; the `provider-call.guard.spec.ts` stays green without an allowlist change.
- `inferDividendFrequency(events)`: decision 3 bands; pure; the band-boundary tests.

### B3 -- Dividend data service, cron, manual fields

**Files:** `backend/src/securities/dividend-data.service.ts` + `.spec.ts` (new), `backend/src/securities/securities.controller.ts`, `backend/src/securities/securities.service.ts`, `backend/src/securities/dto/update-security.dto.ts`, `backend/src/common/jobs/fetch-sync.service.ts` (`FetchSyncJob.SecurityDividends`), `backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST` if the file seeds its own context), `docs/cron-jobs.md` (one row, decorator verbatim, mechanism "lease"), `.env.example` only if a bound becomes configurable (this plan says constants).

- `@Cron("15 17 * * 1-5", { timeZone: "America/New_York" })`; `withSystemContext(() => fetchSync.withLease(...))`; keyset batches of 100 over held, Yahoo-served, not-skipped, stale securities; per security: `fetchDividendProfile`, `fetchDividendEvents` (from one year before the oldest stored event or three years back on first fetch), `verifyProviderCurrency`, the upsert, the `UPDATE ... WHERE dividend_manual = false` (DIV-003), `dividend_frequency` from `inferDividendFrequency`, `dividend_data_updated_at = NOW()`, or `dividend_fetch_error` on failure.
- `PATCH /securities/:id` manual fields set `dividend_manual = true`; the DTO uses `@ValidateIf` beside `@IsOptional()` and `ParseCalendarDatePipe`-equivalent validation for the dates.
- Acceptance: the fetch rows of the test matrix; the two-tick lease test in Q1.

### B4 -- Projection read model

**Files:** `backend/src/securities/dividend-projection.service.ts` + `.spec.ts`, `backend/src/securities/dividend-schedule.util.ts` + `.spec.ts` (pure: lay events from `next_ex_date` by frequency within the horizon; `perEventAmount`; `lag`), `backend/src/securities/dividend-projection.guard.spec.ts` (all new), `backend/src/securities/portfolio.controller.ts`, `backend/src/securities/dto/projected-dividends.dto.ts` (new), `docs/financial-semantics.md` (a "Projected dividends" section stating decisions 5-9).

- Input: `calculateHoldingsWithValues` output (DIV-002), the securities' dividend columns, `security_dividends`, scheduled occurrences from `ScheduledOccurrenceService` for the securities (decision 6), `resolveFxRate` for today, `priceAsOf` for the reinvest estimate.
- `FxAggregate` per month and for the annual total; `addUnknown()` per unknown position (DIV-005).
- Acceptance: truth tables A and B, the four numerical examples, the projection rows of the test matrix.

### F1 -- Card on the Investments page

**Files:** `frontend/src/lib/investments.ts` + `.test.ts`, `frontend/src/types/investment.ts`, `frontend/src/components/investments/ProjectedDividendsCard.tsx` + `.test.tsx` + `.mobileWrapped.test.tsx` (new), `frontend/src/app/investments/page.tsx` + `.test.tsx`, `frontend/src/i18n/messages/en/investments.json`.

- `Card`, `PartialTotal`, `IncompleteDataDetails`, `useNumberFormat()` (`formatCurrency`, `formatPercent`, `formatShareQuantity`), `chartColors.income`, `useDateFormat`; `role="progressbar"` is not needed; a table twin for the bar (the `ChartViewToggle` pattern) for screen readers.
- Unknown rows render the reason and the action (design 9). No arithmetic.

### F2 -- Security detail card and manual form

**Files:** `frontend/src/components/securities/detail/SecurityDividendCard.tsx` + `.test.tsx` (new), the security detail page component that composes the cards (locate by `SecurityPositionInfoCard`), `frontend/src/lib/investments.ts` (the client that serves `PATCH /securities/:id`), `frontend/src/i18n/messages/en/securities.json`.

### F3 -- Dashboard widget

**Files:** `frontend/src/components/dashboard/UpcomingDividendsWidget.tsx` + `.test.tsx` (new), `frontend/src/components/dashboard/widget-registry.tsx` + `.test.tsx`, `frontend/src/components/dashboard/widget-meta.tsx`, `frontend/src/i18n/messages/en/dashboard.json`.

### A1 -- AI tools

**Files:** `backend/src/mcp/tools/investments.tool.ts` + `.spec.ts`, `backend/src/mcp/tool-output-schemas.ts`, `backend/src/mcp/mcp-annotations.spec.ts`, `backend/src/mcp/tools-list-budget.spec.ts`, `backend/src/ai/query/tool-definitions.ts` + `.spec.ts`, `backend/src/ai/query/tool-input-schemas.ts`, `backend/src/ai/query/tool-executor.service.ts` + `.spec.ts`, `dividend-projection.service.ts` (`getLlmProjectedDividends`), `docs/backend/mcp.md` and `docs/backend/ai-and-payees.md` (one line each).

### Q1 -- Integration suite

**Files:** `backend/test/integration/security-dividends.integration.spec.ts` (new).

### Q2 -- E2E

**Files:** `e2e/tests/projected-dividends.spec.ts` (new).

### Q3 -- Localization pass

Every locale for `investments`, `securities`, `dashboard` and the backend keys. Final commit on the last PR.

### D1 -- Documentation

**Files:** the wiki's Investments page (a "Projected dividend income" section), `README.md` (one feature line under Investment Features), `docs/system-invariants.md` (DIV-001..008), `docs/backend/securities-and-providers.md`.

### M1 -- Report migration (follow-up)

**Files:** `frontend/src/components/reports/DividendYieldGrowthReport.tsx` + tests. Reads `frequency` from `getProjectedDividends`; the gap-based inference is deleted; a `report-locale.guard.test.ts`-style guard is not needed because the inference no longer exists on the client.

### M2 -- Calendar layer (phase 2)

**Files:** `frontend/src/store/viewModeStore.ts` (`SURFACE_LAYERS.investments` gains `dividends`), `frontend/src/components/calendar/InvestmentCalendarView.tsx` + tests, `frontend/src/store/persisted-storage.guard.test.ts` (the pinned shape changes). Its own small proposal under `docs/specs/calendar-view.md`'s decisions.
