# Scheduled-investment FX rate: currency-pair provenance (issue #1167)

Status: implemented. Supersedes the deferral note in
`docs/future-plans/scheduled-investment-fx-currency-pair.md` (the #1154 follow-up).

## The defect

A scheduled investment can persist an FX rate that converts the security's
currency into the settlement account's currency. That rate is a single scalar
(`NUMERIC(20, 10)`) with **no record of the currency pair it was resolved for**.
If the referenced security's `currencyCode` or the settlement account's
`currencyCode` changes *after* the rate was stored -- with the id unchanged --
the stored scalar silently becomes a rate for a pair that no longer applies. A
later posting then converts the cash at a rate that answers a question nobody is
asking anymore, so the posted cash and the account balance are wrong (about the
size of the FX move -- ~11% in the reported EUR->USD example).

This is a financial-correctness defect, not merely a consistency one, but nothing
corrupts at the moment the currency is edited: it materializes only on a later
scheduled posting. It is the residual edge left by issue #1154, which re-resolves
the rate when the *schedule's own* settlement structure changes (account,
security id, funding account) but cannot see a currency change made on the
referenced security or account row.

## The three persistent rate surfaces (all covered)

1. `scheduled_transactions.investment_exchange_rate` -- the parent schedule's rate.
2. `scheduled_transaction_splits.investment_exchange_rate` -- an embedded
   investment split's per-split rate.
3. Occurrence override -- the `exchangeRate` inside an override's
   `splits[*].investment` jsonb payload.

## The fix: persist the pair, self-verify at posting (the "durable" option)

Store the rate's from/to currency codes beside each rate, so the posting path
self-verifies. This makes the rate self-describing and removes the need for any
external write path (a security edit, an account edit) to remember to invalidate
it.

- **Provenance** = `{ from, to }` = `(source currency, settlement currency)` where
  `source currency` is the security's `currencyCode` (or, for a security-less
  action, the investment account's `currencyCode`) and `settlement currency` is
  the funding account's `currencyCode` for a BUY/SELL that names one, otherwise
  the brokerage's linked cash account's `currencyCode`.
- The pair is derived in **exactly one place**:
  `InvestmentTransactionsService.resolveSettlementCurrencyPair`, which
  `resolveCashExchangeRate` (the posting-time resolver) also uses -- so the pair
  a rate is validated against is byte-identical to the pair it would be resolved
  for.

### Storage

- Two nullable columns on `scheduled_transactions` and
  `scheduled_transaction_splits`: `investment_exchange_rate_from_currency`,
  `investment_exchange_rate_to_currency` (`VARCHAR(3)`).
- Two optional keys inside the override jsonb `investment` object:
  `exchangeRateFromCurrency`, `exchangeRateToCurrency`.
- Provenance is **derived server-side** whenever a rate is stored, never accepted
  from the request DTO. When the rate is cleared (settlement-basis change per
  #1154, a mode switch, an explicit null), the provenance is cleared with it --
  the pair travels with the rate as one tuple, never separately.

### Validation at posting

For each surface, before forwarding a stored rate into the posting resolver:

- If the stored rate has provenance and the provenance **matches** the current
  pair -> forward the stored rate (the fast path, a legitimate cross-currency
  rate reused).
- If the stored rate has provenance and it **does not match** -> treat the rate
  as absent and forward nothing, so `resolveCashExchangeRate` re-resolves a fresh
  rate for the current pair.
- If the stored rate has **no provenance** (a row written before this change) ->
  it is *unknown*, not *current*, so it is also treated as absent and
  re-resolved. A scalar that cannot be proven to describe the current pair must
  never be applied to it -- consistent with the codebase rule that `null`/unknown
  is never silently substituted for a settled value. If no current rate can be
  resolved, the posting fails loudly (the resolver throws `exchangeRateUnavailable`)
  rather than committing a rate for an unknown pair. Every rate the app writes
  *after* this change carries its pair, so the only unprovenanced rows are ones
  that predate the migration; no backfill is attempted, because deriving the pair
  in SQL would be a second, drift-prone copy of the derivation this contract keeps
  in one place.

## The forecast consumes a resolved rate, never the stored scalar

The cash-flow forecast must agree with what a later posting will do, so it must
not project with the persisted `investmentExchangeRate` (which may be stale for
the current pair) nor default a missing rate to `1`. The stored scalar and a
rate safe to project with *now* are two different things.

- The FX resolution used by posting is factored into
  `InvestmentTransactionsService.resolveCashExchangeRateOrNull`, which returns
  `number | null`: same pair derivation and rate path as posting, but a genuine
  cross-currency pair with no determinable rate returns `null` instead of
  throwing. `resolveCashExchangeRate` (the posting entry) wraps it and turns
  `null` into the `exchangeRateUnavailable` `BadRequestException` -- so posting
  still refuses loudly, and the forecast reads `null` directly.
- The scheduled read model (`findAll`) attaches a read-only
  `investmentForecastExchangeRate: number | null` per investment schedule,
  resolved through that path with **no supplied rate** and the schedule's own
  settlement tuple. `1` for same-currency, a resolved rate for a cross-currency
  pair, `null` when the current rate is unknown. It never reads or overwrites the
  persisted `investmentExchangeRate`.
- `frontend/src/lib/forecast.ts` uses only `investmentForecastExchangeRate`. A
  resolved number converts the projected cash impact; `null` (a genuine
  cross-currency occurrence with no current rate) makes the projection unknown
  and withholds the whole cumulative series through the existing
  `missingCurrencies` mechanism -- the same treatment as a missing
  display-currency rate. Same-currency is `1`, so it is never mistaken for
  missing.

The round trip the tests pin: stored `EUR->CAD = 1.50`, the security's currency
changed to USD, the current `USD->CAD = 1.35`, a `10 x 100` occurrence -> the
forecast projects `1,350` and posting commits `1,350`, never `1,500`; and when
`USD->CAD` is unavailable, the forecast shows the projection as unavailable while
posting refuses -- neither surface uses the stale `1.50` or a `1` fallback.

### Embedded investment splits settle end-to-end at the effective rate

An embedded split-investment schedule (an ordinary split parent carrying an
investment split line) has no single settlement rate -- each investment line
settles its own security's currency -- so the read model exposes an effective
*total* rather than a rate, and posting recomputes each split's cash amount:

- **Posting** (`postOccurrence`, all three surfaces -- inline, override, base
  scheduled splits) resolves each investment split's cash amount through
  `resolveEffectiveSplitCash`: the stored rate when its recorded pair still
  matches, otherwise a freshly resolved one, and the split's cash `amount` is
  `investmentSplitCashAmount(action, qty, price, commission, effectiveRate)` --
  the single definition of that figure, shared with
  `createEmbeddedForSplit`'s consistency check. The parent amount is then
  re-summed from the recomputed split amounts (`validateSplitAmountSum` would
  otherwise refuse the post). An unresolvable cross-currency pair throws
  `exchangeRateUnavailable`, so posting refuses rather than committing a stale
  amount or throwing `embeddedSplitAmountMismatch`.
- **The read model** (`findAll`) attaches a read-only
  `investmentForecastAmount: number | null` for split-investment schedules: the
  base splits re-summed with each investment line's current effective rate
  (`resolveInvestmentForecastSplitAmount`), or `null` when any line's current
  rate is unknown. Non-split and non-investment-split schedules get `null` and
  are unaffected.
- **The forecast** (`frontend/src/lib/forecast.ts`) projects
  `investmentForecastAmount` for a split-investment schedule instead of the stale
  stored `amount`; a `null` withholds the whole cumulative series through
  `missingCurrencies`, the same treatment as an unknown parent-investment rate.

Because posting emits `investmentSplitCashAmount(..., effectiveRate)` and
`createEmbeddedForSplit` recomputes `expected` from the same function against the
same forwarded rate, the two halves of the split cannot disagree by construction;
`test/integration/scheduled-investment-split-fx.integration.spec.ts` proves it
across `create -> createSplits -> createEmbeddedForSplit` and proves a stale
amount is refused there rather than written.

## Invariants

- **A stored rate that carries provenance is reused only for its own pair.** A
  provenance mismatch forces re-resolution; the stale scalar is never applied.
- **The pair travels with the rate.** Clearing the rate clears the provenance;
  storing a rate stores the provenance for the settlement tuple being written.
- **One pair derivation.** `resolveSettlementCurrencyPair` is the sole definition
  of `(source, settlement)`; `resolveCashExchangeRate` consumes it, and a guard
  test (`investment-transactions.service.spec.ts`) keeps the resolver delegating
  to it.
- **Every posting surface re-resolves, including inline (F5-1).** The manual Post
  dialog resends the scheduled/override splits as inline `postDto.splits`, echoing
  the persisted rate and its provenance. An inline investment split is routed
  through the same effective-rate path as the stored surfaces -- reused only when
  its echoed pair still matches, otherwise re-resolved; an inline split with no
  provenance is re-resolved, never trusted. The frontend carries the provenance
  through `toSplitRows`/`toOverrideSplits` so the round-trip is checkable.
- **Provenance carry-forward is keyed by security AND rate (F5-3).** One schedule
  can hold two investment splits for the same security at different rates; keyed by
  security alone the second overwrites the first, so a resent-unchanged rate that
  lost the collision is mis-stamped with the current pair. `provenanceKey(securityId,
  rate)` keys both the store and the lookup, so each tuple keeps its own pair.
- **A split's FX provenance is decided by stable identity, not by value (F4).** The
  value key still collides when a rate is *changed* to exactly another split's old
  value. Every split carries a stable id (scheduled splits from the DB, override
  splits server-generated), the client echoes it as `sourceSplitId` on edit/post,
  and the server correlates the incoming split to its source row by id: an unchanged
  rate carries the source's pair, a changed one stamps the current pair. The value
  key remains only as the fallback for a client that echoes no id.
- **A user-edited inline rate is honoured, an echoed one is not trusted (F2).** At
  the manual Post dialog, a rate whose value differs from its source split's is a
  fresh rate for the current pair -- reused, not re-resolved -- while an unchanged
  echoed rate goes through the stale-check. The two are told apart by `sourceSplitId`
  identity, so dropping the echoed provenance in the rate editor no longer loses the
  user's figure. The rate editor also preserves the recorded pair across field edits
  as defence in depth.
- **Overrides forecast their own effective total (F5-2).** A per-occurrence override
  carrying investment splits is FX-sensitive too; its stored `amount` is a stale
  snapshot. The read model attaches `investmentForecastAmount` to each override, and
  the forecast projects that (or withholds the occurrence when unknown) rather than
  the override's scalar -- covering both an override that replaces an investment base
  occurrence and one that introduces investment splits over a plain base.
- **The split identity metadata is opt-in, never in the ordinary serializer (R7-F1).**
  `sourceSplitId` is scheduled-transaction correlation metadata and exists only to let
  the server decide provenance by identity (F4). The ordinary-transaction
  `CreateTransactionSplitDto` does **not** declare it, and the global ValidationPipe
  runs `forbidNonWhitelisted`, so a shared serializer that emitted it unconditionally
  would make the API reject every ordinary split edit and duplicate with a 400. The
  shared serializer (`toCreateSplitData`) therefore emits it only under an explicit
  `{ includeSourceIdentity: true }`, which **only** `ScheduledTransactionForm` passes;
  the ordinary `TransactionForm` calls it without the option and its payload carries no
  `sourceSplitId`. A DTO-level contract test runs the ordinary payload through the real
  production pipe in both directions.
- **A legacy no-provenance rate stays unknown across an edit -- no re-bless (R7-F2).** A
  rate stored before this change carries a null pair and is *unknown*, not *current* --
  and that is true across a presentation-only edit, not only at posting. A cosmetic edit
  that resends such a rate unchanged (correlated by `sourceSplitId`) preserves the null
  pair exactly; it is never re-derived to the current pair, which would re-bless a stale
  scalar as belonging to a pair it may not describe -- the original #1167 corruption,
  arriving through the edit path instead of the currency-change path. Identity therefore
  exists independently of provenance: `byId`/`oldById` include null-pair rows, so an
  unchanged legacy scalar is recognised as unchanged rather than treated as fresh and
  stamped. A supplied-but-unmatched `sourceSplitId`, and a legacy override JSON line with
  no id at all, are unverifiable claims: both are left unprovenanced (re-resolved at
  posting), never value-key-matched into a pair and never stamped with the current one. A
  genuinely *changed* legacy rate is a fresh rate for the current pair and does stamp it.
- **Only a server UUID is source identity; a synthetic React key never is (R8-F1).** An
  override JSON split written before F4 has no `id`, so the editor gives it a synthetic
  React key (`override-N`). That key is UI-only: it must never become `sourceSplitId`,
  or the DTO's `@IsUUID` rejects the edit with a 400 (making every pre-existing split
  override uneditable after deploy) and a UI-only value would masquerade as a persistent
  id. `toSplitRows` copies `id` into `sourceSplitId` only when it is a real UUID;
  everything else stays undefined ("new/unidentified line"). Migration 163 backfills a
  stable UUID into every existing override JSON split lacking one -- identity only, no FX
  provenance inferred -- so real continuing lines carry a real id the frontend can echo.
- **`sourceSplitId` absence is not overloaded between "new" and "legacy" (R8-F2).** A line
  with no `sourceSplitId` is ambiguous: a genuinely new line the user just added, or a
  legacy row an older client resent without one. Stamping the current pair on it re-blesses
  a possibly-stale scalar (the #1167 corruption via an old client); leaving it unprovenanced
  loses a genuinely new line's explicit rate. The client disambiguates with `rateExplicit`:
  the serializer sets it for a new investment line (no source identity), so the server
  stamps the current pair and posting honours the rate; an unmarked line with no
  `sourceSplitId` (older client, or legacy row) is never stamped -- a still-complete pair is
  carried by value if the exact security+rate tuple is recognised, otherwise it is left
  unprovenanced and re-resolved at posting. `rateExplicit` also resolves the same-value
  re-entry edge on a *matched* line: a rate re-entered for a changed pair that happens to
  equal the old value is stamped current rather than preserved stale. The field is
  scheduled-only and opt-in in `toCreateSplitData`, so it never leaks into ordinary
  transactions (same rule as `sourceSplitId`, R7-F1).
- **One provenance decision, four write paths (R9-F1).** `createSplits`,
  `updateOverride` and `createOverride` all decide provenance through a single
  `decideSplitProvenance`, so the rule cannot drift between them. In particular
  `createOverride` decides against the *base scheduled splits* as the source: a new
  occurrence override that inherits a base split unchanged keeps the base pair --
  including a stale one, caught at posting -- rather than re-stamping the current
  pair onto an inherited scalar. (Moving an *existing* override's date is an
  in-place `updateOverride`, not delete+create, so that edit no longer runs through
  `createOverride` at all -- see R10-F3 below; `createOverride` here is the genuinely
  new-occurrence path.)
- **Source identity spans every split, and records the prior kind (R9-F2).** The
  `byId` map holds *every* source split's id, recording `rate: null` for one that
  carried no investment rate (a category/transfer line, or an investment line with
  no stored rate). So a category split converted to an investment line -- whose id
  the client still echoes -- is recognised as a real source with no pair to
  preserve, and its entered rate is stamped current rather than dropped as an
  unverifiable id. That is distinct from a claimed id that matches nothing, which is
  still left unprovenanced.
- **Rate intent is real per-row state, not "is this row new" (R9-F2).** `rateExplicit`
  is set from `SplitRow.exchangeRateEdited` -- latched true when the user actually
  edits the FX-rate input and reset when the security changes -- in addition to the
  new-line case. So a rate re-entered on a *continuing* line for a changed pair is
  honoured even when the re-typed value equals the stale stored one (the same-value
  re-entry edge), which the derived-from-`!sourceSplitId` signal could not express.
- **A security change re-resolves the rate for the new pair; the same-currency 1
  never survives it (R9-F3).** Selecting a foreign security recomputes the rate for
  the *new* security's pair (its current market rate, or `1` only when the new pair
  is genuinely same-currency) and clears the recorded pair, instead of carrying the
  rate in force. The row started same-currency at `1`, and copying that `1` into a
  cross-currency line booked the trade unconverted (a ~26% error) which R8 then
  blessed as an explicit pair rate. When the new pair has no available rate the line
  is left unresolved (`undefined`), never `1`, so posting refuses rather than
  converting at par.
- **A null persisted rate is unknown FX; a null-rate source is stamped only with
  proven intent (R10-F1).** `toSplitRows` no longer coerces a null persisted
  investment rate to `1` (`?? 1`) -- it preserves `undefined`, so a legacy split
  with unknown FX carries no rate rather than a synthetic `1`. And the shared
  decision separates the two states that both surface as `src.rate === null`: a
  matched source that carried no investment rate (a category/transfer line, or a
  legacy investment split with unknown FX) acquires the current pair **only** when
  the incoming rate is proven fresh (`rateExplicit`); otherwise it stays
  unprovenanced and posting re-resolves. Stamping it unconditionally blessed the
  synthetic `1` as the current cross-currency rate.
- **Manual Post honours `rateExplicit` regardless of `sourceSplitId` (R10-F2).**
  The inline-post rate decision keyed its explicit-intent clause off
  `!sourceSplitId`, so a continuing row's honest edit was ignored: a same-value
  re-entry (`1.50` re-typed for a changed pair) and a category->investment
  conversion in the Post dialog were both re-resolved to market. `rateExplicit`
  now means fresh current-pair intent whether or not the row names a source; a
  rate merely changed from its source stays fresh too.
- **Moving an occurrence's date is an in-place update, not delete+create
  (R10-F3).** `UpdateScheduledTransactionOverrideDto` carries `overrideDate`, the
  override service applies it, and the editor moves a date through `updateOverride`
  (keeping the row's id and its split identities) rather than deleting the override
  and recreating it. Recreation correlated the new payload against the *base*
  schedule splits -- never the deleted override's -- so a validly pinned rate lost
  its provenance and was re-resolved. `originalDate` (the row's identity) is
  unchanged; only `overrideDate` moves, and provenance is decided against the
  existing override, so an unchanged pinned rate is preserved.
- **A parent investment rate re-entered with explicit intent stamps the current
  pair, even when its value equals the stored one (R11-F1).** The scheduled form
  resends the whole object, so on the *parent* investment rate numeric equality
  cannot tell an explicit re-entry from a passive round-trip -- and the
  no-re-bless rule (preserve the stored pair when the value is unchanged) would
  otherwise suppress a rate deliberately re-entered for a since-changed pair.
  `UpdateScheduledTransactionDto.investmentExchangeRateExplicit` is an update-only
  marker the client sets when the user actually edits the rate; the service stamps
  the current settlement pair when it is set, even for an unchanged value, and
  keeps the conservative preserve-the-stored-pair behaviour when it is absent or
  false (so a stale rate is still caught at posting rather than re-blessed). A
  genuinely changed value stamps the current pair regardless of the marker. This
  is the parent-scalar analogue of the split-line `rateExplicit` intent (R9-F2 /
  R10-F2); it is an API-contract addition -- no shipping form currently emits the
  parent `investmentExchangeRate`, so nothing is wired to send it yet.
- **Same-currency settlement resolves to 1 and dominates any explicit or stored
  scalar (R12-F1).** Provenance is a currency pair, so once a rate is stamped
  against an `X -> X` pair (a security whose currency changed to the settlement
  currency, then an explicit re-entry, or a legacy row), `from === to` matches
  the current pair and the "pair still current" reuse would otherwise forward a
  non-1 scalar -- posting `10 x 100 x 1.50 = 1,500 CAD` where the correct cash is
  `1,000 CAD`. The invariant is enforced at the two read chokepoints so it holds
  for every row regardless of what was persisted: `resolveCashExchangeRateOrNull`
  derives the pair *before* honouring a supplied rate and returns `1` for
  same-currency (covering ordinary investment create and posting), and
  `storedInvestmentRateIsCurrent` returns `false` whenever the current pair is
  same-currency, so every scheduled effective-rate path (parent forecast, embedded
  split, override, inline, post) re-resolves through that resolver to `1` rather
  than reusing the stored scalar. A stored rate that genuinely is `1` gets the
  identical result. Write paths are deliberately left to persist whatever the
  stamp produced: the guarantee is at consumption, so no write path -- present,
  legacy, or future -- can violate it.

## Test matrix (regression obligations)

For each of the three surfaces:

1. **Stale pair re-resolves.** Store a rate with provenance for pair A; change the
   security (or settlement account) currency so the current pair is B; post; assert
   the posting resolver was called to produce a fresh rate for pair B, and the
   stale scalar was not forwarded.
2. **Matching pair reuses.** Store a rate with provenance for pair A; post with the
   pair still A; assert the stored rate is forwarded (no re-resolution).
3. **Legacy row (no provenance) is re-resolved.** A stored rate with null
   provenance is unknown, not current, so it is dropped and re-resolved at
   posting (never forwarded unchanged).
4. **Store-time provenance.** Creating with a supplied rate records the from/to
   pair; clearing the rate (settlement-basis change, mode switch) clears the
   provenance. A presentation-only edit that leaves the rate and its settlement
   pair unchanged preserves the existing provenance (parent: value-difference;
   split/override: the old pair is carried forward per security), so a still-valid
   stored rate keeps working while a since-changed pair is still caught at posting.

5. **Embedded split re-resolves end-to-end.** For an embedded split-investment
   schedule with a stale-provenance rate, post; assert the split's forwarded rate
   and cash amount are the re-resolved (effective) ones, the parent amount is the
   re-summed total, and an unresolvable pair refuses the post before any write.
   The forecast half: assert the read model's `investmentForecastAmount` is the
   effective total (not the stale stored `amount`), and `null` for an unresolvable
   line, and that `forecast.ts` projects the effective total / withholds on `null`.

6. **Inline post re-resolves (F5-1).** Post an inline split echoing a stale rate +
   its provenance; assert it re-resolves and the parent is re-summed. Post an inline
   split whose provenance still matches; assert the rate is honoured with no
   re-resolution. Post an inline split with a bare scalar (no provenance); assert it
   is re-resolved, never trusted. A frontend test asserts `toSplitRows` ->
   `toOverrideSplits` carries the provenance so the round-trip is possible at all.

7. **Multiple same-security splits keep distinct provenance (F5-3).** Two splits for
   one security at different stored rates; change the security currency; cosmetic
   edit resending both rates unchanged; assert neither is re-stamped with the current
   pair (both keep their original pair, so posting still catches both as stale).

8. **Override forecast parity (F5-2).** An investment override replacing an investment
   base occurrence, and an override introducing an investment split over a plain base:
   assert the forecast projects the override's `investmentForecastAmount` (not its
   stale scalar, not the base), and withholds the series when the override's rate is
   unknown.

9. **Stable identity, changed-to-collide rate (F4).** Two same-security splits; change
   one's rate to exactly the other's old value; assert -- correlating by `sourceSplitId`
   -- the unchanged one keeps its pair and the changed one stamps the current pair.

10. **User-edited inline rate honoured (F2).** Post an inline split whose rate differs
    from its source split's, with the echoed provenance dropped; assert the edited rate
    is honoured for the current pair (not re-resolved to the market), recognised by
    `sourceSplitId`. A frontend test asserts the source id round-trips through
    `toSplitRows` -> `toOverrideSplits`.

11. **Parent forecast reuses a valid pinned rate (F1).** A schedule with a valid pinned
    rate whose pair still matches forecasts that rate (what posting reuses), not the
    current market rate; a stale one falls back to the resolved rate.

12. **Top-level investment override forecast (F3).** An override changing
    quantity/price/total projects the override's effective cash amount, not the base.

13. **Ordinary split serializer omits sourceSplitId (R7-F1).** Run the ordinary
    split-edit payload (the serializer's output with no `includeSourceIdentity`)
    through the real production ValidationPipe and assert it is accepted; run the same
    payload with a `sourceSplitId` added on an ordinary split and assert the pipe
    rejects it (`forbidNonWhitelisted`). A frontend test asserts `toCreateSplitData`
    omits `sourceSplitId` by default and includes it only under
    `{ includeSourceIdentity: true }`.

14. **Legacy null-pair rate kept unprovenanced on a cosmetic edit (R7-F2).** For a
    scheduled split and for an override JSON line, start from a pre-migration rate
    (`1.50`, null pair); perform a name/date-only edit that resends the rate unchanged;
    assert the rewritten split still has a null pair and the pair resolver was not
    called; then post at the current pair (`USD->CAD = 1.35`, `10 x 100`) and assert
    `-1,350`, never the stale `-1,500`. Companion: a genuinely changed legacy rate
    stamps the current pair.

15. **Source identity is UUID-only (R8-F1).** `toSplitRows` copies a real UUID `id`
    into `sourceSplitId` but drops a synthetic `override-N`/`temp-` key (assert both).
    The override DTO, run through the real production pipe, accepts an absent or UUID
    `sourceSplitId` and rejects a non-UUID one. Migration 163 backfills a UUID into an
    id-less override JSON split (verified against Postgres: order preserved, existing
    ids kept, re-run is a no-op), assigning identity without inferring FX provenance.

16. **`sourceSplitId` absence is not overloaded (R8-F2).** An unmarked line with no
    `sourceSplitId` (older client / legacy row) is never stamped -- a legacy null-pair
    scalar resent this way keeps its null pair and the pair resolver is not called
    (assert both), so posting re-resolves. A new line marked `rateExplicit` (no
    `sourceSplitId`) is stamped with the current pair, so posting honours its rate
    (`1.37`, not the `1.35` market) -- covering the reviewer's `-1,370` vs `-1,350`
    override repro. A *matched* line re-entered unchanged but marked `rateExplicit` is
    stamped current, not preserved stale (the same-value re-entry edge). The serializer
    sets `rateExplicit` only for a new investment line and only under the scheduled
    opt-in, so it never reaches an ordinary transaction.

17. **createOverride inherits, never re-blesses (R9-F1).** Base scheduled split stored
    `EUR/CAD 1.50`; the security's currency becomes USD; create a date-only override
    that resends the base split unchanged (naming its id). Assert the persisted
    override split keeps `EUR/CAD` (not `USD/CAD`) and the pair resolver was not
    called, so posting produces `-1,350`, never `-1,500`. Break-on-purpose confirms
    the guard fails when the shared preserve branch is made to stamp.

18. **Converted category->investment keeps its entered rate (R9-F2).** A base
    category split's id is resent as `sourceSplitId` with a new investment rate
    (`1.37`); assert the current pair is stamped (not dropped as unverifiable), on
    both `createOverride` and `update`. Break-on-purpose confirms the guard fails when
    `byId` stops recording non-investment ids.

19. **Security change never carries the stale 1 (R9-F3).** Component-level: a new
    investment split on a CAD account, no security yet (rate 1); select a USD security
    with a mocked `USD/CAD = 1.35`, quantity `10`, price `100`; assert the emitted
    rate is `1.35` and amount `-1,350`, never `1` / `-1,000`, the recorded pair is
    cleared, and `meta.securityChanged` is set. Unavailable-rate variant: the line is
    left `undefined` (not `1`) and the amount `0`. Companion: `meta.rateEdited` is true
    only for a rate-input edit, and a continuing line with `exchangeRateEdited`
    serializes `rateExplicit: true`.

20. **Null persisted rate stays unknown (R10-F1).** `toSplitRows` maps a null
    scheduled/investment-transaction rate to `undefined`, never `1` (both branches).
    And `update()` with a matched null-rate source that resends a rate without
    `rateExplicit` leaves the split unprovenanced (pair null, resolver not called),
    not stamped current. Break-on-purpose confirms the guard fails when the
    null-rate branch is removed.

21. **Manual Post honours explicit intent on a continuing row (R10-F2).** Post an
    inline split with `sourceSplitId` present, `rateExplicit: true`, and a value
    equal to the stored one (same-value re-entry) against a stale-pair source;
    assert the entered rate is honoured (`1.50`, `-1,500`), not re-resolved to the
    `1.35` market.

22. **Override date-move preserves the pinned pair (R10-F3).** `updateOverride`
    with a changed `overrideDate` and a resent-unchanged pinned split (`1.37`
    USD/CAD, `sourceSplitId` naming the existing override split) applies the new
    date and preserves `1.37` USD/CAD (resolver not called, so a since-changed pair
    is not substituted). Component-level: a date-only edit calls `updateOverride`
    with the new `overrideDate` and never `deleteOverride`/`createOverride`.

23. **Parent investment rate: explicit re-entry stamps, passive resend preserves
    (R11-F1).** Stored `1.50` EUR/CAD, the current settlement pair since changed to
    USD/CAD. (a) `update` with `investmentExchangeRate: 1.50` and
    `investmentExchangeRateExplicit: true` stamps the current pair (USD/CAD) even
    though the value is unchanged, and calls the pair resolver. (b) `update`
    resending `1.50` with the marker absent/false preserves the stored EUR/CAD and
    does not call the resolver (so posting still catches the stale rate). (c)
    `update` with a genuinely changed `1.37` stamps USD/CAD regardless of the
    marker.

24. **Same-currency dominates a stored/explicit non-1 scalar (R12-F1).** A `1.50`
    scalar recorded against a `CAD -> CAD` pair (its `from`/`to` equal the current
    pair). (a) Resolver: `resolveCashExchangeRateOrNull` with an explicit `1.50`
    and a same-currency pair returns `1`, not `1.50`. (b) Parent forecast: `findAll`
    yields `investmentForecastExchangeRate === 1` and calls the resolver (reuse
    refused). (c) Parent post: the stored `1.50` is not forwarded
    (`dto.exchangeRate` undefined), so the resolver settles it to `1`. (d) Embedded
    split post: rate `1` and the cash amount recomputed at par (`-(5 x 100) = -500`,
    never the stored `-750`). Break-on-purpose covers both chokepoints: reverting
    the resolver ordering fails (a); dropping the same-currency arm of
    `storedInvestmentRateIsCurrent` fails (b), (c) and (d).

Adversarial inputs drawn from `docs/testing-contract.md`: same-currency pair (rate
1, provenance recorded as `{X, X}` and always matches), a security-less amount-only
action (source = account currency), and a funding-account BUY vs a linked-cash BUY
(two different settlement currencies for the same brokerage).
