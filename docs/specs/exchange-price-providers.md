# Spec: London Stock Exchange and Deutsche Börse as price providers

Status: implemented alongside this document (issue kenlasko/monize#1415,
`approved-to-build`).

Related: `docs/backend/securities-and-providers.md` (INV-PRICE-001, the currency
acceptance rule), `backend/src/securities/providers/quote-provider.interface.ts`,
`docs/external-side-effects.md` (outbound providers through the breaker).

## 1. What this adds, and why

The catalogue priced securities through Yahoo and MSN only. A holder of a
London- or Frankfurt-listed ETF whose exact share class Yahoo does not carry (or
carries under a different listing, in a different currency) had no authoritative
source. This adds two providers that address the instrument the way each venue
does -- the LSE by its ticker (TIDM), Börse Frankfurt by ISIN -- so the price
series belongs to the listing the holder actually trades, not a same-ticker
listing on another exchange.

Both are new values of `QuoteProviderName`
(`backend/src/securities/providers/quote-provider.interface.ts`), selectable as a
per-security override or the user default, and go through the same currency
acceptance check as Yahoo and MSN. `QUOTE_PROVIDER_NAMES` is the single source of
truth the DTO validators and the `quote_provider` / `default_quote_provider`
CHECK constraints read (bound by `quote-provider-names.guard.spec.ts`).

**Search and price-refresh treat the exchange providers differently, on
purpose.** A lookup (`lookupSecurityCandidates`, `provider: auto`) aggregates
candidates from *every* provider so a security's own venue surfaces alongside the
ticker providers, and the user picks the listing they hold. Price refresh does
not: `QuoteProviderRegistry.resolveForSecurity` only ever falls back to the
general ticker providers (`GENERAL_FALLBACK_PROVIDERS` = Yahoo, MSN), never to an
exchange-specific provider a security did not opt into -- otherwise a US ticker
that merely collides with a same-currency London or Frankfurt listing could be
silently repriced from it. An exchange provider prices a security only when that
security names it.

The retrieval mechanics were reconstructed from captured browser traffic of each
venue's own price-history page; neither venue publishes a documented public API,
so section 4 records the operational caveats honestly.

## 2. London Stock Exchange (`lse`)

`backend/src/securities/lse-finance.service.ts`. Priced by TIDM (e.g. `AGGU`),
but **searched** by ISIN, TIDM or name through the LSE autocomplete
(`api.londonstockexchange.com/api/gw/lse/search/autocomplete?q=&size=5`), keeping
only the real LSE listings (`islse`) and enriching each with its master record
for a currency. That is what lets a lookup by ISIN surface the London listing.
The LSE company page serves its chart from a third-party widget backend
(financial.com, an LSEG partner). The price chain, all through the circuit breaker:

1. Build the Reuters Instrument Code as `<TIDM>.L` (the LSE convention).
2. `GET api.londonstockexchange.com/api/gw/feedhandler/token/saml` -> a SAML
   artifact (`encodedToken`), sent with the page's own `Origin`/`Referer`.
3. `POST refinitiv-widgets.financial.com/auth/api/v1/sessions/samllogin` with
   `SAMLResponse=<encodedToken>` -> a short-lived session JWT (~5 min), cached
   until shortly before it expires.
4. `GET refinitiv-widgets.financial.com/rest/api/timeseries/historical` with
   `ric`, `fromDate`, `toDate`, `fids=_DATE_END,CLOSE_PRC,HIGH_1,OPEN_PRC,LOW_1`,
   `samples=D`, and the JWT in a `jwt:` header -> daily OHLC rows.

The endpoint is windowed, so `fetchHistoricalWindowSeries` is native and
`fetchHistoricalSeries` maps a named range onto a window. A `CLOSE_PRC` of `"-"`
is a session with no trade (holiday/halt) and is dropped, never stored as a
zero. No credentials of the reader's are used; the server replays the whole
chain.

## 3. Deutsche Börse / Börse Frankfurt (`deutsche_boerse`)

`backend/src/securities/deutsche-boerse-finance.service.ts`. **Priced** by ISIN
(e.g. `IE00B6R52259`), but **searched** by symbol, name or ISIN through the
global search (`api.live.deutsche-boerse.com/v1/global_search/limitedsearch/en?searchTerms=`),
which answers with the ISIN, name, currency and type in one call -- so a lookup
by the Frankfurt ticker (`IUSQ`) resolves to the ISIN-addressed candidate.
Börse Frankfurt streams daily history over a websocket rather than a REST
endpoint:

1. `GET api.live.deutsche-boerse.com/v1/mdstokenservice/token` (see section 4)
   -> a market-data token (JWT, scope `websocket`, ~7 min).
2. Open `wss://api.live.deutsche-boerse.com/v1/mds/ws`, authenticate with
   `subscribeAuthentication`, then send `listTimeseries` with `resolution:"1D"`
   and a `marketstateId` of `DELAYED[<isin>,<ccy>@ETR>STX]` (Xetra).
3. Collect the streamed `dataTimeseries` frames (date/open/high/low/close/
   quantity) until the stream goes idle, then close.

The websocket is Node's built-in `WebSocket` (no new dependency) behind an
injectable factory for testing, and the token fetch is gated by the same breaker
as every other outbound call.

## 4. Missing-data policy and the Deutsche Börse caveat

- **Currency is read from the instrument, not guessed from the exchange.** The
  LSE series carries no currency, so it is read from
  `instruments/alldata/<tidm>` (`currency`); the Börse Frankfurt series takes it
  from `/v1/data/currency?isin=`. The `HistoricalSeries.currencyCode` carries it
  to the acceptance point, where `verifyProviderCurrency` refuses a payload whose
  currency is not the security's (INV-PRICE-001). GBX/GBp is divided into pounds
  and reported as GBP, like the other providers.
- **A refused or unreachable upstream returns `null` (no answer), never a
  substituted figure.** An empty window returns a series with no bars.
- **The Börse Frankfurt market-data requests carry a client-computed signature,
  reproduced exactly -- not a login or an API key.** The site's own public
  JavaScript signs every request to the market-data host before a visitor has
  authenticated anything, so it is reproducible without credentials. Verified
  byte-for-byte against the captured traffic (`boerseSecurityHeaders`):
  `Client-Date` is the ISO-8601 instant in Europe/Berlin; `X-Client-TraceId` is
  `md5(Client-Date + requestUrl + salt)`; `X-Security` is `md5(now,
  "yyyyMMddHHmm")` -- the current Frankfurt minute, with no salt. The salt is a
  fixed constant lifted from the site's app bundle (`tracing.salt`) and bundled
  in the code, so the provider works with no configuration; the site rotates it
  on a rebuild, and a stale value simply makes the token endpoint answer 401 (no
  data), never a wrong number, so refreshing it is a one-line code change. The
  remaining honest caveats are that rotation and the venue's terms of use, which
  a maintainer must weigh before relying on the feed.

## 5. Test matrix

- `lse-finance.service.spec.ts`, `deutsche-boerse-finance.service.spec.ts`:
  quote mapping, windowed OHLC, GBX conversion, the `"-"` / null-close skip,
  currency sourced separately, token caching and expiry, degraded upstreams
  (SAML failure, token failure, unknown currency, socket error), range mapping,
  ISIN validation.
- `quote-provider.registry.spec.ts`: resolution and fallback ordering across all
  four providers.
- `provider-call.guard.spec.ts`: both new services route their outbound calls
  through the breaker and are registered guarded clients.
- Migration `20260924075958_widen_quote_provider_check.sql` widens both CHECK
  constraints; `database/schema.sql` and the integration baseline are updated in
  the same change.
