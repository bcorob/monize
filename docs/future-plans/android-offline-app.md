# Android app: offline-capable Monize with Google Wallet capture

Design for an Android application that shows the same Monize UI, keeps
working without the server, syncs when the server is reachable again, and
turns Google Wallet tap-to-pay notifications into Monize transactions. The
task list is [`android-offline-app-tasks.md`](./android-offline-app-tasks.md).

Status: **proposal**. Needs its own discussion and the `approved-to-build`
label (`CONTRIBUTING.md`). Decisions 1 to 3 in section 2 were taken by the
maintainer on 2026-10-19 while this document was drafted.

## 1. What happens today

Read from the code on 2026-10-19.

- **Monize is a responsive installable PWA with no offline data.** The
  service worker (`frontend/public/sw.js`) caches static assets cache-first,
  races every navigation against a 10 s timer and answers a failure with a
  localized "Unable to connect" page (`OfflineFallbackSync` hands it the
  strings). Every `/api` request is network-only. No IndexedDB, no write
  queue, no `navigator.onLine` listener exists in the frontend.
- **One door to the API.** `apiClient` (`frontend/src/lib/api.ts`) is an
  axios instance with `baseURL: '/api/v1'`, `withCredentials: true`, a request
  interceptor that adds `X-CSRF-Token` and `X-Client-Timezone`, and a response
  interceptor that handles 502/network errors
  (`connectionStore.setBackendDown()`), 403 CSRF refresh and the 401 refresh
  queue. Every `frontend/src/lib/*.ts` API module imports it; nothing calls
  the backend around it.
- **A backend-down state polls and reloads.** `BackendDownBanner` polls
  `/api/v1/health/live` every 5 s while `isBackendDown` and reloads the page
  on recovery. `authStore` rehydrate keeps `isAuthenticated` on a network
  error, so an offline boot already stays signed in.
- **Auth is cookie-only.** `auth_token` (15 min, httpOnly, lax),
  `refresh_token` (httpOnly, strict; 1 day, or `REMEMBER_ME_DAYS`, default
  30, with remember-me) and `csrf_token` (readable). `POST /auth/refresh`
  reads only the cookie (`backend/src/auth/auth.controller.ts`). The JWT
  strategy accepts `Authorization: Bearer`, but no login path returns a token
  in the body and the global `CsrfGuard` has no bearer exemption. Personal
  access tokens and OAuth access tokens are validated only on `/mcp`
  (`backend/src/auth/pat.service.ts` has one caller,
  `backend/src/mcp/mcp-http.controller.ts`).
- **The create idempotency key exists.** `POST /transactions`,
  `POST /transactions/transfer` and each row of `POST /transactions/bulk`
  accept `externalId`, unique per account through
  `idx_transactions_account_external_id`; a repeat returns the existing row
  with 200 (INV-API-001, `backend/src/transactions/transaction-external-id.ts`).
  There is no `Idempotency-Key` header. The frontend's `CreateTransactionData`
  (`frontend/src/types/transaction.ts`) does not carry `externalId`.
- **No delta feed.** No list endpoint takes `updatedSince` or a cursor;
  transactions are hard-deleted (the trash is an unbuilt proposal); updates are
  last-write-wins; the action history is a 100-row, 30-day undo log that not
  every write path feeds.
- **`payeeName` on create resolves or creates the payee** server-side, and
  transaction rules run inside every insert path (INV-RULE-001..005), so a
  client that sends a merchant name gets a payee, a category and tags without
  its own rule engine.
- **Register fetch.** `GET /transactions` takes 27 bare query params
  (`backend/src/transactions/transactions.controller.ts`), pages of 50 (max
  200), default order `applyRegisterOrder`
  (`backend/src/transactions/register-order.ts`): date, `createdAt`, amount in
  the opposite direction, id. The response carries `startingBalance` only for
  a single account without date filter, or for a filtered register; the
  client walks running balances from it.
- **Import dedupe.** File import has no general dedupe (FITID is parsed,
  not keyed). Bank sync dedupes against its own `(account_id, external_key)`
  rows only, never against hand-entered rows.
- **No native code anywhere.** No Capacitor, Cordova, TWA, React Native.
  Mobile is the PWA; `share_target` (Android Chromium) is the one OS
  integration.

## 2. Decisions

1. **The app shell is a Capacitor WebView that loads the live Monize
   origin** (`server.url`), not a bundled static export. 63 of 64 pages are
   client components, but the root layout, the root redirect page, the
   manifest route and `frontend/src/i18n/request.ts` read `headers()` and
   `cookies()`, `frontend/src/proxy.ts` is middleware, and nine `[id]` routes
   have no `generateStaticParams`, so `output: 'export'` would need a
   build-variant swap of all of them plus a bearer-token auth path and a CSRF
   exemption on the backend. Loading the real origin keeps cookies
   first-party, so 2FA, OIDC, CSRF, the CSP nonce and routing stay exactly as
   they are. The cost: the first sign-in on a device needs the server (true
   of any design, since the account lives there), and the offline shell is
   whatever the service worker has cached since.
2. **A captured Google Wallet payment creates a `pending` transaction
   immediately**, offline or online, in the account mapped to the card.
   Payee from the merchant name, category and tags from the user's rules. A
   review-first inbox was considered and rejected for v1: the maintainer wants
   the row to exist without a tap. The duplicate risk against a later bank
   import is stated in section 10 and left to a follow-up.
3. **Distribution is a signed APK on GitHub Releases.** No Play listing in
   v1; the notification-listener permission review and the privacy policy
   that Play requires are deferred.
4. **The offline layer lives in the frontend and serves the PWA too.** The
   mirror, outbox and sync engine are written once at the API door; the APK
   adds only what a browser cannot do (notification listener, native network
   signal, app lifecycle).
5. **Offline scope for v1 is the core**: dashboard account list, the
   register, add/edit/delete transaction and transfer, status toggles, bills
   read; reference lists read-only. Everything else answers "needs a
   connection". Growing the scope is a matter of adding routes to the
   whitelist and handlers to the mirror.
6. **No backend change is required.** The only server-side edit is in the
   frontend's Next proxy: a relaxed `script-src` for the native user agent
   (section 6.3).

## 3. Architecture

```text
+------------------------------ Android APK (mobile/) ------------------------------+
|  Capacitor BridgeActivity                                                          |
|   - server.url = <user's Monize origin>, asked once, stored in SharedPreferences   |
|   - appendUserAgent "MonizeAndroid/<versionName>"                                  |
|   - plugins: WalletNotifications (own, Kotlin), @capacitor/network, @capacitor/app |
|                                                                                    |
|  NotificationListenerService (Kotlin) --> SQLite queue --> drained by the web app  |
|   package com.google.android.apps.walletnfcrel          on resume and after sync  |
|                                                                                    |
|  WebView  https://<origin>  (first-party cookies, CSP, routing unchanged)          |
|   +---------------------------- existing Next.js app -----------------------------+ |
|   | pages and components unchanged                                               | |
|   | lib/api.ts adapter --> lib/offline/: IndexedDB mirror + outbox + sync engine  | |
|   | sw.js: documents for the offline routes cached, chunks warmed                 | |
|   +------------------------------------------------------------------------------+ |
+------------------------------------------------------------------------------------+
                      |  HTTPS, same-origin cookies, CSRF header (unchanged)
                      v
             Monize server (Next proxy + NestJS)  -- proxy.ts: CSP branch for the native UA
```

## 4. Frontend offline layer (`frontend/src/lib/offline/`)

### 4.1 Tiers

| Tier | Screens and operations | Offline behaviour |
|---|---|---|
| 1 read and write | Dashboard account list, register (`/transactions`), add/edit/delete transaction and transfer, status/clear/reconcile toggles, bills (`/bills`) read | Served from the mirror; writes go to the outbox |
| 2 read-only | Accounts, categories, payees, aliases, tags, institutions, scheduled transactions, preferences, profile, delegation contexts | Served from the mirror; writes refuse |
| 3 online-only | Reports, investments, AI, imports, attachments, FX lookups, settings writes, admin, splits and transfer-leg endpoints | `OfflineError`, shown by the existing toast path |

### 4.2 Hook point: an axios adapter

`adapter: offlineAdapter` is passed to `axios.create` in
`frontend/src/lib/api.ts`; the adapter lives in
`frontend/src/lib/offline/offline-adapter.ts`. An interceptor cannot resolve a
request or stop a write; an adapter can. Request interceptors (CSRF, timezone)
still run first; response interceptors see either a synthetic success or the
real adapter's rejection, so the 401 refresh queue and the 403 CSRF retry are
untouched, and a retried request re-enters the adapter with the same config.

Rules, in order:

1. `config.monizeOffline === 'bypass'` (module augmentation on
   `AxiosRequestConfig`) or a delegate context (`actingAsUserId !== null`):
   pass through. The sync engine uses the bypass so its own pulls are never
   answered from the mirror; a delegate's ledger is never mirrored in v1.
2. Whitelisted GET: offline, answer from the mirror; online but a network
   failure (`!error.response` and the code is neither `ECONNABORTED` nor
   `ERR_CANCELED`, the same split `api.ts` draws today), answer from the
   mirror and `setOffline(true, 'probe')`. A 502 keeps today's backend-down
   path.
3. Whitelisted write: offline, apply to the mirror, append to the outbox,
   answer a synthetic `201` (`200` for a repeated key) whose body is the
   materialized row. A network failure online takes the same fallback. This is
   safe only because every create carries an `externalId` and the other
   whitelisted writes are idempotent.
4. Anything else offline: reject with `OfflineError`
   (`frontend/src/lib/offline/offline-errors.ts`; `reason` is `unavailable`, `noData`
   or `unsupportedQuery`). It is not an `AxiosError`, so `showErrorToast`'s
   502 early return does not swallow it; its message comes from a copy table
   filled by a `useTranslations` effect, the same handshake
   `OfflineFallbackSync` uses for the worker.

`externalId` is injected in the existing request interceptor
(`ensureExternalId`) for `POST /transactions` and `POST /transactions/transfer`
only, because by adapter time `config.data` is already a JSON string. Never on
PATCH: `UpdateTransactionDto` omits the field and `forbidNonWhitelisted` would
answer 400. `CreateTransactionData` and `CreateTransferData` gain
`externalId?: string`. The default adapter is resolved lazily
(`axios.getAdapter` on first call) so `api.test.ts`'s axios mock, which has no
`getAdapter` and no `defaults`, keeps working.

Read whitelist: `/accounts` (`includeInactive`), `/accounts/:id`,
`/categories`, `/payees` (`status`), `/payees/aliases` (the transaction form's
`Promise.all` needs it or the form cannot open offline), `/tags`,
`/institutions`, `/scheduled-transactions`, `/users/preferences`,
`/auth/profile` and `/auth/contexts` (so `authStore` rehydrate succeeds
offline), `/transactions`, `/transactions/:id`.

Write whitelist: `POST /transactions`, `POST /transactions/transfer`,
`PATCH /transactions/:id`, `DELETE /transactions/:id`,
`PATCH /transactions/:id/status`, `POST /transactions/:id/clear`,
`.../reconcile`, `.../unreconcile`.

### 4.3 Storage

One IndexedDB database per user, `monize-offline-v1-<userId>`, opened by
`openUserDb(userId)`; a second tiny database `monize-offline-meta` holds
`lastUserId` so `/auth/profile` can be served during an offline boot before
the store knows who is signed in. Per-user databases make isolation
structural, let `logout()` leave the outbox alone, and make account deletion a
`deleteDatabase`. The wrapper (`idb.ts`) is about 120 lines over the native
API; no runtime dependency. `fake-indexeddb` is added as a devDependency
because jsdom has no IndexedDB and `idb.ts` must meet the coverage gate; the
engine and outbox tests run against a storage interface with an in-memory
implementation and stay pure.

Stores, version 1, created in an `onupgradeneeded` ladder:

| store | keyPath | indexes | contents |
|---|---|---|---|
| `transactions` | `id` | `accountId`, `transactionDate`, `[accountId+transactionDate]` | server rows verbatim; local creates use a client UUID |
| `accounts`, `categories`, `payees`, `tags`, `institutions`, `scheduledTransactions` | `id` | none | reference lists verbatim |
| `singletons` | `key` | | `preferences`, `profile`, `contexts`, `aliases` |
| `outbox` | `seq` (autoIncrement) | `targetId`, `clientId`, `state` | section 4.5 |
| `idMap` | `clientId` | | `{ clientId, serverId, mappedAt }` |
| `syncIssues` | `opId` | | conflicts and refusals shown in Settings |
| `meta` | `key` | | `lastPullAt`, window start, `seedBalance[accountId]` |

Pending state is not written onto rows. A non-persisted zustand
`offlineStore` holds `pendingTransactionIds`, `syncIssueCount`,
`syncVersion`, `isSyncing`, rebuilt from the outbox after every enqueue and
replay. Nothing new is written to `localStorage`, so
`persisted-storage.guard.test.ts` is not widened; the reasoning that guard
records is restated in `docs/frontend/offline.md` for the two database names.

`logout()` (`authStore`, its dynamic-import pattern) clears the mirror stores,
`singletons`, `meta` and `lastUserId`; never `outbox`, `idMap` or
`syncIssues`. It is also what the 401 interceptor and the rehydrate failure
call, so session expiry drops mirror data: the safe default on a shared
device. `DangerZoneSection` account deletion calls `deleteUserDb`. An
`OfflineSyncProvider` effect keyed on `user?.id` replays a non-empty outbox
when the same user signs in again and the device is online.

### 4.4 Local register query

`queryTransactionsOffline(db, params)` answers `GET /transactions` in the
`PaginatedTransactions` shape. Supported: `accountId`, `accountIds`,
`startDate`, `endDate`, `page` (default 1), `limit` (default 50, cap 200),
`sortBy: 'date'`, `sortDirection` (default `desc`). Order is
`compareRegisterOrder`, mirroring `applyRegisterOrder`: date by direction,
`createdAt` by direction, `amount` in the opposite direction, `id` by
direction; pinned by a fixture test (same date and `createdAt`, one credit and
one debit: a DESC list shows the debit first). Any content filter, search,
other sort, `externalId`, `includeInvestmentBrokerage` or `targetTransactionId`
throws `OfflineError('unsupportedQuery')`: each either needs the server's
search parser or flips the server's balance regime. The plain register sends
none of them.

Window: the pull stores rows with `transactionDate >= today - window`
(default 90 days, a preference; no upper bound, since future-dated rows count
in the projected balance). A request reaching before the window is answered
from what the mirror has and the offline banner says so.

`startingBalance` is produced only for the single-account, no-date-filter,
date-sorted case, as on the server. During the pull each non-brokerage
account's page-1 `startingBalance` (newest page under DESC, which is the
projected balance) is stored as `meta.seedBalance[accountId]`. Offline:
`roundMoney(seed + sum of local deltas for the account - sum of the mirror
rows the register lists newer than this page)`, VOID and child rows excluded,
`roundMoney` and `sumMoney` from `frontend/src/lib/format.ts`. Local deltas:
create `+amount`, update `new - old`, delete `-old`, status to VOID `-amount`,
VOID to other `+amount`. The same delta map adjusts `currentBalance` when
`GET /accounts` is served from the mirror. Under a date filter no seed is
returned (the server's filtered regime is not reproduced; withholding is
honest and `walkRunningBalances` then draws no column).

A materialized local row embeds `account`, `category` and `tags` from the
mirror, `payee: null` plus `payeeName`, the status flags, `isSplit` from
`splits`, `attachmentCount: 0`, `createdAt = updatedAt = now`. A transfer makes
two linked rows (`isTransfer`, `linkedTransactionId`) and answers
`{ fromTransaction, toTransaction }`.

### 4.5 Outbox

```ts
interface OutboxEntry {
  seq: number;                  // autoIncrement; replay order
  opId: string;                 // crypto.randomUUID()
  kind: 'create' | 'createTransfer' | 'update' | 'delete' | 'status' | 'clear' | 'reconcile' | 'unreconcile';
  targetId: string;             // transaction id; a client UUID while the create is unpushed
  clientIds?: string[];         // create: [id]; transfer: [fromId, toId]; the create's externalId
  url: string; method: 'post' | 'patch' | 'delete';
  body: unknown | null;         // exactly what the UI sent
  baseUpdatedAt: string | null; // server updatedAt of the row when the local edit was made
  baseRow: Transaction | null;  // snapshot for deltas and the sync-issues display
  createdAt: number; attempts: number; lastError?: string;
  state: 'pending' | 'in-flight' | 'failed' | 'conflict';
}
```

`enqueue` applies the mirror change and the entry in one IDB transaction, with
coalescing: an update of an unpushed create merges into the create; a delete
of an unpushed create drops both; an update after a pending update merges
bodies and keeps the earlier `baseUpdatedAt`; a delete after pending
update/status entries drops them; status entries stay separate (different
server semantics) but fold into an unpushed create's `status`.

### 4.6 Replay and pull

`replayOutbox()` is single-flight and runs every request through
`apiClient` with the bypass flag, so CSRF and the 401 refresh apply at replay
time (headers are never stored). In `seq` order:

1. `targetId = idMap[targetId] ?? targetId`.
2. Create and transfer: POST with the stored `externalId`; 200 (dedupe) and
   201 both succeed; write `idMap`; replace the client-id row(s) in the mirror
   with the server row(s).
3. Update and status kinds: `GET /transactions/:id` first. 404: sync issue
   `deletedOnServer`, drop the local row. `updatedAt` newer than
   `baseUpdatedAt`: the server wins; the server row goes into the mirror, the
   local payload into `syncIssues` with "Reapply" (re-enqueue against the
   fresh `baseUpdatedAt`) and "Discard"; the entry is `conflict`. Otherwise
   PATCH or POST.
4. Delete: DELETE; 404 counts as done.
5. A network failure stops the run, keeps the rest `pending` and schedules a
   backoff. A 4xx marks the entry `failed` with the server message and
   continues, so one bad entry does not block the queue.
6. When the queue drains: `pullMirror()` (reference lists through the
   existing `*Api.getAll` calls, per-account seed balances,
   `transactionsApi.getAllPages` for the window; stores replaced in one
   transaction, so a server-side delete disappears by replacement and no
   tombstone endpoint is needed), then `clearAllCache()` in the same module
   (`balance-cache.guard.test.ts` flags transaction writes without an
   invalidation), bump `syncVersion`, fire the same refetch signal
   `useOnUndoRedo` subscribers use so mounted registers reload without a page
   reload.

Triggers: the `online` event, the Capacitor network status change, a visible
resume (`PwaLifecycleHandler`), the provider effect on `user?.id`, every 15
minutes while visible, the backoff timer, and "Sync now".

### 4.7 Visible changes

- `connectionStore` grows `isOffline`, `offlineSince`, `offlineSource`
  (`navigator`, `capacitor`, `probe`), `setOffline`, an exported `isOffline()`
  getter and an idempotent `startConnectivityWatch()` (seeded from
  `navigator.onLine`; `online`/`offline` listeners; duck-typed
  `window.Capacitor.Plugins.Network` when present, no npm dependency in the
  frontend). A `ConnectivityWatcher` provider in `layout.tsx` starts it.
- `BackendDownBanner`: while `isOffline`, no `/health/live` poll and no
  reload; an amber "You're offline, showing saved data" with the pending
  count. The 502 branch in `api.ts`, the rehydrate failure in `authStore` and
  `PwaLifecycleHandler.onResume` skip `setBackendDown()` when offline.
- Register rows with a pending outbox entry show a `PendingSyncBadge` (built
  on `Badge`) beside each `AttachmentBadge` site in `TransactionRow` (card,
  tier cell, wrapped layouts); `TransactionList` passes `isPendingSync` the
  way it passes `isDeleting`.
- `TransactionForm`, four small edits: `handlePayeeCreate` offline sets
  `payeeName` only and returns (the submit already sends `payeeName`);
  the FX effect already catches a failed lookup into `fxRateLookupFailed`,
  zero edits; `handleTagCreate` refuses offline; `performSubmit` refuses when
  attachments are staged offline so files are never silently dropped.
- `AppHeader`: a cloud icon with the pending count, linking to Settings.
- Settings "Offline & sync" section: last sync, pending count, sync issues
  with Reapply and Discard, window length, "Sync now", "Clear local data".
  Hidden in demo mode like the other sections.

## 5. Service worker (`frontend/public/sw.js`)

- `handleNavigation`: network-first with the existing timer. A `200`,
  non-redirected response for a pathname in `OFFLINE_DOCUMENT_ROUTES`
  (`/dashboard`, `/transactions`, `/accounts`, `/bills`, `/settings`, `/login`)
  is stored in `monize-docs-v1` under origin plus pathname (query stripped)
  and the original response is returned. On rejection or timeout: the cached
  document, else the existing offline page. A redirect is never cached:
  `proxy.ts` answers a signed-out navigation with a redirect to `/login`.
  `DOC_CACHE_NAME` joins the activate keep-list, or every worker update wipes
  the documents.
- A `monize-warm-documents` message, next to the existing
  `monize-offline-strings` branch: routes are filtered against
  `OFFLINE_DOCUMENT_ROUTES` (the worker never fetches a path a message chose),
  each is fetched with credentials and stored, and the `/_next/static/`
  script and stylesheet URLs named in the HTML are fetched into the static
  cache. The document names its own chunks, so no app-side import list is
  needed and no page code is duplicated into a client chunk (the bundle-size
  check runs on every PR). For the form chunks behind `next/dynamic`, the
  warmer calls the identical dynamic import once; webpack dedupes it.
- `OfflineDocumentWarmer` (the `OfflineFallbackSync` pattern) posts the
  message when authenticated, hydrated and online, and again on reconnect.
- Soft navigation offline: the App Router's RSC fetch is not a navigation
  and fails; Next falls back to a full navigation, which the worker serves
  from the document cache. Accepted; no RSC caching. Version skew: a cached
  document references content-hashed chunks already in the static cache; the
  next online navigation replaces both.

## 6. Android shell (`mobile/`, a new top-level layer)

### 6.1 Project

The `mobile/` layer holds its own package manifest, `capacitor.config.ts`,
`android/`, `www/setup.html`, `plugins/wallet-notifications/`, a short layer
index (its own `CLAUDE.md`, like the one in `database/`) and a readme; the
cross-layer notes go in a readme under `docs/mobile/`.
Capacitor is pinned at or above the fix for CVE-2026-103922 (remote-content
loading in 6.2.2, 7.6.9, 8.3.5, 8.4.3, 8.5.1) and tracked by the existing
audit job.

### 6.2 Runtime origin

The config file's `server.url` is build-time, which would hard-code one
server. `MainActivity` reads the origin from SharedPreferences: absent, it
loads the local `www/setup.html` (plain HTML, boot colours from
`frontend/src/lib/pwa-theme.ts`, validates an `https://` origin, stores it,
restarts the activity); present, it builds the Capacitor config at runtime
with that `server.url`, `allowNavigation` for that host only, and
`appendUserAgent("MonizeAndroid/<versionName>")`. The runtime-config API is
verified against the pinned version in task M1; if it is unsupported, the
fallback is a `loadUrl` after bridge initialisation, documented.

`frontend/src/lib/native-shell.ts` exports `isNativeShell()`
(`window.Capacitor?.isNativePlatform?.() === true`), used by the Wallet
section, the connectivity watcher and the login page, which defaults
"Remember me" on when native so the refresh token lasts `REMEMBER_ME_DAYS`.

### 6.3 CSP for the native user agent

Capacitor injects its bridge as an inline script with no nonce, which the
`script-src 'nonce-...' 'strict-dynamic'` policy from `proxy.ts` blocks. For a
user agent containing `MonizeAndroid/`, `buildCspHeader` emits
`script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'` and leaves every other
directive as it is. A spoofed user agent weakens the policy only for the
spoofer's own browser; CSP protects the victim's. Recorded as a product
decision in the frontend security doc, tested in `proxy.test.ts`.

### 6.4 What the WebView cannot do

No Push API in Android WebView; `PushDevicesPanel` already reports
unsupported. FCM, receiving OS shares in the APK and iOS are listed in
section 9.

### 6.5 Build

`.github/workflows/android.yml` builds `assembleRelease` on a tag, signs with
a keystore from repository secrets, attaches the APK and its SHA-256 to the
GitHub Release the existing `release` job creates; `npm-audit` and
`license-check` include `mobile/`.

## 7. Google Wallet capture

### 7.1 Native (`mobile/plugins/wallet-notifications/`, Kotlin)

`WalletNotificationListener : NotificationListenerService` bound to package
`com.google.android.apps.walletnfcrel`; group summaries and ongoing
notifications are skipped. Every capture is written to a SQLite table
`wallet_events` with `key`, `postTime`, title, text, bigText, the parse
result `{ amount, currency, merchant, cardLast4 }` or null, and `ack = false`.
Google does not document the notification template and it varies by region
and card, so the parser is written from samples the app itself captures on
the maintainer's device (de-identified fixtures under `samples/`), and the raw
strings are always kept: a parse failure is visible and fixable, never silent.

Plugin methods: `isAccessGranted()`, `openAccessSettings()`, `getPending()`,
`ack(ids)`, `getRecentRaw(limit)`.

### 7.2 Web side (`frontend/src/lib/wallet/`, native-only UI)

- Settings "Google Wallet" section, rendered only when `isNativeShell()`:
  permission status and "Open settings"; a card mapping table (`cardLast4` or
  card label to a Monize account, stored in user preferences through
  `frontend/src/lib/user-settings.ts`); an "Auto-create" toggle, default on;
  the last ten raw captures with their parse result.
- `ingest.ts`: on resume and after each sync, `getPending()`; for each parsed
  event with a mapped account, `transactionsApi.create` with
  `externalId = 'gwallet:' + sha256(key + postTime)`, `status: 'pending'`, a
  negative `amount`, `payeeName = merchant`, `description = 'Google Wallet'`,
  `referenceNumber = cardLast4`, `transactionDate` from `postTime` in the
  device zone. Because the create goes through `apiClient`, the offline layer
  and the outbox apply unchanged. `ack` only after the create, or the outbox
  append, resolved. An unmapped card or an unparsed text toasts once and stays
  visible in the section.

## 8. Invariants

Proposed for `docs/system-invariants.md`, status `partial` until the guard
tests named in the tasks exist:

- **INV-OFFLINE-001.** A row created offline is replayed with its client id
  as `externalId`, so a lost response never produces a second row. Mechanism:
  `ensureExternalId` in the request interceptor; the backend's
  `idx_transactions_account_external_id` (INV-API-001).
- **INV-OFFLINE-002.** A replayed edit never overwrites a server row that
  changed after the edit was made; the server wins and the local payload is
  kept for the user. Mechanism: the GET-before-PATCH compare in `sync.ts`.
- **INV-OFFLINE-003.** A Wallet capture is acknowledged only after it has
  been durably queued or created. Mechanism: `ingest.ts` acks after the
  `transactionsApi.create` promise resolves, which offline means the outbox
  transaction committed.

Touched: INV-API-001 (its two known gaps, undo-of-delete losing the key and an
account move changing the scope, apply to replayed rows as to any other),
INV-RULE-001 (rules still run on every create path, so Wallet rows get them),
INV-AUTH-001 (refreshes are serialized by the existing queue; the replay runs
one request at a time).

## 9. Not in v1

Background outbox flush from native code while the WebView is closed; FCM
push; receiving OS shares in the APK; iOS; offline reports, investments, AI,
imports, attachments; a delegate's mirrored ledger; absorbing Wallet rows into
bank imports; a Play Store listing.

## 10. Risks

- **Duplicates against a later bank import.** File import has no dedupe and
  bank sync dedupes only against its own keys, so a Wallet row, like any
  hand-entered row, is not matched when the bank's version arrives. A
  follow-up proposal, "absorb pending rows on import", can reuse the
  email-receipt `amount_date` matcher. Stated to the maintainer, accepted for
  v1.
- Android WebView evicting the worker cache or IndexedDB under storage
  pressure. Mitigation: `navigator.storage.persist()` requested on first run;
  the outbox is small.
- Google Wallet notification wording changes. Mitigation: raw text kept, a
  user-visible parser preview, fixtures from real captures.
- Notification access is a sensitive permission. The setup copy says exactly
  what is read (the Wallet package only) and that nothing leaves the device
  except the resulting transaction.
- The Capacitor remote-content CVE class. Pin, audit, track.
- A refresh token older than `REMEMBER_ME_DAYS` while offline: on reconnect
  the app signs out, the outbox survives and flushes after sign-in.
- Version skew between a cached document and a redeployed server is bounded
  by content-hashed chunks already cached; a never-visited route is simply
  not available offline.

## 11. Assumptions a fresh session should check

1. `axios.getAdapter` exists on the installed axios (1.13.x exports it).
2. Next 16 still falls back to a full navigation when an RSC fetch fails.
3. The pinned Capacitor version supports a runtime `server.url`.
4. `transactions.service.ts` `createWithOutcome` sets `createPayeeIfMissing`
   so `payeeName` creates a payee on the REST path.
5. Android WebView supports service workers for the app's `https` origin on
   the minimum SDK chosen (API 26 or higher is assumed).
6. `accounts.currentBalance` versus the projected balance: the seed is read
   from the server's page-1 `startingBalance`, so the difference does not
   matter, but the delta math assumes the seed includes future-dated rows.

## 12. Rejected alternatives

- **Bundled static export with bearer auth.** Needs build-variant swaps of
  the layout, the root page, the manifest route, `i18n/request.ts` and
  `proxy.ts`, `generateStaticParams` placeholders and link rewrites for nine
  `[id]` routes, a token-in-body login and refresh, and a CSRF exemption for
  bearer requests. Roughly twice the work for a faster cold boot.
- **Trusted Web Activity.** Real Chrome and a better PWA runtime, but no
  JavaScript bridge, so the notification listener could only talk to the
  server directly with a credential the REST API does not accept today.
- **Native rewrite.** Out by the brief.
- **Action history as the change feed.** Capped at 100 rows and 30 days,
  not written by every path.
- **A delta endpoint and tombstones.** Would need a backend change and a
  `transactions.updated_at` index; the window re-fetch replaces the mirror and
  makes deletes implicit at the sizes a personal ledger has.
- **Queueing attachments offline.** Blobs in IndexedDB plus a second upload
  path; refused in the form instead.

## 13. What to run and what to observe

1. `frontend/`: `npm run lint && npm run type-check && npm run i18n:check && npm run test:changed && npm run build`.
2. `e2e/`: stack up, then `npm test -- tests/offline.spec.ts`.
3. `frontend/`: `npm run test -- sw-offline` and `npm run test -- proxy`.
4. `mobile/`: `npm ci && npx cap sync android && (cd android && ./gradlew lint testDebugUnitTest assembleDebug)`; install; set the origin; sign in;
   airplane mode; add a transaction; relaunch the app; leave airplane mode;
   the row appears in the web register with the same id and no duplicate.
5. Wallet: grant notification access, make a tap payment, see a `pending`
   row with the merchant as payee in the mapped account.
6. Repo: `node scripts/check-docs-manifests.mjs`, `node scripts/check-env-docs.mjs`.
