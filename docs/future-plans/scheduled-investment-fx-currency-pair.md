# Scheduled-investment FX rate: currency-pair invalidation (follow-up to issue #1154)

Status: deferred. Tracked here because it is a real gap that was out of scope for
the #1154 posting-path fix. It is ultimately a **financial-correctness** defect,
not merely a consistency one: once a future occurrence posts with the stale
scalar, the cash lands at the wrong converted amount and the account balance is
wrong. What makes deferral reasonable is that nothing corrupts at the moment the
security/account currency is edited -- the defect materializes only on a later
scheduled posting, and no data is lost in the meantime. This document is the
durable record until a GitHub issue is filed for it.

If a GitHub issue is filed, the upstream review target is `kenlasko/monize`
(where issue #1154 lives), not the mirror this branch is pushed to.

## The gap

A scheduled investment (and a scheduled split, and an occurrence override) can
store an FX rate that converts the security's currency into the settlement
account's currency. That rate is a single scalar with **no companion
from/to currency pair persisted beside it**. So if the security's `currencyCode`
or the settlement account's `currencyCode` changes *after* the rate was stored
-- with the id unchanged -- the stored rate silently becomes a rate for a pair
that no longer applies. Posting later would convert with a rate that answers a
question nobody is asking anymore.

This is the same family as the "settlement-basis change invalidates the stored
rate" fix already landed in the posting/update path (issue #1154): that fix
re-resolves the rate when the *schedule's own* settlement structure changes, but
it cannot see a currency change made on the referenced security or account row.

## The three rate surfaces (all must be covered by any fix)

1. `scheduled_transactions.investment_exchange_rate`
   (`NUMERIC(20, 10)`, entity field `investmentExchangeRate`).
2. `scheduled_transaction_splits.investment_exchange_rate`
   (`NUMERIC(20, 10)`) -- the per-split rate on an embedded investment split.
3. Occurrence-override embedded investment rate -- the `exchangeRate` inside an
   override's `splits[*].investment` payload.

A fix that clears only surface (1) leaves a split or an override carrying the
same stale rate, so all three have to be addressed together.

## Two candidate fixes

- **Invalidate on currency change (narrow).** When
  `SecuritiesService.update` changes a security's `currencyCode`, or an account's
  currency is changed, clear the stored `investment_exchange_rate` on every
  affected scheduled transaction, scheduled split, and occurrence override that
  references that security/account. Posting then re-resolves the rate through the
  same resolver the commit uses. Cheap, but it is one more write path that has to
  remember the three surfaces.

- **Persist the currency pair (durable).** Store the rate's from/to currency
  codes beside each rate, so the posting path self-verifies: if the stored pair
  no longer matches (security currency, settlement account currency), treat the
  rate as absent and re-resolve, exactly as a missing rate is handled. This makes
  the rate self-describing and removes the need for any external write path to
  remember to invalidate it. Preferred, but it is a schema change on three
  tables/payloads.

Either way, the acceptance test is a round trip: store a rate, change the
security (or account) currency, post, and assert the posted cash was converted
with a freshly resolved rate for the *current* pair -- never with the stale
scalar.

## Why it is safe to defer

Changing a security's or an account's currency after scheduling an investment in
it is rare, and the failure surfaces only on a future posting (a wrong converted
cash amount and balance then), not at the moment of the currency edit and not as
a data-loss event. The #1154 fix closes the
misrouting and the settlement-basis staleness that were the reported defect; this
residual is the remaining edge that needs a schema decision rather than a
point fix, which is why it is written down here instead of rushed in.
