# Projected dividend income

Design for a forward view of dividend income: for every holding, the declared
dividend (per-share amount, frequency, next ex-date and pay date) laid onto
the next twelve months, summed per month and per currency, with yield on cost
and a note of which positions reinvest. The task list is
[`projected-dividend-income-tasks.md`](./projected-dividend-income-tasks.md).

Status: **proposal**. It needs its own discussion with the `approved-to-build`
label before any task starts (`CONTRIBUTING.md`). It reports money, reads a
time series and materialises provider data, so sections 4 to 9 are the
specification `docs/financial-calculation-contract.md` section 9 asks for.

## 1. Where this comes from, and what is true today

Every dividend surface Monize has looks backwards over the ledger:
`DividendIncomeReport`, `DividendYieldGrowthReport` (which infers a payment
frequency from the gaps between past dividends, in the browser),
`InvestmentIncomePanel`, and the `dividends` field of `SecurityDetailService`.
No table stores a declared dividend, no provider call reads one
(`YahooFinanceService` reads `summaryDetail.yield.raw` only as prose for a
fund description), and the column catalogue of the investment reports says
so in its header: "dividend yield" was excluded because the quote providers
never return it. This plan adds the facts, the fetch, and one read model that
every forward surface reads.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| The current position per holding | `PortfolioCalculationService.calculateHoldingsWithValues` and `buildHoldingsByAccount` (`backend/src/securities/portfolio-calculation.service.ts`) | `quantity`, `costBasis`, `currencyCode` per holding; `pricesComplete`, `fxComplete`, `valuationComplete`. INV-HOLDING-001/002. |
| The one Yahoo door | `YahooFinanceService.fetchV10`, `throttledFetch`, `readBody` (`backend/src/securities/yahoo-finance.service.ts`) | `provider-call.guard.spec.ts` fails a bare `fetch` in `securities/`; `ProviderHealthService` gates every call (INV-PROVIDER-001). |
| Provider currency check | `refuseForeignCurrency` / `verifyProviderCurrency` (`backend/src/securities/providers/quote-currency.util.ts`) | A dividend amount is in the security's quote currency or it is refused (INV-PRICE-001 analogue). |
| Which provider serves a security | `resolveForSecurity` (`backend/src/securities/providers/quote-provider.registry.ts`), `quote_provider` on `securities` | Only Yahoo carries dividend data; LSE, Deutsche Börse and MSN do not (`docs/specs/exchange-price-providers.md`). |
| Lazy, staleness-dated metadata refresh | `SectorWeightingService.ensureSectorData`, `sector_data_updated_at`, `STALE_MS` | The pattern for `dividend_data_updated_at`. |
| The daily securities cron | `SecurityPriceService.scheduledPriceRefresh` (`0 17 * * 1-5` New York), `FetchSyncService.withLease` (`backend/src/common/jobs/fetch-sync.service.ts`) | A new `FetchSyncJob.SecurityDividends` lease; `docs/cron-jobs.md` row. |
| Investment actions | `InvestmentAction` (`backend/src/securities/entities/investment-transaction.entity.ts`): `DIVIDEND`, `REINVEST`, ... | `REINVEST` is the DRIP fact in the ledger; a projection reads it, never writes it. |
| Date stepping | `addDaysYMD`, `enumerateDaysYMD` (`backend/src/common/date-utils.ts`) | No `Date` at a boundary. |
| Convert before summing | `FxAggregate`, `resolveFxRate` | Per-currency buckets; totals null when a pair is missing. |
| Scheduled investment dividends | `scheduled-investment-actions.ts` (`backend/src/scheduled-transactions/`) | A user-entered recurring dividend is an alternative fact (decision 6). |
| Dashboard and page templates | `FavouriteSecurities.tsx`, `TopMovers.tsx`, `PortfolioPerformanceCard` on `frontend/src/app/investments/page.tsx` | The widget and the card copy their props pattern. |
| Calendar layers | `SURFACE_LAYERS.investments` (`frontend/src/store/viewModeStore.ts`), `InvestmentCalendarView.tsx` | A `dividends` layer is phase 2. |
| AI tool registries | `backend/src/mcp/tools/investments.tool.ts`, `backend/src/ai/query/tool-definitions.ts` | One read-only tool on both surfaces over one domain method. |

## 3. Product decisions

1. **Facts and projection are separate.** `security_dividends` stores
   observed dividend events (provider or ledger or manual); `securities`
   gains the declared forward data. The projection is a pure function of
   those rows plus the holdings. Nothing in the projection writes.
2. **A declared dividend is the provider's, unless the user overrode it.**
   Yahoo `summaryDetail.dividendRate` (annual, per share),
   `calendarEvents.exDividendDate` and `dividendDate` (pay date), and the
   `events.dividends` history from the chart endpoint. A manual override
   (`dividend_manual = true`) is never overwritten by a fetch (the
   INV-PAYEE-001 rule, applied to dividends) and is the only path for
   securities whose provider has no dividend data.
3. **Frequency is a fact derived once, on the server.** `inferDividendFrequency`
   over the stored events (median gap: `<= 45` days monthly, `<= 120`
   quarterly, `<= 210` semi-annual, else annual; fewer than two events:
   unknown) lives in `backend/src/securities/dividend-frequency.util.ts`.
   The browser copy in `DividendYieldGrowthReport` migrates to read the
   server's answer in a follow-up task so the two surfaces cannot disagree.
4. **"No dividend declared" is zero; "could not fetch" is unknown.** A
   successful profile fetch that carries no `dividendRate` records
   `dividend_rate = 0` with `dividend_data_updated_at` set: the security pays
   nothing and projects nothing. A failed or refused fetch leaves the row as
   it was and the projection reports the position as unknown with the reason.
   This is the "decide which of the two each branch is in" rule.
5. **The schedule is laid from the next ex-date by the frequency.** Events
   fall on `next_ex_date`, then every period after it, within the horizon.
   Each event pays `quantity x perEventAmount`, where `perEventAmount` is
   the last observed event amount when there is one dated within one period,
   else `dividend_rate / periodsPerYear`. The pay date is `ex_date + lag`,
   where `lag` is the last observed `pay - ex` in days, else 0 with the
   event marked `payDateEstimated`.
6. **A scheduled investment dividend wins for its security.** When the user
   keeps a scheduled `DIVIDEND` or `REINVEST` on a security (the GIC and
   private-fund case), its occurrences are the projection for that security
   and the provider data is ignored; the row says `source: 'scheduled'`.
   Occurrences come from `ScheduledOccurrenceService` (INV-OCCURRENCE-003),
   never expanded here.
7. **The quantity is today's.** A projection twelve months out uses the
   position held today. Nothing models future buys. The caption says so.
8. **Reinvestment is read from the ledger.** A security whose most recent
   dividend action was `REINVEST` is flagged `reinvests: true` and its events
   show the estimated shares at the latest accepted close (`priceAsOf`,
   `docs/time-series-contract.md` section 2.1), labelled an estimate. No
   per-security toggle in v1.
9. **Totals are per currency, converted at today's rate, null when a pair is
   missing.** A projected amount has no date-specific rate that is honest;
   today's `resolveFxRate` is used and the response says so. `fxComplete`,
   `dividendDataComplete` and `valuationComplete` are carried to every
   surface, including the LLM shape.
10. **The fetch is bounded and held securities only.** Daily at 17:15 New
    York on weekdays, under a `FetchSyncJob.SecurityDividends` lease, over
    securities with a non-zero holding for any user, Yahoo-served, not
    `skip_price_updates`, whose `dividend_data_updated_at` is older than 7
    days or null, in keyset batches of 100. Yield on cost needs the cost
    basis, so the fetch never runs for a security nobody holds.

## 4. Definitions

- `perEventAmount`, `lag`, `periodsPerYear` (monthly 12, quarterly 4,
  semi-annual 2, annual 1): decision 5.
- `projectedAnnual` (per holding): the sum of the events in the next 365
  days, in the security's currency.
- `yieldOnCost`: `projectedAnnual / costBasis` in the account's currency;
  null when either is null or `costBasis` is 0.
- `horizonMonths`: 12 by default, 1..24 accepted.
- `today`: `todayYMD()` under the request; echoed.

## 5. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| DIV-001 | A projection never writes a ledger row, a holding, a price or a dividend fact | `DividendProjectionService` depends on read services only; `dividend-projection.guard.spec.ts` fails an import of a writer. |
| DIV-002 | The quantity is the replay's | `calculateHoldingsWithValues` is the only source of `quantity` (INV-HOLDING-002); the projection takes `HoldingWithMarketValue[]` as input and never queries `holdings` itself. |
| DIV-003 | A provider value never overwrites a manual one | `UPDATE securities SET dividend_rate = $1, ... WHERE id = $2 AND dividend_manual = false`; the spec asserts the predicate. |
| DIV-004 | A fetched dividend is in the security's currency or it is refused | `verifyProviderCurrency` before the write; a mismatch logs through `logFailure` and leaves the row untouched. |
| DIV-005 | A total carries a value only when every held position's projection is known | `FxAggregate.addUnknown()` for an unknown position; `total` null; `knownSubtotal`, `unknownSecurityIds` with a reason each. |
| DIV-006 | Every provider call goes through the breaker | `fetchV10` / `throttledFetch` only; `provider-call.guard.spec.ts` already scans the directory. |
| DIV-007 | One fetch per tick across replicas | `FetchSyncService.withLease(FetchSyncJob.SecurityDividends, ...)`; a lost lease is a no-op. INV-CRON-001. |
| DIV-008 | A projected figure is captioned as projected and dated | The response carries `asOf` (today) and per security `dataAsOf` (`dividend_data_updated_at`); the components print both; a figure older than 30 days gets a stale badge. |

## 6. Data contracts (new and changed)

### 6.1 `securities` (additive columns)

```sql
ALTER TABLE securities ADD COLUMN IF NOT EXISTS dividend_rate NUMERIC(20,10);          -- annual, per share, security currency
ALTER TABLE securities ADD COLUMN IF NOT EXISTS dividend_frequency VARCHAR(12)
  CHECK (dividend_frequency IS NULL OR dividend_frequency IN ('monthly','quarterly','semi_annual','annual','irregular'));
ALTER TABLE securities ADD COLUMN IF NOT EXISTS next_ex_date DATE;
ALTER TABLE securities ADD COLUMN IF NOT EXISTS next_pay_date DATE;
ALTER TABLE securities ADD COLUMN IF NOT EXISTS dividend_manual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE securities ADD COLUMN IF NOT EXISTS dividend_data_updated_at TIMESTAMPTZ;
ALTER TABLE securities ADD COLUMN IF NOT EXISTS dividend_fetch_error VARCHAR(200);
```

Expand only; nothing is dropped or tightened. Backup: `securities` is
already exported; the support-backup rules keep every new column (numbers,
dates, flags).

### 6.2 Table `security_dividends`

```sql
CREATE TABLE IF NOT EXISTS security_dividends (
  id BIGSERIAL PRIMARY KEY,
  security_id UUID NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  ex_date DATE NOT NULL,
  pay_date DATE,
  amount NUMERIC(20,10) NOT NULL CHECK (amount >= 0),   -- per share, security currency
  source VARCHAR(10) NOT NULL CHECK (source IN ('yahoo','manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (security_id, ex_date, source)
);
```

Indirect RLS bucket (`EXISTS` back to `securities.user_id`), with its entry
in the spec's indirect map. Upsert on the natural key (`ON CONFLICT DO
UPDATE` for `amount`, `pay_date`), so a refetch is idempotent (INV-CRON-001
by natural key). Exported with a `RESTORE_PLAN` row after `securities`.

### 6.3 Fetch

`YahooFinanceService.fetchDividendProfile(symbol, exchange)` -> `{ rate:
number | null; exDate: string | null; payDate: string | null; currency:
string } | null` from `quoteSummary?modules=summaryDetail,calendarEvents`
through `fetchV10`; `fetchDividendEvents(symbol, exchange, fromYmd)` ->
`Array<{ exDate; amount }>` from the chart endpoint with `events=div` through
`throttledFetch`. Both return `null` on a breaker refusal or transport
failure (never throw to the caller), and both run the GBX to GBP
normalisation the quote path runs. `QuoteProvider` gains the two methods as
optional; the registry exposes `supportsDividends(provider)`.

`DividendDataService.refreshDue()` is the cron body (decision 10);
`refreshOne(securityId)` is the on-demand path behind `POST
/securities/:id/dividends/refresh` and the lazy first read (the
`ensureSectorData` pattern: a read of the projection for a security never
fetched triggers a fetch, bounded by `fetchMissing: true` only on the
investments page, never on the dashboard).

### 6.4 `GET /portfolio/projected-dividends?accountIds&months`

```ts
interface ProjectedDividendsResponse {
  asOf: string; horizonMonths: number; currency: string;   // reporting currency
  positions: Array<{
    securityId: string; symbol: string; name: string; accountId: string; accountName: string;
    quantity: number; currencyCode: string;                // security currency
    source: 'provider' | 'manual' | 'scheduled' | 'none' | 'unknown';
    dataAsOf: string | null; stale: boolean;
    frequency: 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'irregular' | null;
    perEventAmount: number | null; nextExDate: string | null;
    projectedAnnual: number | null;                        // security currency
    projectedAnnualConverted: number | null;               // reporting currency, today's rate
    yieldOnCost: number | null; reinvests: boolean;
    events: Array<{ exDate: string; payDate: string; payDateEstimated: boolean; amount: number; sharesIfReinvested: number | null }>;
    unknownReason: 'not_fetched' | 'fetch_failed' | 'provider_unsupported' | 'missing_rate' | null;
  }>;
  months: Array<{ month: string; total: number | null; knownSubtotal: number; byCurrency: Record<string, number> }>;
  totals: { projectedAnnual: number | null; knownSubtotal: number; yieldOnCost: number | null };
  fxComplete: boolean; missingRatePairs: string[];
  dividendDataComplete: boolean; unknownSecurityIds: string[];
  valuationComplete: boolean;
}
```

`PATCH /securities/:id` gains `dividendRate`, `dividendFrequency`,
`nextExDate`, `nextPayDate`, `dividendManual`; setting any of the first four
sets `dividend_manual = true`; clearing `dividendManual` lets the next fetch
overwrite.

## 7. Truth tables

### A. Per position

| holding qty | source row | `dividend_rate` | `next_ex_date` | frequency | result |
|---|---|---|---|---|---|
| 0 | any | any | any | any | not listed |
| > 0 | scheduled occurrence exists | ignored | ignored | ignored | `scheduled`, events = occurrences |
| > 0 | manual | set | set | set | `manual`, events laid (decision 5) |
| > 0 | manual | set | null | set | `manual`, events laid from today's next period boundary, `payDateEstimated` |
| > 0 | provider, fetched | 0 | any | any | `none`, `projectedAnnual` 0 |
| > 0 | provider, fetched | > 0 | set | known | `provider`, events laid |
| > 0 | provider, fetched | > 0 | set | unknown (fewer than two events) | `provider`, one event at `next_ex_date`, `projectedAnnual` = rate, `frequency: null`, flagged |
| > 0 | provider, never fetched | null | null | null | `unknown`, `not_fetched` |
| > 0 | provider, last fetch failed, no prior data | null | null | null | `unknown`, `fetch_failed` with `dividend_fetch_error` |
| > 0 | LSE / Deutsche Börse / MSN, no manual | null | null | null | `unknown`, `provider_unsupported`; the card offers the manual form |

### B. Totals

| any position `unknown` | any pair missing | `totals.projectedAnnual` | `dividendDataComplete` | `fxComplete` |
|---|---|---|---|---|
| no | no | sum | true | true |
| yes | no | null | false | true |
| no | yes | null | true | false |
| yes | yes | null | false | false |

## 8. Numerical examples

1. 120 shares of a quarterly payer, last event 0.47 CAD on 2026-07-15 paid
   2026-07-31 (lag 16 days), `next_ex_date` 2026-10-15, today 2026-09-30.
   Events: 2026-10-15 (pay 10-31), 2027-01-15, 2027-04-15, 2027-07-15, each
   `120 x 0.47 = 56.40`; `projectedAnnual` 225.60 CAD. Cost basis 9,600.00
   CAD: `yieldOnCost` 2.35%.
2. The same security with `dividend_rate` 1.90 and no observed events within
   a period: `perEventAmount = 1.90 / 4 = 0.475`, events 57.00 each,
   `projectedAnnual` 228.00.
3. A USD payer, 50 shares, monthly 0.10 USD, reporting currency CAD, USD->CAD
   1.35 today: `projectedAnnual` 60.00 USD, converted 81.00 CAD. With no
   USD->CAD rate: `projectedAnnualConverted` null, `missingRatePairs:
   ["USD->CAD"]`, `totals.projectedAnnual` null, `knownSubtotal` the CAD
   positions' sum.
4. Reinvesting position, event 56.40 CAD, latest close 31.20: `sharesIfReinvested`
   1.8077 (`formatShareQuantity` on the client), labelled an estimate.

## 9. Missing-data policy

- `unknown` positions are listed with their reason and the repair: "Refresh"
  (not fetched or failed), "Enter the dividend" (provider unsupported),
  "Add a rate for USD->CAD" (missing rate). Never 0, never omitted from the
  list.
- A stale `dataAsOf` (older than 30 days) is a badge, not an unknown: the
  figure stands, dated.
- A breaker that is open at fetch time: the cron skips the batch and the
  on-demand refresh says the provider is unavailable (INV-PROVIDER-001);
  rows keep their last data.
- A frequency of `irregular` (median gap above 400 days, or a special
  dividend pattern): one event at `next_ex_date` only, `projectedAnnual` =
  that event, flagged "irregular payer".
- The ex-date in the past at projection time (the provider has not rolled
  it): the schedule starts from the first period boundary after today and the
  position is flagged `payDateEstimated`; the next fetch repairs it.

## 10. Frontend structure

- `frontend/src/components/investments/ProjectedDividendsCard.tsx`: a grid
  row on `frontend/src/app/investments/page.tsx` after `PortfolioPerformanceCard`,
  with the page's `accountIds` / `reloadKey` / `displayCurrency` props: a
  monthly bar (`chartColors.income`), the annual total or `PartialTotal`,
  yield on cost, a table of positions with source badge, next ex-date,
  per-event amount, projected annual, reinvests, and the reason plus repair
  action for an unknown row; a Refresh button for `not_fetched` / `fetch_failed`.
- `frontend/src/components/securities/detail/SecurityDividendCard.tsx` on the
  security detail: declared data, `dataAsOf`, the manual form (`CurrencyInput`,
  a frequency `Select`, `DateInput`), and the observed events table.
- `frontend/src/components/dashboard/UpcomingDividendsWidget.tsx`: the next
  30 days' events across accounts, `titleHref="/investments"`,
  `defaultEnabled: false`, self-fetching with `months=1`.
- `frontend/src/lib/investments.ts`: `getProjectedDividends`, `refreshDividends`;
  types in `frontend/src/types/investment.ts`.
- `DividendYieldGrowthReport` reads `frequency` from the positions in a
  follow-up task (decision 3).

## 11. Test matrix

| Area | Cases |
|---|---|
| Fetch | profile with rate and dates; profile without a rate (zero, decision 4); transport failure (row untouched, error recorded); breaker open (skipped); GBX normalisation; currency mismatch refused (DIV-004); manual row untouched by a fetch (DIV-003); events upsert idempotent on refetch |
| Frequency | the four bands, fewer than two events, irregular, the band boundaries (45, 120, 210 days) |
| Projection | truth table A, every row; the four numerical examples; horizon 1, 12, 24; ex-date in the past; lag from the last event; `perEventAmount` from the last event versus the rate; scheduled occurrence precedence (INV-OCCURRENCE-003: read from `ScheduledOccurrenceService`, never expanded); quantity from the replay (DIV-002) |
| Totals | truth table B; per-currency months; today's rate used and named; `knownSubtotal` |
| Cron | lease (DIV-007) across two ticks; batch keyset; only held securities; staleness 7 days; `docs/cron-jobs.md` row verbatim |
| RLS | `security_dividends` in the indirect bucket |
| Backup | columns and the table round-trip; support-backup golden |
| AI tools | both surfaces return the same shape with `valuationComplete`; tool-count and byte-budget specs |
| Frontend | card loading / empty / positions / unknown reasons with actions; stale badge; widget renders the server's events; security card manual form sets `dividendManual` |
| E2E | hold a security with a manual dividend, see the projection on the Investments page and the widget |

## 12. Explicit v1 scope cuts

- No calendar layer on the Investments calendar (phase 2: a `dividends`
  `CalendarLayer` reading the same endpoint).
- No per-security DRIP toggle (decision 8).
- No projection of future contributions or of growth in the rate.
- No dividend-received notification (a `DIVIDEND` row is already a ledger
  event; the existing balance notifications cover cash).
- No tax treatment (eligible versus non-eligible, withholding).

## 13. Open questions

- **V1.** Should the on-demand first read fetch (lazy, like sector data) or
  should only the cron fetch? This plan says lazy on the Investments page
  only, bounded by the breaker and the staleness window.
- **V2.** Should `DividendYieldGrowthReport` migrate to the server's frequency
  inside this plan or as its own follow-up? This plan says follow-up (task
  M1), so the report is unchanged until the server's answer has shipped.

## 14. Companion task list

[`projected-dividend-income-tasks.md`](./projected-dividend-income-tasks.md).
