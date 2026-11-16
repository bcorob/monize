import { test as base, expect, type Worker } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../../frontend/public/sw.js'), 'utf8');
export type RequestRecord = { path: string; method: string; cookie: string; csrf: string };
type PushHarness = {
  origin: string;
  requests: RequestRecord[];
  stopStatuses: number[];
  refreshStatus: number;
  worker: Worker;
  push: (payload: unknown) => Promise<void>;
  click: (action?: string) => Promise<void>;
};

/** How long one push may take to become visible before the test gives up. */
const PUSH_DELIVERY_TIMEOUT_MS = 10_000;

/** How long one delivery may take to reach the worker before it is sent again. */
const PUSH_HANDLER_WAIT_MS = 1_000;

type ShowState = { calls: number; title: string | null; tag: string | null };

/**
 * What `sw.js` has finished showing in this worker instance.
 *
 * Self-installing, because the record lives in the worker's global scope and a
 * worker Chromium stops for idleness loses it along with everything else; the
 * caller detects that as `calls` going backwards.
 *
 * The wrapper counts a call when the worker's own `showNotification` promise
 * RESOLVES, so `calls` moving means the product handled the push and finished
 * its side of the work -- one fact, rather than the two ("a push arrived" and
 * "something was shown") a bare `push` listener would leave the caller to
 * correlate.
 */
async function showState(worker: Worker): Promise<ShowState> {
  return worker.evaluate(() => {
    const scope = self as unknown as ServiceWorkerGlobalScope & {
      __monizeShown?: ShowState;
    };
    if (scope.__monizeShown === undefined) {
      const state: ShowState = { calls: 0, title: null, tag: null };
      scope.__monizeShown = state;
      const registration = scope.registration;
      const show = registration.showNotification.bind(registration);
      registration.showNotification = (title, options) =>
        show(title, options).then(() => {
          state.calls += 1;
          state.title = title;
          state.tag = options?.tag ?? null;
        });
    }
    return { ...scope.__monizeShown };
  });
}

export const test = base.extend<{ pushHarness: PushHarness }>({
  pushHarness: async ({ page, context }, use) => {
    const requests: RequestRecord[] = [];
    const state = { stopStatuses: [201], refreshStatus: 200, csrfToken: 'browser-csrf' };
    const server = createServer((req, res) => {
      const path = req.url ?? '/';
      if (path.startsWith('/api/')) {
        requests.push({
          path,
          method: req.method ?? '',
          cookie: req.headers.cookie ?? '',
          csrf: String(req.headers['x-csrf-token'] ?? ''),
        });
        res.setHeader('Content-Type', 'application/json');
        if (path === '/api/v1/auth/csrf-refresh') {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Set-Cookie', `csrf_token=${state.csrfToken}; Path=/; SameSite=Lax`);
          res.end(JSON.stringify({ csrfToken: state.csrfToken }));
        } else {
          res.statusCode =
            path === '/api/v1/auth/refresh'
              ? state.refreshStatus
              : req.headers['x-csrf-token'] === state.csrfToken
                ? (state.stopStatuses.shift() ?? 201)
                : 403;
          if (path === '/api/v1/auth/refresh' && res.statusCode === 200) {
            state.csrfToken = 'browser-csrf-refreshed';
            res.setHeader('Set-Cookie', `csrf_token=${state.csrfToken}; Path=/; SameSite=Lax`);
          }
          res.end(JSON.stringify({ stopped: true }));
        }
      } else if (path === '/sw.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(source);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><title>Push browser fixture</title><main><button id="activate">Activate test window</button></main>',
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server port');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await context.grantPermissions(['notifications'], { origin });
      await context.addCookies([
        { name: 'csrf_token', value: 'browser-csrf', url: origin },
        { name: 'session', value: 'browser-session', url: origin, httpOnly: true },
      ]);
      await page.goto(origin + '/initial');
      const cdp = await context.newCDPSession(page);
      let registrationId = '';
      cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
        for (const registration of registrations) {
          if (registration.scopeURL === origin + '/' && !registration.isDeleted)
            registrationId = registration.registrationId;
        }
      });
      await cdp.send('ServiceWorker.enable');
      const readyWorker = context.waitForEvent('serviceworker');
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
      });
      const worker = await readyWorker;
      await expect.poll(() => registrationId).not.toBe('');
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await use({
        origin,
        requests,
        worker,
        get stopStatuses() {
          return state.stopStatuses;
        },
        set stopStatuses(value) {
          state.stopStatuses = value;
        },
        get refreshStatus() {
          return state.refreshStatus;
        },
        set refreshStatus(value) {
          state.refreshStatus = value;
        },
        // Deliver a push and do not return until its notification is one the
        // browser will hand back.
        //
        // Two separate things make a naive delivery unreliable, and only the
        // second one was actually behind the CI flake:
        //
        // 1. `ServiceWorker.deliverPushMessage` resolves when the browser
        //    accepts the command, NOT when the worker handles it, and nothing
        //    retries a message the browser drops.
        // 2. `registration.getNotifications()` is DESTRUCTIVE while a display
        //    is in flight. Chromium answers it by reconciling its stored
        //    notification records against what the platform reports as
        //    displayed, and a record whose display has not landed yet is not
        //    reported "not yet" -- it is erased. `showNotification` resolves
        //    BEFORE the display reaches the platform, so a read taken straight
        //    after it deletes the very notification the test is waiting for,
        //    and every later poll then spends its whole 5s waiting for
        //    something that can no longer arrive.
        //
        // That is exactly what CI showed: one test of the nine failing on a
        // notification assertion with the full timeout burned, a different test
        // each run, on branches whose diffs cannot touch push. Instrumenting
        // the worker settled it -- `showNotification` had been called and had
        // resolved, and `getNotifications()` stayed empty for the whole poll
        // and after it.
        //
        // There is no non-destructive way to observe a displayed notification,
        // so the harness cannot poll its way out of the race -- polling is what
        // does the damage. Instead it looks exactly ONCE per delivery, after
        // the worker's own `showNotification` promise has resolved, and a look
        // that came too early is repaired by DELIVERING AGAIN rather than by
        // looking again. A repeat cannot double a notification: `sw.js` tags
        // every one with `collapseTag(payload)`, so a repeat REPLACES rather
        // than stacks, and that is the property the first test in this file
        // asserts.
        //
        // Waiting on that promise is most of the fix on its own -- it moves the
        // look past the window the old harness read in, which returned as soon
        // as the CDP command was accepted. The re-delivery is what makes the
        // remainder converge instead of failing.
        push: async (payload) => {
          const deliver = () =>
            cdp.send('ServiceWorker.deliverPushMessage', {
              origin,
              registrationId,
              data: JSON.stringify(payload),
            });

          const deadline = Date.now() + PUSH_DELIVERY_TIMEOUT_MS;
          let unmet = 'nothing was delivered';

          for (;;) {
            let before = await showState(worker);
            await deliver();

            const handledBy = Date.now() + PUSH_HANDLER_WAIT_MS;
            let handled: ShowState | null = null;
            for (;;) {
              const now = await showState(worker);
              if (now.calls > before.calls) {
                handled = now;
                break;
              }
              // A worker Chromium restarted counts from zero again, and our
              // delivery went down with the instance that was stopped. Re-base
              // rather than waiting for a count that can no longer be reached.
              if (now.calls < before.calls) before = now;
              if (Date.now() >= handledBy) break;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }

            if (handled !== null) {
              const wanted = handled;
              const displayed = await shown(worker);
              if (displayed.some((n) => n.title === wanted.title && n.tag === wanted.tag)) return;
              unmet = 'the worker showed it but the browser never listed it';
            } else {
              unmet = 'the worker never received it';
            }

            if (Date.now() >= deadline) {
              throw new Error(
                `Push never became visible after ${PUSH_DELIVERY_TIMEOUT_MS}ms ` +
                  `(${unmet}): ${JSON.stringify(payload)}`,
              );
            }
          }
        },
        // Chromium does not expose OS notification buttons through Playwright.
        // Dispatch the click inside the real worker using a real stored Notification.
        click: async (action = '') => {
          await page.locator('#activate').click();
          await worker.evaluate(async (action) => {
            const scope = self as unknown as ServiceWorkerGlobalScope;
            const notifications = await scope.registration.getNotifications();
            if (notifications.length !== 1)
              throw new Error(`Expected one notification, got ${notifications.length}`);
            const event = new NotificationEvent('notificationclick', {
              notification: notifications[0],
              action,
            });
            // Synthetic events cannot extend browser lifetime (isTrusted=false).
            // Collect this event's work explicitly; do not replace fetch, cookies,
            // notification storage or window-client APIs.
            const pending: Promise<unknown>[] = [];
            Object.defineProperty(event, 'waitUntil', {
              value: (promise: Promise<unknown>) => pending.push(promise),
            });
            scope.dispatchEvent(event);
            await Promise.all(pending);
          }, action);
        },
      });
      await cdp.detach();
    } finally {
      await context.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
});
export { expect };

export async function shown(worker: Worker) {
  return worker.evaluate(async () => {
    const scope = self as unknown as ServiceWorkerGlobalScope;
    return (await scope.registration.getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      data: n.data,
    }));
  });
}
