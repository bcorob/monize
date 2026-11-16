---
title: "Android offline app: shell choice, auth reach, idempotency"
author: Ken
date: 2026-10-19
branch: feat/email-receipt-dividend-trades
cost: { minutes: 6, tokens: 7363 }
touches:
  - frontend/src/lib/api.ts
---

## Decided
- Android app = Capacitor WebView loading the live Monize origin (`server.url`), not a static export. 63/64 pages are client components, but root layout, root page, manifest route and `src/i18n/request.ts` use `headers()`/`cookies()`, `proxy.ts` is middleware and 9 `[id]` routes have no `generateStaticParams`, so `output: 'export'` needs a build-variant swap. Live origin keeps cookies first-party, so 2FA/OIDC/CSRF stay untouched.
- Offline layer belongs at the single API door `frontend/src/lib/api.ts` (43 lib modules import `apiClient`, none bypass it): IndexedDB mirror + outbox + sync engine, also usable by the PWA.
- Outbox idempotency rides `externalId` on `POST /transactions` / `transfer` / `bulk` (unique per account, repeat returns the existing row, INV-API-001). No `Idempotency-Key` exists; none needed.
- Pull = window re-fetch (last N days via `transactionsApi.getAllPages`) and replace; deletes are hard (no tombstones), so replacement is the delete signal.
- Wallet rows auto-create as `pending` with `externalId = gwallet:<hash>`, `payeeName` for payee resolution, rules do category.
- Native-UA CSP: Capacitor injects its bridge inline; `proxy.ts` must drop nonce + `strict-dynamic` for `MonizeAndroid/` UA.

## Tried and ruled out
- Bearer-token native auth: JWT strategy accepts `Authorization: Bearer`, but login/refresh deliver tokens only as httpOnly cookies, refresh reads only the cookie, and the global CSRF guard has no bearer exemption. PATs and OAuth tokens are validated only in `mcp-http.controller.ts`, never on REST.
- Action history as a change feed: capped 100 rows / 30 days, not written by every path.
- `updatedSince` delta sync: no such param on any list; no index on `transactions.updated_at`.
- TWA/Bubblewrap: no JS bridge for a NotificationListenerService.

## Watch out
- Capacitor remote-content CVE-2026-103922: pin >= 7.6.9 / 8.5.1.
- Google Wallet notification text format is undocumented; parser must be built from on-device captures and keep raw text.
- File import has no dedupe and bank sync dedupes only against its own keys, so a Wallet/manual row + later bank import = duplicate (existing gap).
- Refresh token lasts 1 day unless remember-me (`REMEMBER_ME_DAYS`, 30); native login should default remember-me on. Concurrent refreshes revoke the family.
- `authStore.logout()` clears caches; an outbox must be namespaced per user and survive logout.
