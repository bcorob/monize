# Security price movement alerts

Owner-only opt-in on each security: `priceAlertPercent`, nullable; blank/null
means off. A finite percentage in [0.1, 1000] enables alerts for either direction.
Configure it in the existing create/edit security form. Channel delivery uses
the Investments notification matrix; the in-app row is always written.

Every 15 minutes the producer scans active opted-in securities in keyset batches
of 100 and evaluates each in its owner's database scope. It reads existing
`security_prices` only, without calling a quote provider. There must be two
positive finite closing-price values on distinct dates. The newest date must
be today's UTC date; future and historical-only quotes do not alert. The other
value is the previous available session, which may precede a weekend or holiday.

The change is `(latest close - previous close) / previous close * 100`.
This is raw quoted-price movement, not portfolio performance or total return:
stock splits, distributions and provider corrections can affect it. A stored
same-day provider quote need not be the final exchange close. Manual prices
participate too. Enabling an alert may immediately qualify today's already
stored quote on the next tick; no new download is required.

The existing unique notification key is `security-price:<securityId>:<UTC date>`.
All replicas and retries use the same key, so at most one notification row is
written for that instrument per day, even if it crosses again or reverses.
Changing or disabling/re-enabling the threshold does not reset that daily limit.
The collapse key is per instrument, independent of the date. The payload facts
include security ID, symbol, currency, both prices/dates and signed percentage;
the target is `/securities/<id>`. Bell and immediate email copy are localized.
Push retains the existing generic Investments copy and per-category gates.

Configuration is stored on the existing owner-scoped `securities` row, with
DTO and database bounds, standard backup handling and support-backup classification.
No new delegation permission or user-owned table is introduced. One process
skips overlapping ticks; the database notification dedupe remains the
cross-replica write authority. Each security's failure is isolated so the scan
continues. Database rows are read per batch rather than all loaded at once.

Optional charts now follow notification spec section 14.6. Each security has
`priceChartEnabled`, default false, editable alongside its alert threshold.
Web Push devices receive distinct single-use image links valid for five minutes;
UnifiedPush remains text-only. Image failure never prevents text delivery.
Migration 191 persists the opt-in; migration 190 stores bounded ephemeral PNGs,
which are excluded from all backups. Browser display and the real-PostgreSQL
concurrency test still require their respective runtime validation environments.
