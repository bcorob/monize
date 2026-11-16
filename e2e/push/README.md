# Chromium push integration

Run from `e2e`:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:push
```

The separate configuration needs no application stack, account or PostgreSQL.
Every test owns a loopback HTTP server and browser context. The server serves
`frontend/public/sw.js` unchanged and records worker API requests. Chromium
receives push payloads through CDP `ServiceWorker.deliverPushMessage`, as with
the DevTools push simulator. Notification storage, worker activation, cookies,
Cookie Store, fetch and existing-window navigation are browser implementations.

OS notification buttons are not exposed as Playwright locators. Click tests
create a NotificationEvent from a real stored notification and dispatch it in
the worker. Only that event's waitUntil is replaced with an awaited promise
collector: synthetic events are untrusted and cannot extend browser lifetime
([Service Workers specification](https://www.w3.org/TR/service-workers/#dom-extendableevent-waituntil)).
These tests therefore do not prove native OS clicks or worker lifetime extension.

Coverage: displayed copy; same-subject replacement versus distinct subjects;
safe and hostile navigation targets; Stop with real session and CSRF cookies;
one refresh/retry on 401 with a rotated CSRF cookie; failed Stop navigation to
the reminders page; JSON CSRF acquisition when Cookie Store is deliberately
removed from Chromium to exercise the portable worker path. This last case
does not substitute for native Firefox/Safari action-delivery verification.

The API is a controlled response server, not NestJS: authorization, RLS and
server-side CSRF enforcement remain covered by backend tests. External push
subscription, encryption/VAPID, network delivery, operating-system banners,
closed-app wakeup and Firefox/Safari still require the manual push pass.
A passing suite must report non-zero tests. Missing Chromium is a failed setup,
not a skip and not proof of the push flow.
