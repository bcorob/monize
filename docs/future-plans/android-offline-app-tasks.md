# Android offline app: Agent Task List

> Companion to [`android-offline-app.md`](./android-offline-app.md) (the design). The frontend tasks F1 to F9 ship as one or more PRs in order; the mobile tasks M1 to M3 and the Wallet tasks W1 to W3 follow. Each task below is one commit. Mark a task done by checking its box.

## How to use this list (read first, every session)

- **One task per commit.** Each task lists its files. Touching files outside the task's scope is a scope violation: stop and leave a note instead.
- **The governing rule applies to every task:** a row entered offline is never lost and never duplicated. Every create carries its client id as `externalId`, every replay goes through `apiClient`, and no task may ship a write path that bypasses either (design section 8, INV-OFFLINE-001).
- **Order matters for the deploy.** F1 is shippable alone and changes only what an offline browser sees. F2 to F6 are inert until F3 wires the adapter; F3 therefore lands only with F4 to F6 in the same PR, or behind a disabled whitelist. F8 is independent of the data layer. M2 is inert until an APK sends the user agent.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:changed`, `npm run build`.
  - `e2e/`: `docker compose -f docker-compose.e2e.yml up -d --wait`, then the spec file.
  - `mobile/`: `npm ci && npx cap sync android && (cd android && ./gradlew lint testDebugUnitTest assembleDebug)`.
  - Repo: `node scripts/check-docs-manifests.mjs` when a doc names a path or script; `node scripts/check-env-docs.mjs` when an env var is read.
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q2.
  - No new npm dependency unless the task names it (F2 names `fake-indexeddb`; M1 names the Capacitor packages).
- **Terminology:** "the design" = `android-offline-app.md`. Section references point there. Re-locate code by symbol, never by line.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Discussion agreeing the design; label `approved-to-build` | -- | none | [ ] |
| F1 | `connectionStore` offline signal, `ConnectivityWatcher`, `BackendDownBanner` offline branch, 502 guards | S1 | **live** (offline browsers only) | [ ] |
| F2 | IndexedDB wrapper, per-user database, logout and deletion hooks, `fake-indexeddb` | F1 | inert | [ ] |
| F3 | Route whitelist, offline adapter, `OfflineError`, `externalId` injection | F2 | inert until wired | [ ] |
| F4 | Local register query, reference-list handlers, balance deltas | F3 | inert | [ ] |
| F5 | Outbox, coalescing, materialized rows, `offlineStore` | F4 | inert | [ ] |
| F6 | Replay, conflicts, pull, triggers; wires the adapter | F5 | **live** | [ ] |
| F7 | Register badge; four `TransactionForm` guards | F5 | neutral | [ ] |
| F8 | Service worker document cache and warmer | F1 | **live** | [ ] |
| F9 | Settings "Offline & sync" section; header pending count | F6 | neutral | [ ] |
| M1 | `mobile/` Capacitor shell, runtime origin, setup page, `isNativeShell()`, remember-me default | S1 | none | [ ] |
| M2 | `proxy.ts` CSP branch for the native user agent | M1 | inert | [ ] |
| M3 | APK build and release workflow | M1 | none | [ ] |
| W1 | `WalletNotifications` Kotlin plugin | M1 | none | [ ] |
| W2 | Settings "Google Wallet" section, card mapping | M1, F9 | neutral | [ ] |
| W3 | Wallet ingest | W1, W2, F6 | neutral | [ ] |
| Q1 | Playwright `offline.spec.ts` | F7, F8 | none | [ ] |
| D1 | Docs and invariants | F6 | none | [ ] |
| Q2 | Full-locale i18n pass (final commit) | all above | none | [ ] |

## S1: Discussion and label

Open a GitHub Discussion from the design; the maintainer labels it
`approved-to-build`.

**Acceptance:** the label exists; every PR of this plan links the discussion.

## F1: Offline signal and banner

**Files:** `frontend/src/store/connectionStore.ts`, `frontend/src/store/connectionStore.test.ts`,
`frontend/src/components/providers/ConnectivityWatcher.tsx` and its test,
`frontend/src/app/layout.tsx`, `frontend/src/components/layout/BackendDownBanner.tsx` and its test,
`frontend/src/lib/api.ts`, `frontend/src/lib/api.test.ts`, `frontend/src/store/authStore.ts`,
`frontend/src/components/providers/PwaLifecycleHandler.tsx` and its test,
`frontend/src/i18n/messages/en/layout.json`.

**Steps:**

1. `connectionStore`: add `isOffline: boolean`, `offlineSince: number | null`,
   `offlineSource: 'navigator' | 'capacitor' | 'probe' | null`,
   `setOffline(offline, source)`, an exported `isOffline()` getter (a plain
   function over `getState()`), and an idempotent `startConnectivityWatch()`:
   seed from `navigator.onLine`, listen to `window` `online`/`offline`, and
   when `window.Capacitor?.Plugins?.Network` exists (duck-typed local
   interface; no npm dependency) call `getStatus()` and
   `addListener('networkStatusChange', ...)`. Treat `isOffline === true` as
   authoritative and `false` as "try the network".
2. `ConnectivityWatcher` provider calls the watcher once; mount it in
   `layout.tsx` beside `OfflineFallbackSync`.
3. `BackendDownBanner`: the poll effect returns early while `isOffline` (no
   `/health/live` request, no `window.location.reload()`); render an amber
   variant ("offline, showing saved data") instead of the red one. The
   pending count is wired in F5.
4. `api.ts` 502/network branch: skip `setBackendDown()` when
   `useConnectionStore.getState().isOffline`; the `connectionStore` mock in
   `api.test.ts` gains the field. Same guard in `authStore`'s rehydrate failure
   branch and in `PwaLifecycleHandler.onResume`.

**Acceptance:** with `navigator.onLine === false` no `/health/live` request
and no reload happen and the amber banner renders; `isBackendDown` stays
false; existing 502 behaviour unchanged online; every existing test green.

## F2: IndexedDB layer and per-user database

**Files:** `frontend/package.json` and `frontend/package-lock.json` (devDependency `fake-indexeddb`; agreed in S1),
`frontend/src/lib/offline/storage.ts` (storage interface plus `MemoryStorage`),
`frontend/src/lib/offline/idb.ts` and its test, `frontend/src/lib/offline/offline-db.ts` and its test,
`frontend/src/store/authStore.ts` and its test, `frontend/src/components/settings/DangerZoneSection.tsx` and its test,
`frontend/src/store/persisted-storage.guard.test.ts` (a comment naming the two database names and why IndexedDB is outside the guard's scope; the guard itself is not widened).

**Steps:**

1. `idb.ts`: about 120 lines over the native API: `open` (version ladder in
   `onupgradeneeded`, `switch (oldVersion)` with no fallthrough gaps),
   `get`, `getAll`, `getAllFromIndex`, `put`, `delete`, `clear`, `count`, one
   read-write transaction helper, close on `versionchange`.
2. `offline-db.ts`: `openUserDb(userId)` opens `monize-offline-v1-<userId>`
   with the stores and indexes of design section 4.3; `openMetaDb()` opens
   `monize-offline-meta` with `lastUserId`; `clearMirrorOnLogout(userId)`
   clears `transactions`, the six reference stores, `singletons`, `meta` and
   `lastUserId`, never `outbox`, `idMap`, `syncIssues`; `deleteUserDb(userId)`.
3. `authStore`: `login` and `setUser` write `lastUserId`; `logout()` calls
   `clearMirrorOnLogout` through its existing dynamic-import pattern.
   `DangerZoneSection` calls `deleteUserDb` after the server confirmed the
   deletion.
4. `storage.ts`: the interface the engine, outbox and sync tests use, with a
   `MemoryStorage` so those tests need no IndexedDB.

**Acceptance:** `idb.test.ts` under `fake-indexeddb` proves the stores and
indexes, the upgrade ladder and per-user names; `offline-db.test.ts` proves
logout keeps the outbox, `idMap` and `syncIssues` and deletion removes
everything; coverage of the new files meets the gate.

## F3: Route whitelist, adapter, `OfflineError`, `externalId`

**Files:** `frontend/src/lib/offline/offline-routes.ts` and its test,
`frontend/src/lib/offline/offline-adapter.ts` and its test, `frontend/src/lib/offline/offline-errors.ts`,
`frontend/src/lib/offline/offline-copy.ts` and its test, `frontend/src/lib/errors.ts` and its test,
`frontend/src/lib/api.ts`, `frontend/src/lib/api.test.ts`, `frontend/src/types/axios.d.ts`,
`frontend/src/types/transaction.ts`, `frontend/src/i18n/messages/en/layout.json`.

**Steps:**

1. `offline-routes.ts`: `matchOfflineRoute(method, url, params)` returning
   `null` or `{ kind: 'read' | 'write', handler }` for exactly the read and
   write lists in design section 4.2. Matching uses `config.url` (relative)
   and the `params` object; no query-string parsing.
2. `offline-adapter.ts`: the algorithm of design section 4.2. The default
   adapter is resolved lazily on first call with
   `axios.getAdapter(axios.defaults.adapter)`. `isNetworkFailure(e)` is
   `!e.response && e.code !== 'ECONNABORTED' && e.code !== 'ERR_CANCELED'`.
   Synthetic responses are
   `{ data, status, statusText: 'OK', headers: { 'x-monize-offline': 'mirror' | 'queued' }, config, request: null }`.
   The adapter never imports `@/lib/api`. Pass-through for
   `config.monizeOffline === 'bypass'` and for a delegate context
   (`useAuthStore.getState().actingAsUserId !== null`). The read and write
   handlers are stubs in this task (F4 and F5 fill them) behind an exported
   `OFFLINE_ROUTES_ENABLED` constant that stays `false` until F6.
3. `types/axios.d.ts`: `declare module 'axios' { interface AxiosRequestConfig { monizeOffline?: 'bypass' } }`.
4. `api.ts`: pass `adapter: offlineAdapter` to `axios.create`; add
   `ensureExternalId(config)` to the request interceptor for
   `POST /transactions` and `POST /transactions/transfer` when the body has
   none (`crypto.randomUUID()`); never on PATCH.
5. `types/transaction.ts`: `externalId?: string` on `CreateTransactionData`
   and `CreateTransferData`.
6. `errors.ts` (offline): `OfflineError extends Error` with `code: 'offline'`
   and `reason: 'unavailable' | 'noData' | 'unsupportedQuery'`;
   `isOfflineError`. `lib/errors.ts` `showErrorToast` toasts the message from
   `offline-copy.ts`, a module-level copy table filled by a
   `useTranslations('layout')` effect in `ConnectivityWatcher`.

**Acceptance:** adapter tests with an injected network function: online
pass-through; bypass; delegate pass-through; offline whitelisted read calls
the read handler; offline other → `OfflineError('unavailable')`; network
failure on a read with mirror data → handler plus
`setOffline(true, 'probe')`; `api.test.ts` green with its existing axios mock;
a POST body gains `externalId` once and a caller-supplied one is kept;
a PATCH body never gains one.

## F4: Local register query and reference reads

**Files:** `frontend/src/lib/offline/transactions-query.ts` and its test,
`frontend/src/lib/offline/reference-reads.ts` and its test,
`frontend/src/lib/offline/balance-deltas.ts` and its test,
`frontend/src/lib/offline/offline-adapter.ts` (wire the handlers).

**Steps:**

1. `compareRegisterOrder(a, b, direction)` mirroring `applyRegisterOrder`
   in `backend/src/transactions/register-order.ts`: `transactionDate` by
   direction, `createdAt` by direction, `amount` by the opposite direction,
   `id` by direction.
2. `queryTransactionsOffline(storage, params)`: the supported params,
   defaults, cap and refusals of design section 4.4; the
   `PaginatedTransactions` shape; `startingBalance` only for a single
   account, no date filter, date sort: `roundMoney(seed + localDeltas(account)
   - sumMoney(rows listed newer than this page))`, VOID and child rows
   excluded, with `roundMoney` and `sumMoney` from `frontend/src/lib/format.ts`.
3. `balance-deltas.ts`: the delta map of design section 4.4, computed from
   the outbox entries' `baseRow` and `body`.
4. `reference-reads.ts`: handlers for `/accounts` (`includeInactive`;
   `currentBalance` adjusted by deltas), `/accounts/:id`, `/categories`,
   `/payees` (`status`), `/payees/aliases`, `/tags`, `/institutions`,
   `/scheduled-transactions`, `/users/preferences`, `/auth/profile`,
   `/auth/contexts`, `/transactions/:id`; an empty mirror answers
   `OfflineError('noData')`.

**Acceptance:** fixture test "same date and `createdAt`, one credit and one
debit: a DESC list shows the debit first"; page 2's seed on a 120-row
fixture equals the hand-computed server value with two pending deltas;
every refused param throws `OfflineError('unsupportedQuery')`; the
multi-account and date-filtered cases return no `startingBalance`.

## F5: Outbox and materialized rows

**Files:** `frontend/src/lib/offline/outbox.ts` and its test,
`frontend/src/lib/offline/materialize.ts` and its test,
`frontend/src/store/offlineStore.ts` and its test,
`frontend/src/lib/offline/offline-adapter.ts` (wire the write handlers),
`frontend/src/components/layout/BackendDownBanner.tsx` and its test (pending count).

**Steps:**

1. `OutboxEntry` exactly as in design section 4.5. `enqueue(storage, entry)`
   applies the mirror change and the entry in one IDB transaction, with the
   coalescing matrix of section 4.5 as a table-driven test.
2. `materialize.ts`: `materializeLocalRow(body, mirror)` and
   `materializeLocalTransfer(body, mirror)` as in section 4.4.
3. `offlineStore` (zustand, not persisted): `pendingTransactionIds: Set<string>`,
   `syncIssueCount`, `syncVersion`, `isSyncing`; `rebuildFromOutbox(storage)`.
4. Write handlers in the adapter for the write whitelist, answering the
   synthetic `201` (`200` when the `externalId` is already in the outbox).
5. `BackendDownBanner` shows the pending count from `offlineStore`.

**Acceptance:** the coalescing matrix passes; a materialized row satisfies
the `Transaction` type and renders in `TransactionRow` tests; a repeated
offline create with the same `externalId` adds no second entry.

## F6: Replay, conflicts, pull, triggers

**Files:** `frontend/src/lib/offline/sync.ts` and its test,
`frontend/src/lib/offline/pull.ts` and its test,
`frontend/src/components/providers/OfflineSyncProvider.tsx` and its test,
`frontend/src/app/layout.tsx`, `frontend/src/components/providers/PwaLifecycleHandler.tsx` and its test,
`frontend/src/lib/offline/offline-adapter.ts` (`OFFLINE_ROUTES_ENABLED` becomes `true`),
`frontend/src/lib/balance-cache.guard.test.ts` (only if the guard must name the new module).

**Steps:**

1. `replayOutbox(storage)`: single-flight through a module-level promise;
   every request with `monizeOffline: 'bypass'`; the six-step algorithm of
   design section 4.6, including `idMap` remapping, 200-as-success on a
   replayed create, GET-before-update with `deletedOnServer` and
   server-wins conflicts into `syncIssues`, DELETE 404 as done, stop on
   network failure with backoff, continue on 4xx with `failed`.
2. `pullMirror(storage)`: reference lists through the existing
   `accountsApi.getAll(true)`, `categoriesApi.getAll()`,
   `payeesApi.getAll('active')`, `payeesApi.getAllAliases()`, `tagsApi.getAll()`,
   `institutionsApi.getAll()`, `scheduledTransactionsApi.getAll()` with the
   bypass; per non-brokerage account `GET /transactions?accountIds=<id>&limit=1`
   for the seed; `transactionsApi.getAllPages({ startDate: today - window })`;
   replace the stores in one transaction; then `clearAllCache()` in this
   module; bump `syncVersion`; fire the refetch signal `useOnUndoRedo`
   subscribers listen to.
3. `OfflineSyncProvider`: effect on `user?.id` that replays a non-empty
   outbox when online; listeners for `online` and the Capacitor status change;
   a 15-minute interval while the document is visible; `PwaLifecycleHandler.onResume`
   calls `replayOutbox` on a visible resume.
4. Flip `OFFLINE_ROUTES_ENABLED` to `true`.

**Acceptance:** tests for order; remap through create, update, delete on one
client id; dedupe 200; conflict stores the issue and sends no PATCH; 404 on
update; mid-queue network failure keeps the rest pending; single-flight;
pull replaces the stores and calls `clearAllCache()`; `balance-cache.guard`
green.

## F7: Register badge and form guards

**Files:** `frontend/src/components/transactions/TransactionList.tsx` and its test,
`frontend/src/components/transactions/TransactionRow.tsx` and its test,
`frontend/src/components/transactions/PendingSyncBadge.tsx` and its test,
`frontend/src/components/transactions/TransactionForm.tsx` and its test,
`frontend/src/i18n/messages/en/transactions.json`.

**Steps:**

1. `TransactionList` reads `pendingTransactionIds` from `offlineStore` once
   and passes `isPendingSync` to `TransactionRow` the way it passes
   `isDeleting`.
2. `PendingSyncBadge` on `Badge` (`components/ui/Badge.tsx`),
   `data-testid="pending-sync-badge"`, rendered beside each `AttachmentBadge`
   site in `TransactionRow` (card, tier cell, wrapped).
3. `TransactionForm`: `handlePayeeCreate` offline clears `payeeId`, sets
   `payeeName` to the typed name and returns with a toast; `handleTagCreate`
   offline refuses with a toast; `performSubmit` refuses when
   `stagedAttachments.length > 0` offline; the FX effect is unchanged.

**Acceptance:** the badge renders only for pending ids in all three layouts;
form tests for the three guards; `ui-conventions.test.ts` green.

## F8: Service worker document cache and warmer

**Files:** `frontend/public/sw.js`, `frontend/src/test/sw-offline.test.ts`,
`frontend/src/components/providers/OfflineDocumentWarmer.tsx` and its test,
`frontend/src/app/layout.tsx`, `docs/frontend/pwa-push-share.md`.

**Steps:**

1. `sw.js`: `DOC_CACHE_NAME = 'monize-docs-v1'`,
   `OFFLINE_DOCUMENT_ROUTES = ['/dashboard', '/transactions', '/accounts', '/bills', '/settings', '/login']`,
   `WARM_MESSAGE_TYPE = 'monize-warm-documents'`; `DOC_CACHE_NAME` joins the
   activate keep-list.
2. `handleNavigation`: store a `200`, non-redirected response for a listed
   pathname under `self.location.origin + pathname` and return the original;
   on rejection or timeout answer the cached document, else
   `buildOfflineResponse()`.
3. `message` handler: beside the `monize-offline-strings` branch, accept
   `{ type: WARM_MESSAGE_TYPE, routes }`, keep only strings present in
   `OFFLINE_DOCUMENT_ROUTES`, fetch each with `credentials: 'include'` and
   `cache: 'no-store'`, store 200 HTML, then fetch into `CACHE_NAME` every
   `/_next/static/` script `src` and stylesheet `href` the HTML names that is
   not cached yet.
4. `OfflineDocumentWarmer`: the `OfflineFallbackSync` pattern; posts when
   `isAuthenticated && _hasHydrated && !isOffline`, and again on reconnect;
   calls the same `next/dynamic` imports the register uses for
   `TransactionForm`, `ScheduledTransactionForm`, `PayeeForm`, `CategoryForm`
   once. Mounted in `layout.tsx`.
5. `docs/frontend/pwa-push-share.md`: a section on the document cache and
   the warm message.

**Acceptance (in `sw-offline.test.ts`, harness unchanged):** a 200
navigation to a listed route is stored; a rejected fetch with a stored
document returns it; a hung fetch returns it after the timer; an unlisted
route still gets the 503 page; a 307 is not stored; the warm message fetches
only listed routes, stores the HTML and fetches the static assets it
references; a malformed `routes` is ignored; the first existing identity
assertion still holds.

## F9: Settings "Offline & sync" and header count

**Files:** `frontend/src/components/settings/OfflineSyncSection.tsx` and its test,
`frontend/src/app/settings/page.tsx` (register the section in `allSettingsSections`),
`frontend/src/components/layout/AppHeader.tsx` and its test,
`frontend/src/types/auth.ts` (window-length preference), `frontend/src/lib/user-settings.ts` if the preference shape needs it,
`frontend/src/i18n/messages/en/settings.json`, `frontend/src/i18n/messages/en/layout.json`.

**Steps:**

1. Section: last sync time, pending count, sync issues list (server row
   versus local payload; "Reapply" re-enqueues with the fresh
   `baseUpdatedAt`; "Discard" drops the issue), window length (30, 90, 180
   days) stored through `/users/preferences`, "Sync now", "Clear local data"
   (mirror only). Foldable like the other sections; hidden in demo mode.
2. `AppHeader`: a cloud icon with the pending count, linking to the
   section's id.

**Acceptance:** section tests cover every action with a fake storage;
`settingsSectionStore` fold state works for the new id; the header count
updates on `offlineStore` changes.

## M1: Capacitor shell

**Files (new layer):** the `mobile/` package manifest and lockfile, `mobile/capacitor.config.ts`,
`mobile/www/setup.html`, `mobile/android/` (generated by `npx cap add android`, then
`MainActivity.kt`, `AndroidManifest.xml`, the app `build.gradle` signing block reading env),
the `mobile/` readme and layer index (its own `CLAUDE.md`), `.gitignore` (Android build output),
`frontend/src/lib/native-shell.ts` and its test,
`frontend/src/app/login/page.tsx` and its test (remember-me default when native).

**Steps:**

1. The `mobile/` package manifest pins `@capacitor/core`, `@capacitor/cli`,
   `@capacitor/android`, `@capacitor/app`, `@capacitor/network` at or above
   the CVE-2026-103922 fix for the chosen major.
2. `MainActivity.kt`: read the origin from SharedPreferences; absent, load
   `www/setup.html`; present, build the Capacitor config at runtime with that
   `server.url`, `allowNavigation` for that host only and
   `appendUserAgent("MonizeAndroid/<versionName>")`. Verify the runtime
   config API of the pinned version; if unsupported, `loadUrl` after bridge
   initialisation and record it in the `mobile/` readme.
3. `www/setup.html`: plain HTML and JS; validates an `https://` origin,
   stores it through the `Preferences` bridge or a tiny plugin method, and
   restarts the activity. Colours from `frontend/src/lib/pwa-theme.ts`'s boot
   palette, copied as literals with a comment naming the source.
4. `frontend/src/lib/native-shell.ts`: `isNativeShell()` =
   `window.Capacitor?.isNativePlatform?.() === true`. The login page defaults
   "Remember me" on when native.
5. The `mobile/` layer index (its own `CLAUDE.md`): a short index (commands, layout, the one rule: the
   WebView loads the origin the user entered and nothing else).

**Acceptance:** a debug APK installs, asks for the origin once, loads the
login page, signs in with 2FA, survives an app restart signed in;
`isNativeShell()` tests cover present and absent bridge.

## M2: CSP for the native user agent

**Files:** `frontend/src/proxy.ts`, `frontend/src/proxy.test.ts`, `docs/frontend/README.md` (or the document the proxy section lives in).

**Steps:** when the request's user agent contains `MonizeAndroid/`,
`buildCspHeader` emits `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`
(dev keeps `'unsafe-eval'`) instead of the nonce plus `strict-dynamic` form;
every other directive unchanged. Record the decision and its reasoning
(design section 6.3).

**Acceptance:** proxy tests for both user agents; in the APK,
`window.Capacitor.Plugins.Network.getStatus()` resolves.

## M3: APK build and release

**Files:** `.github/workflows/android.yml`, `.github/workflows/ci.yml` (`npm-audit` and `license-check` include `mobile/`; the `release` job attaches the APK), `docs/release-integrity.md`.

**Steps:** on a release tag, `./gradlew assembleRelease` with the keystore
and passwords from repository secrets; attach the APK and its SHA-256 to the
GitHub Release; zizmor clean; the release note names the checksum.

**Acceptance:** a tag build produces an installable signed APK whose
checksum matches the release note. Changes under `.github/` are agreed in S1.

## W1: Wallet notification plugin (Kotlin)

**Files:** `mobile/plugins/wallet-notifications/` (`WalletNotificationListener.kt`,
`WalletNotificationParser.kt`, `WalletEventStore.kt`, `WalletNotificationsPlugin.kt`,
`src/test/.../WalletNotificationParserTest.kt`, `samples/*.json`),
`mobile/android/app/src/main/AndroidManifest.xml` (the service with
`BIND_NOTIFICATION_LISTENER_SERVICE`).

**Steps:**

1. Listener bound to `com.google.android.apps.walletnfcrel`; skip group
   summaries and ongoing notifications; persist `key`, `postTime`, title,
   text, bigText, the parse result or null, `ack = false` into SQLite
   `wallet_events`.
2. Parser from de-identified samples captured on the maintainer's device
   through `getRecentRaw`; raw text always kept.
3. Plugin methods `isAccessGranted`, `openAccessSettings`, `getPending`,
   `ack(ids)`, `getRecentRaw(limit)`.

**Acceptance:** parser unit tests pass on every sample; a real tap payment
appears in `getPending()` within seconds; `ack` removes it.

## W2: Wallet settings section

**Files:** `frontend/src/components/settings/WalletSection.tsx` and its test,
`frontend/src/app/settings/page.tsx`, `frontend/src/lib/wallet/wallet-plugin.ts` and its test (duck-typed bridge),
`frontend/src/lib/wallet/card-mapping.ts` and its test, `frontend/src/types/auth.ts` (card mapping and auto-create flag on `UserPreferences`),
`frontend/src/i18n/messages/en/settings.json`.

**Steps:** rendered only when `isNativeShell()`; permission status and
"Open settings"; a card mapping table (`cardLast4` or label to a Monize
account) stored in preferences through `frontend/src/lib/user-settings.ts`;
"Auto-create" toggle, default on; the last ten raw captures with their parse
result.

**Acceptance:** hidden in the browser; the mapping round-trips through
`/users/preferences`; tests with a fake plugin; the backend preference DTO
accepts the new fields (if it does not, that is a backend task to agree in
S1, not a drive-by).

## W3: Wallet ingest

**Files:** `frontend/src/lib/wallet/ingest.ts` and its test,
`frontend/src/components/providers/WalletIngestProvider.tsx` and its test,
`frontend/src/app/layout.tsx`, `frontend/src/i18n/messages/en/layout.json`.

**Steps:** on a visible resume and after each replay, `getPending()`; for
each parsed event with a mapped account, `transactionsApi.create` with
`externalId = 'gwallet:' + sha256(key + postTime)` (Web Crypto),
`status: 'pending'`, a negative `amount`, `payeeName = merchant`,
`description = 'Google Wallet'`, `referenceNumber = cardLast4`,
`transactionDate` from `postTime` in the device zone; `ack` only after the
promise resolved; unmapped or unparsed events toast once and stay listed.

**Acceptance:** tests for mapped, unmapped, unparsed and duplicate (a second
run with the same key creates nothing); on device a tap payment becomes a
`pending` row with the merchant as payee and the rules-applied category.

## Q1: Playwright offline spec

**Files:** `e2e/tests/offline.spec.ts`, `e2e/helpers/factories.ts` only if a helper is missing.

**Steps:** with `authedPage` and `api`: `createAccount`, `createTransaction`
with amount `321.45`; `goto('/transactions')`; expect the row; wait until
`page.evaluate` reports `navigator.serviceWorker.controller` and a cached
`/transactions` document; `page.context().setOffline(true)`; `page.reload()`;
expect the heading and the seeded row; create a transaction of `654.32`
through the dialog; expect `getByTestId('pending-sync-badge')` on that row;
`setOffline(false)`; expect the badge to disappear; `page.reload()` and
re-assert the row; `api.get('/transactions?accountIds=<id>')` has exactly one
`654.32` row. `afterEach` resets `setOffline(false)`. Locators scoped per
`frontend/src/test/e2e-conventions.test.ts`.

**Acceptance:** green on the chromium and firefox projects with
`--workers=1`.

## D1: Documentation and invariants

**Files:** `docs/frontend/offline.md`, `frontend/CLAUDE.md` (one row), a readme under `docs/mobile/`,
`docs/system-invariants.md` (INV-OFFLINE-001..003 as `partial`, with the mechanism and the test that holds each),
`docs/frontend/pwa-push-share.md`, `README.md` (an Android section).

**Acceptance:** `node scripts/check-docs-manifests.mjs` and
`backend/src/common/doc-paths.spec.ts` green; the invariant entries name the
guard test files from F3, F6 and W3.

## Q2: Full-locale i18n pass

**Files:** every `frontend/src/i18n/messages/<locale>/*.json` touched by F1 to W3.

**Acceptance:** `npm run i18n:check` green; no hand edits under `xx/`.
