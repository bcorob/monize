import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// The service worker is a classic script with no exports, so it is exercised the
// way the browser runs it: evaluated in a sandbox that captures its listeners,
// then driven through fake push and notificationclick events.
//
// What these tests are really about is trust. The payload arrives from an
// external push service, so `target` is an attacker-influenced string that the
// worker turns into a navigation. A worker is the last place that can be caught.

const swSource = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');

const ORIGIN = 'https://monize.test';

type Listener = (event: unknown) => unknown;

interface ShownNotification {
  title: string;
  options: {
    body: string;
    image?: string;
    icon: string;
    badge: string;
    tag: string;
    data: { target: string; reminderId?: string };
    actions?: { action: string; title: string }[];
  };
}

interface WindowClientStub {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate?: ReturnType<typeof vi.fn>;
}

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function loadServiceWorker(
  clients: WindowClientStub[] = [],
  fetchImpl: FetchStub = async () => new Response('', { status: 200 }),
  cookieStore?: { get: () => Promise<{ value: string } | null> },
) {
  const listeners: Record<string, Listener[]> = {};
  const shown: ShownNotification[] = [];
  const openWindow = vi.fn(async (url: string) => ({ url }));
  const resubscribe = vi.fn(async () => ({ endpoint: 'https://new.example' }));
  const posted: unknown[] = [];

  const context = vm.createContext({
    self: {
      cookieStore,
      addEventListener: (type: string, fn: Listener) => {
        (listeners[type] ??= []).push(fn);
      },
      skipWaiting: vi.fn(),
      location: { origin: ORIGIN },
      registration: {
        showNotification: vi.fn(async (title: string, options: never) => {
          shown.push({ title, options });
        }),
        pushManager: { subscribe: resubscribe },
      },
      clients: {
        claim: vi.fn(),
        matchAll: async () =>
          clients.map((client) => ({
            ...client,
            postMessage: (message: unknown) => posted.push(message),
          })),
        openWindow,
      },
    },
    caches: {
      open: async () => ({ match: async () => undefined, put: async () => {} }),
      match: async () => undefined,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: fetchImpl,
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) =>
      globalThis.clearTimeout(id),
    URL,
    Response,
    TextEncoder,
  });
  vm.runInContext(swSource, context);

  const dispatchPush = async (
    payload: unknown,
    options: { malformed?: boolean } = {},
  ) => {
    let pending: Promise<unknown> = Promise.resolve();
    const event = {
      data:
        payload === undefined
          ? null
          : {
              json: () => {
                if (options.malformed) throw new SyntaxError('not json');
                return payload;
              },
            },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    };
    for (const listener of listeners.push ?? []) listener(event);
    await pending;
  };

  const dispatchSubscriptionChange = async (
    oldSubscription: unknown,
    newSubscription?: unknown,
  ): Promise<void> => {
    let pending: Promise<unknown> = Promise.resolve();
    const event = {
      oldSubscription,
      newSubscription,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    };
    for (const listener of listeners.pushsubscriptionchange ?? []) {
      listener(event);
    }
    await pending;
  };

  const dispatchClick = async (data: unknown, action = '') => {
    let pending: Promise<unknown> = Promise.resolve();
    const close = vi.fn();
    const event = {
      action,
      notification: { data, close },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    };
    for (const listener of listeners.notificationclick ?? []) listener(event);
    await pending;
    return { close };
  };

  return {
    listeners,
    shown,
    openWindow,
    dispatchPush,
    dispatchClick,
    dispatchSubscriptionChange,
    resubscribe,
    posted,
  };
}

describe('service worker push handling', () => {
  it('registers both push listeners, so a deploy cannot ship half the feature', () => {
    const { listeners } = loadServiceWorker();

    expect(listeners.push).toHaveLength(1);
    expect(listeners.notificationclick).toHaveLength(1);
  });

  it('shows the server-composed title and body', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      type: 'TEST',
      title: 'Monize test notification',
      body: 'Push notifications are working on this device.',
      target: '/settings',
    });

    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe('Monize test notification');
    expect(sw.shown[0].options.body).toBe(
      'Push notifications are working on this device.',
    );
    expect(sw.shown[0].options.data.target).toBe('/settings');
  });

  it('renders the Stop action and carries the reminder id for a re-emitted nag', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      type: 'BILL_DUE',
      title: 'Payment reminder',
      body: 'b',
      target: '/bills',
      collapseKey: 'rem:rem-1',
      reminderId: 'rem-1',
      actions: [{ action: 'stop-reminder', title: 'Stop reminders' }],
    });

    expect(sw.shown[0].options.actions).toEqual([
      { action: 'stop-reminder', title: 'Stop reminders' },
    ]);
    expect(sw.shown[0].options.data.reminderId).toBe('rem-1');
  });

  it('drops an action it does not handle and a reminder id that is not a short string', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      type: 'BILL_DUE',
      title: 'a',
      body: 'b',
      reminderId: { not: 'a string' },
      actions: [
        { action: 'open-vault', title: 'Open' },
        { action: 'stop-reminder', title: '' },
        'not an object',
      ],
    });

    // A button whose id nothing branches on would be a button that does
    // nothing, and a title-less button is unlabelled: neither is rendered.
    expect(sw.shown[0].options.actions).toEqual([]);
    expect(sw.shown[0].options.data.reminderId).toBeUndefined();
  });

  it('groups repeats of one subject onto a single notification', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      type: 'PRICE_REFRESH_FAILED',
      title: 'a',
      body: 'b',
    });

    expect(sw.shown[0].options.tag).toBe('PRICE_REFRESH_FAILED');
  });

  // The tag decides whether a second notification REPLACES the first, and the
  // type is not the subject: two bills due on the same day are both BILL_DUE.
  // The subject is the payload's own `collapseKey` -- deliberately not its
  // target, because the bill producer sends every reminder to `/bills`, so a tag
  // built from the route would collapse exactly the case it must separate.
  it('lets two subjects of one type stack instead of replacing each other', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      type: 'BILL_DUE',
      title: 'Hydro is due',
      body: 'b',
      target: '/bills',
      collapseKey: 'st-1',
    });
    await sw.dispatchPush({
      type: 'BILL_DUE',
      title: 'Rent is due',
      body: 'b',
      target: '/bills',
      collapseKey: 'st-2',
    });

    expect(sw.shown).toHaveLength(2);
    expect(sw.shown[0].options.tag).not.toBe(sw.shown[1].options.tag);
  });

  it('still collapses two pushes about the same subject', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      type: 'BILL_DUE',
      title: 'Hydro is due',
      body: 'b',
      target: '/bills',
      collapseKey: 'st-1',
    });
    await sw.dispatchPush({
      type: 'BILL_DUE',
      title: 'Hydro is due tomorrow',
      body: 'b',
      target: '/bills',
      collapseKey: 'st-1',
    });

    expect(sw.shown[0].options.tag).toBe(sw.shown[1].options.tag);
  });

  // A payload with no key is saying its type IS the subject, which is what a
  // system alert or a test send means.
  it.each([
    ['no key at all', undefined],
    ['an empty key', ''],
    ['a key that is not a string', 42],
  ])('groups by type given %s', async (_name, collapseKey) => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      type: 'PRICE_REFRESH_FAILED',
      title: 'a',
      body: 'b',
      collapseKey,
    });

    expect(sw.shown[0].options.tag).toBe('PRICE_REFRESH_FAILED');
  });

  // The route never enters the tag. Same subject, two paths: still one bucket.
  it('ignores the target when deciding what collapses', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      type: 'BILL_DUE',
      title: 'a',
      body: 'b',
      target: '/bills',
      collapseKey: 'st-1',
    });
    await sw.dispatchPush({
      type: 'BILL_DUE',
      title: 'a',
      body: 'b',
      target: '/budgets',
      collapseKey: 'st-1',
    });

    expect(sw.shown[0].options.tag).toBe(sw.shown[1].options.tag);
  });

  it('falls back to one bucket when the payload names no type', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({ title: 'a', body: 'b' });

    expect(sw.shown[0].options.tag).toBe('monize');
  });

  // A push with no readable payload still has to produce a notification: the
  // browser showed the user *something* was delivered, and a silent push is a
  // permission violation in most browsers.
  it.each([
    ['no data at all', undefined, false],
    ['a payload that is not JSON', undefined, true],
  ])(
    'falls back to generic copy given %s',
    async (_name, payload, malformed) => {
      const sw = loadServiceWorker();

      await sw.dispatchPush(payload, { malformed });

      expect(sw.shown).toHaveLength(1);
      expect(sw.shown[0].title).toBe('Monize');
      expect(sw.shown[0].options.data.target).toBe('/');
    },
  );

  it('ignores a title or body that is not a usable string', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({ title: 42, body: '', target: '/x' });

    expect(sw.shown[0].title).toBe('Monize');
    expect(sw.shown[0].options.body).toContain('notification');
  });

  // The security case. Each of these is a value an external push service could
  // deliver, and each one would be a navigation off this origin if the worker
  // trusted it.
  it.each([
    ['an absolute URL', 'https://evil.test/steal'],
    ['a protocol-relative host', '//evil.test/steal'],
    ['a backslash host Chrome normalises', '/\\evil.test/steal'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>1</script>'],
    ['a relative path', 'settings'],
    ['a number', 7],
    ['null', null],
    // WHATWG URL strips ASCII tab, CR and LF before parsing, so each of these
    // reads as a protocol-relative host while looking like an ordinary path to
    // any guard written against the characters. This is why the check resolves
    // the value instead of inspecting it.
    ['a tab hiding a protocol-relative host', '/\t/evil.test/steal'],
    ['a newline hiding one', '/\n//evil.test'],
    ['a carriage return hiding one', '/\r\t/evil.test'],
  ])('discards %s as a navigation target', async (_name, target) => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({ title: 't', body: 'b', target });

    expect(sw.shown[0].options.data.target).toBe('/');
  });

  // Not every stripped-whitespace value is hostile: this one still resolves to
  // this origin, so it is kept -- as the parser's own normalised path, which is
  // what the click will actually navigate to.
  it('normalises a same-origin target rather than discarding it', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({ title: 't', body: 'b', target: '/\thttps://x' });

    expect(sw.shown[0].options.data.target).toBe('/https://x');
  });

  it('keeps a same-origin path, query and fragment', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      title: 't',
      body: 'b',
      target: '/transactions?accountId=abc#row-1',
    });

    expect(sw.shown[0].options.data.target).toBe(
      '/transactions?accountId=abc#row-1',
    );
  });

  it('discards an absurdly long target rather than navigating to it', async () => {
    const sw = loadServiceWorker();

    await sw.dispatchPush({
      title: 't',
      body: 'b',
      target: `/${'a'.repeat(600)}`,
    });

    expect(sw.shown[0].options.data.target).toBe('/');
  });
});

describe('service worker notification clicks', () => {
  it('navigates an open window rather than opening a second one', async () => {
    const client = {
      url: `${ORIGIN}/dashboard`,
      focus: vi.fn(),
      navigate: vi.fn(async () => undefined),
    };
    const sw = loadServiceWorker([client]);

    await sw.dispatchClick({ target: '/settings' });

    expect(client.navigate).toHaveBeenCalledWith(`${ORIGIN}/settings`);
    expect(client.focus).toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window when none is available', async () => {
    const sw = loadServiceWorker([]);

    await sw.dispatchClick({ target: '/settings' });

    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/settings`);
  });

  it('still focuses a window that refuses to navigate', async () => {
    const client = {
      url: `${ORIGIN}/dashboard`,
      focus: vi.fn(),
      navigate: vi.fn(async () => {
        throw new Error('navigation not allowed');
      }),
    };
    const sw = loadServiceWorker([client]);

    await sw.dispatchClick({ target: '/settings' });

    expect(client.focus).toHaveBeenCalled();
  });

  it('ignores a window on another origin', async () => {
    const foreign = {
      url: 'https://evil.test/',
      focus: vi.fn(),
      navigate: vi.fn(),
    };
    const sw = loadServiceWorker([foreign]);

    await sw.dispatchClick({ target: '/settings' });

    expect(foreign.focus).not.toHaveBeenCalled();
    expect(foreign.navigate).not.toHaveBeenCalled();
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/settings`);
  });

  it('closes the notification it acted on', async () => {
    const sw = loadServiceWorker([]);

    const { close } = await sw.dispatchClick({ target: '/settings' });

    expect(close).toHaveBeenCalled();
  });

  // The stored `data` is not more trustworthy than the payload it came from: it
  // IS the payload, and a worker built before this rule would have carried a
  // hostile target through to `openWindow`.
  it.each([
    'https://evil.test/steal',
    '//evil.test/steal',
    'javascript:alert(1)',
    '/\t/evil.test/steal',
  ])('never navigates to %s from stored notification data', async (target) => {
    const sw = loadServiceWorker([]);

    await sw.dispatchClick({ target });

    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it('opens the app root when the notification carries no data', async () => {
    const sw = loadServiceWorker([]);

    await sw.dispatchClick(undefined);

    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});

describe('service worker subscription rotation', () => {
  const KEY = new Uint8Array([1, 2, 3]).buffer;

  // A browser may rotate a subscription on its own. The old endpoint stops
  // working and the stored row keeps naming it, so delivery just stops -- and
  // with only a manual test send in the product, nothing retires the row.
  it('resubscribes with the key the old subscription carried', async () => {
    const sw = loadServiceWorker([]);

    await sw.dispatchSubscriptionChange({
      options: { applicationServerKey: KEY },
    });

    expect(sw.resubscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: KEY,
    });
  });

  // The worker cannot register the replacement itself: the API is CSRF-protected
  // by a double-submit cookie it has no portable way to read. It tells the page,
  // which has the session and the token.
  it('tells every open window so the page can register the replacement', async () => {
    const sw = loadServiceWorker([
      { url: `${ORIGIN}/settings`, focus: vi.fn() },
    ]);

    await sw.dispatchSubscriptionChange({
      options: { applicationServerKey: KEY },
    });

    expect(sw.posted).toEqual([{ type: 'monize-push-subscription-changed' }]);
  });

  // Firefox -- where Web Push is most used -- fires this event with no
  // oldSubscription at all, and so did Chrome before the event's properties
  // shipped. Reading only the old one meant the browsers that need this handler
  // most got nothing out of it.
  it('falls back to the new subscription for the key', async () => {
    const sw = loadServiceWorker([]);

    await sw.dispatchSubscriptionChange(undefined, {
      options: { applicationServerKey: KEY },
    });

    expect(sw.resubscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: KEY,
    });
  });

  // With no key there is nothing to subscribe with -- but the page holds the
  // session and the CSRF token this worker cannot read, so it can do the whole
  // thing itself. Staying silent left an open settings panel knowing nothing.
  it.each([
    ['neither subscription carries a key', { options: {} }, undefined],
    ['the event carries no subscriptions at all', undefined, undefined],
  ])('still tells the page when %s', async (_name, oldSub, newSub) => {
    const sw = loadServiceWorker([
      { url: `${ORIGIN}/settings`, focus: vi.fn() },
    ]);

    await sw.dispatchSubscriptionChange(oldSub, newSub);

    expect(sw.resubscribe).not.toHaveBeenCalled();
    expect(sw.posted).toEqual([{ type: 'monize-push-subscription-changed' }]);
  });

  // A failed resubscribe is exactly when the page needs to know: the panel is
  // the durable path, and it can ask the user.
  it('tells the page even when resubscribing fails', async () => {
    const sw = loadServiceWorker([
      { url: `${ORIGIN}/settings`, focus: vi.fn() },
    ]);
    sw.resubscribe.mockRejectedValue(new Error('permission revoked'));

    await sw.dispatchSubscriptionChange({
      options: { applicationServerKey: KEY },
    });

    expect(sw.posted).toEqual([{ type: 'monize-push-subscription-changed' }]);
  });

  it('does not reject when resubscribing fails', async () => {
    const sw = loadServiceWorker([]);
    sw.resubscribe.mockRejectedValue(new Error('permission revoked'));

    await expect(
      sw.dispatchSubscriptionChange({ options: { applicationServerKey: KEY } }),
    ).resolves.toBeUndefined();
  });
});

// The Stop action posts with the session cookie, which outlives the app by
// fifteen minutes at most -- and a nag arrives precisely when the app has been
// idle, so the common case is a 401. One same-origin refresh and one retry turn
// that into a stop; a stop that still fails opens the app instead of leaving
// the nag running with nothing to show for the tap.
describe('the Stop action on a reminder push', () => {
  const store = { get: async () => ({ value: 'csrf-before-refresh' }) };
  const calls: { url: string; method?: string }[] = [];
  const fetchScript = (statuses: number[]): FetchStub => {
    calls.length = 0;
    const queue = [...statuses];
    return async (url, init) => {
      calls.push({ url, method: init?.method });
      return new Response('', { status: queue.shift() ?? 200 });
    };
  };

  it('stops the reminder without opening a window when the session is live', async () => {
    const sw = loadServiceWorker([], fetchScript([200]), store);
    await sw.dispatchClick(
      { target: '/bills', reminderId: 'rem-1' },
      'stop-reminder',
    );
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/notifications/reminders/rem-1/stop',
    ]);
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('refreshes the session once and retries when the stop answers 401', async () => {
    const sw = loadServiceWorker([], fetchScript([401, 200, 200]), store);
    await sw.dispatchClick(
      { target: '/bills', reminderId: 'rem-1' },
      'stop-reminder',
    );
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/notifications/reminders/rem-1/stop',
      '/api/v1/auth/refresh',
      '/api/v1/notifications/reminders/rem-1/stop',
    ]);
    expect(calls[1].method).toBe('POST');
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('opens the app at the target when the refresh fails too, rather than leaving the nag running', async () => {
    const sw = loadServiceWorker([], fetchScript([401, 401]), store);
    await sw.dispatchClick(
      { target: '/bills', reminderId: 'rem-1' },
      'stop-reminder',
    );
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/notifications/reminders/rem-1/stop',
      '/api/v1/auth/refresh',
    ]);
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/reminders`);
  });

  it('does not retry a refusal that is not a session problem', async () => {
    const sw = loadServiceWorker([], fetchScript([403]), store);
    await sw.dispatchClick(
      { target: '/bills', reminderId: 'rem-1' },
      'stop-reminder',
    );
    expect(calls).toHaveLength(1);
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/reminders`);
  });
});

describe('worker Stop without Cookie Store', () => {
  const tokenUrl = '/api/v1/auth/csrf-refresh';
  const stopUrl = '/api/v1/notifications/reminders/rem-1/stop';
  const refreshUrl = '/api/v1/auth/refresh';

  it.each(['absent', 'throws', 'empty'])(
    'obtains a token over authenticated JSON when Cookie Store is %s',
    async (kind) => {
      const fetcher = vi.fn<FetchStub>(async (url) =>
        url === tokenUrl
          ? Response.json({ csrfToken: 'server-token' })
          : new Response('', { status: 201 }),
      );
      const store =
        kind === 'absent'
          ? undefined
          : {
              get: async () => {
                if (kind === 'throws') throw new Error('unavailable');
                return null;
              },
            };
      const sw = loadServiceWorker([], fetcher, store);
      await sw.dispatchClick({ reminderId: 'rem-1' }, 'stop-reminder');
      expect(fetcher.mock.calls).toEqual([
        [
          tokenUrl,
          {
            method: 'GET',
            credentials: 'include',
            mode: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
          },
        ],
        [
          stopUrl,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'X-CSRF-Token': 'server-token' },
          },
        ],
      ]);
      expect(sw.openWindow).not.toHaveBeenCalled();
    },
  );

  it('refreshes once when token acquisition finds an expired session', async () => {
    const fetcher = vi
      .fn<FetchStub>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(Response.json({ csrfToken: 'new-token' }))
      .mockResolvedValueOnce(new Response('', { status: 201 }));
    const sw = loadServiceWorker([], fetcher);
    await sw.dispatchClick({ reminderId: 'rem-1' }, 'stop-reminder');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      tokenUrl,
      refreshUrl,
      tokenUrl,
      stopUrl,
    ]);
    expect(fetcher.mock.calls[3][1]?.headers).toEqual({
      'X-CSRF-Token': 'new-token',
    });
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('reacquires the JSON token if the session expires between GET and Stop', async () => {
    const fetcher = vi
      .fn<FetchStub>()
      .mockResolvedValueOnce(Response.json({ csrfToken: 'old-token' }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(Response.json({ csrfToken: 'new-token' }))
      .mockResolvedValueOnce(new Response('', { status: 201 }));
    const sw = loadServiceWorker([], fetcher);
    await sw.dispatchClick({ reminderId: 'rem-1' }, 'stop-reminder');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      tokenUrl,
      stopUrl,
      refreshUrl,
      tokenUrl,
      stopUrl,
    ]);
    expect(fetcher.mock.calls[4][1]?.headers).toEqual({
      'X-CSRF-Token': 'new-token',
    });
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { csrfToken: '' },
    { csrfToken: 42 },
    { csrfToken: 'x'.repeat(513) },
  ])('never posts Stop with a malformed token response %j', async (body) => {
    const fetcher = vi.fn<FetchStub>(async () => Response.json(body));
    const sw = loadServiceWorker([], fetcher);
    await sw.dispatchClick({ reminderId: 'rem-1' }, 'stop-reminder');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/reminders`);
  });

  it.each(['forbidden', 'network', 'invalid-json', 'expired-after-refresh'])(
    'falls back without an unbounded retry on %s',
    async (failure) => {
      const fetcher = vi.fn<FetchStub>(async (url) => {
        if (url === refreshUrl) return new Response('', { status: 200 });
        if (failure === 'network') throw new Error('offline');
        if (failure === 'invalid-json') return new Response('not json');
        return new Response('', {
          status: failure === 'forbidden' ? 403 : 401,
        });
      });
      const sw = loadServiceWorker([], fetcher);
      await sw.dispatchClick({ reminderId: 'rem-1' }, 'stop-reminder');
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
        failure === 'expired-after-refresh'
          ? [tokenUrl, refreshUrl, tokenUrl]
          : [tokenUrl],
      );
      expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/reminders`);
    },
  );

  it('reads the rotated Cookie Store token after refreshing the session', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ value: 'old-token' })
      .mockResolvedValueOnce({ value: 'new-token' });
    const fetcher = vi
      .fn<FetchStub>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 201 }));
    const sw = loadServiceWorker([], fetcher, { get });
    await sw.dispatchClick({ reminderId: 'rem-1' }, 'stop-reminder');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      stopUrl,
      refreshUrl,
      stopUrl,
    ]);
    expect(fetcher.mock.calls[2][1]?.headers).toEqual({
      'X-CSRF-Token': 'new-token',
    });
    expect(sw.openWindow).not.toHaveBeenCalled();
  });
});


describe('push chart image paths', () => {
  const image = `/api/v1/push/chart/${'a'.repeat(64)}.1790000000000.${'b'.repeat(64)}.png`;
  it('passes the bounded same-origin chart route to the notification', async () => {
    const sw = loadServiceWorker();
    await sw.dispatchPush({ title: 'Price', body: 'Price changed', image });
    expect(sw.shown[0].options.image).toBe(image);
  });
  it.each([null, 42, '//evil.test/a.png', 'https://evil.test/a.png', '/api/v1/push/chart/../../secrets', image + '?q=1', image + '#a', image + '/extra', image.replace('.png', '%2epng')])('drops unsafe image %s without dropping text', async (image) => {
    const sw = loadServiceWorker();
    await sw.dispatchPush({ title: 'Price', body: 'Price changed', image });
    expect(sw.shown[0].options.image).toBeUndefined();
    expect(sw.shown[0].options.body).toBe('Price changed');
  });
});
