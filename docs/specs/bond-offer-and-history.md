# Spec: bonds on sale and the history of their terms

Status: requested by the owner on 2026-10-11 (WMP/monize#24), built with
`polish-retail-bonds.md` and `bond-series-fetch.md`.

## 1. Goal

Two read-only views over the bond catalog:

1. **On sale**: every series that can be bought today, side by side, with its
   terms and with what one bond bought today is worth at maturity under stated
   assumptions, so a reader can compare products of different lengths.
2. **History**: for each product, how the per-series terms (first-period rate,
   margin or spread, early redemption fee) changed from one sale month to the
   next.

Both read only stored reference data and the engine; neither writes, and
neither fetches from a provider on the request path (the catalog is filled as
section 4 says).

## 2. On sale

`GET /bonds/offer?countryCode=PL[&assume=<benchmarkId>:<fraction>,...]`,
any authenticated user. A series is on sale when today (the user's financial
today) lies inside its stored `saleWindow`. Per series, newest terms version:

```text
instrumentId, issuerCountryCode, issuerCode, programCode, seriesCode, currency
saleWindow       { from, to }
periodMonths, periodCount            length = periodMonths x periodCount
                                     (an ISSUE_DATE schedule: the whole months
                                     from issue to maturity, at least 1, x 1;
                                     display only for such a schedule)
lengthDays       number | null       the exact days from issueDate to
                                     maturityDate (a 4-week bill is 28) for an
                                     ISSUE_DATE schedule; null for a schedule
                                     counted in months (LOT_PURCHASE_DATE)
rateRule         the description of polish-retail-bonds.md 2.6 (type,
                 benchmarkId, first-period rate or annual rate, addend, floor)
capitalization   NONE | COMPOUND_AT_PERIOD_END
redemption       the terms' redemption policy (window, penalties, floor) | null
termsSource      { provider, url, document }
projection       the valuation of one bond bought today, held to maturity:
  maturityValue        per bond | null, plus every coupon of a coupon bond
                       (the total cash received, not reinvested)
  totalReturn          (cash received - price paid) / price paid | null
                       (price paid as for annualizedReturn)
  annualizedReturn     the yearly rate r with (1 + r)^years = cash / price,
                       to 4 places | null; price is the face value, or the
                       issue price of a discount bill; years = periodMonths x
                       periodCount / 12 for a month schedule and
                       lengthDays / 365 for an ISSUE_DATE schedule (actual
                       days over a 365-day year, the convention the bill's own
                       length needs: a 28-day bill is not a 1-month one)
  projected            true when any period's rate is assumed
  assumptions          [{ benchmarkId, value, basis: SUPPLIED | LATEST_OBSERVATION }]
  projectionMissing    as in polish-retail-bonds.md 2.6
```

The projection is computed by the engine's own `valueBondLot` on a lot of
quantity 1 dated today, with the same assumption rules as the scenarios
(polish-retail-bonds.md 13.3): an assumption replaces only future periods,
known periods stay known, and without an assumption the latest observation is
used and labelled. Coupons of a coupon bond are summed from the lot's cash
flows, not reinvested; the column says "coupons not reinvested".
`annualizedReturn` is found by bisection on exact decimals (no floating
point), stopped at 4 places; it is a comparison figure, labelled as such.

The figures are null when the engine cannot value the lot, never a guess;
`projectionMissing` says why.

## 3. History

`GET /bonds/history?countryCode=PL&programCode=EDO` (programCode optional),
any authenticated user. Every stored series of the program, ordered by the
start of its sale window:

```text
seriesCode, saleWindow { from, to }, firstPeriodRate | annualRate, addend,
fee (FIXED_FEE_PER_UNIT amount | null), proceedsFloor appliesTo | null,
termsVersion, termsSource
```

The history is as complete as the catalog: the response carries
`coverage: { from: YYYY-MM | null, to: YYYY-MM | null, missingMonths: [YYYY-MM] }`
for the program, so the view says which months are absent instead of drawing
a line across them.

## 4. Backfill

The history is filled by `BondSeriesService.backfillHistory`: from the earliest
month the adapter's templates are validated for (`seriesValidFrom`; Poland:
`2024-01`) to the current month, for each product and sale month it takes the
adapter's series code (`backfillCodes`, `bond-series-fetch.md` 4.1) and fetches
every series that is not stored, with `BACKFILL_GAP_MS` (3 seconds) before each
request. It only ever asks for series that are not stored, so a rerun is
idempotent. Two callers:

- the daily series cron (`docs/cron-jobs.md`), unbounded and oldest month first,
  only for the programs a security has switched `bond_auto_fetch` on for, under
  the `bond-series` `FetchSyncService` lease; on `SOURCE_UNAVAILABLE` it ends
  that adapter's pass and the next day's run resumes;
- a linked security's Refresh (`fetchProgramOffer`,
  `bond-program-securities.md` 2.5): at most `PROGRAM_BACKFILL_CHUNK` (8)
  missing series of the program, newest month first, each taking a
  `bond-series-attempt:<country>|<code>` lease for `BACKFILL_ATTEMPT_INTERVAL_MS`
  (24 hours).

A series the source does not publish (`SERIES_NOT_PUBLISHED`, a product not sold
that month) is shown by the history as a missing month. The cron asks for it
again on its next run; a Refresh asks again only after the attempt lease has
expired. No table records them: the attempt lease is a `fetch_sync` row.

## 5. Views

There is no standalone page. Both views live on the detail page of a
program-linked bond security (`bond-program-securities.md` 3.4), fixed to that
security's bond kind, and the data they read reaches the catalog through the
security's Refresh (the cron for an auto-fetch program and the purchase form's
fetch fill it as well); there is no "fetch the current offer now" action.

- **On sale** ("On sale now", a card on the Overview tab, `BondOfferTab`): one
  row per series with the section 2 columns; assumption inputs for each
  benchmark the rows read (CPI, reference rate), prefilled with the latest
  observation and its month; sorting by annualized return, length or
  first-period rate; a "projected" badge on any figure that rests on an
  assumption; the link to the terms' source document. Only the series of the
  security's own program are listed.
- **History** (the "Terms history" tab, in place of "Price history";
  `BondHistoryBody`): a line chart per sale month of the first-period rate and
  the margin or spread (percent) with the series held marked, and a step chart
  of the fee; the months the catalog lacks listed and shown as gaps; below, a
  table of every series grouped by year, the series held highlighted.

Every figure is localized by the reader's number preference; every string is
translated in every locale.

## 6. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| On sale | unit | a 28-day and a 182-day discount bill: `lengthDays` 28 and 182, `annualizedReturn` over days / 365 on the issue price, `lengthDays` null for a month schedule; a series inside, before and after its window; newest version used; projection equals the engine's maturity value of a 1-bond lot; coupon bond sums coupons; annualized return of E1 (TOS 4.40% for 3 years compounding) is 0.0440; null figures with projectionMissing when no observation and no assumption |
| On sale | integration | owner-agnostic read of reference data; `assume` parsing reuses the scenario pipe |
| History | unit | ordering by sale window; fee and floor per series; coverage and missing months |
| Backfill | unit | derives codes per product and month from validFrom; skips stored series; one request per 3 s; stops on SOURCE_UNAVAILABLE |
| Backfill | integration | a rerun after a complete run fetches nothing |
| Views | unit | sorting, projected badge, assumption inputs re-query, gaps in the history chart, translations present |
