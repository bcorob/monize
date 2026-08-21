import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { BOOT_BACKGROUND, BOOT_FOREGROUND } from '@/lib/pwa-theme';
import enLayout from '@/i18n/messages/en/layout.json';

// The service worker is a classic script with no exports, so it is exercised
// the way the browser runs it: evaluated in a sandbox that captures its event
// listeners, then driven through fake fetch/message events. This is what
// guards the stuck-splash fix -- a navigation that hangs or fails must always
// resolve to *some* HTML response, because in the installed PWA a hung
// navigation is an indefinite OS splash screen the user can only force-close.

const swSource = readFileSync(
  resolve(__dirname, '../../public/sw.js'),
  'utf8',
);

type Listener = (event: unknown) => unknown;

interface Harness {
  listeners: Record<string, Listener[]>;
  cacheStore: Map<string, Response>;
  dispatchNavigation: (url?: string) => Promise<Response>;
  dispatchMessage: (data: unknown) => Promise<void>;
}

function loadServiceWorker(fetchImpl: (request: unknown) => Promise<unknown>): Harness {
  const listeners: Record<string, Listener[]> = {};
  const cacheStore = new Map<string, Response>();

  const keyOf = (key: unknown): string =>
    typeof key === 'string' ? key : (key as { url: string }).url;

  const cache = {
    match: async (key: unknown) => cacheStore.get(keyOf(key)),
    put: async (key: unknown, response: Response) => {
      cacheStore.set(keyOf(key), response);
    },
  };

  const context = vm.createContext({
    self: {
      addEventListener: (type: string, fn: Listener) => {
        (listeners[type] ??= []).push(fn);
      },
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
    },
    caches: {
      open: async () => cache,
      match: (key: unknown) => cache.match(key),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: fetchImpl,
    // Delegate at call time so vi.useFakeTimers() applies inside the sandbox.
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) =>
      globalThis.clearTimeout(id),
    URL,
    Response,
  });
  vm.runInContext(swSource, context);

  const dispatchNavigation = (url = 'https://monize.test/dashboard') => {
    let captured: Promise<Response> | undefined;
    const event = {
      request: { method: 'GET', mode: 'navigate', url },
      respondWith: (promise: Promise<Response>) => {
        captured = promise;
      },
    };
    for (const listener of listeners.fetch ?? []) listener(event);
    if (!captured) throw new Error('navigation was not intercepted');
    return captured;
  };

  const dispatchMessage = async (data: unknown) => {
    let pending: Promise<unknown> = Promise.resolve();
    const event = {
      data,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    };
    for (const listener of listeners.message ?? []) listener(event);
    await pending;
  };

  return { listeners, cacheStore, dispatchNavigation, dispatchMessage };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('service worker navigation fallback', () => {
  it('passes a successful navigation response through untouched', async () => {
    const upstream = new Response('page', { status: 200 });
    const harness = loadServiceWorker(async () => upstream);

    const response = await harness.dispatchNavigation();
    expect(response).toBe(upstream);
  });

  it('serves the offline fallback when the navigation fetch rejects', async () => {
    const harness = loadServiceWorker(async () => {
      throw new TypeError('network down');
    });

    const response = await harness.dispatchNavigation();
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const html = await response.text();
    expect(html).toContain(enLayout.offlineFallback.title);
    expect(html).toContain(enLayout.offlineFallback.message);
    expect(html).toContain(enLayout.offlineFallback.retry);
    expect(html).toContain('href="/"');
  });

  it('serves the offline fallback when the navigation hangs past the timeout', async () => {
    vi.useFakeTimers();
    const harness = loadServiceWorker(
      () => new Promise(() => {}), // never settles
    );

    const responsePromise = harness.dispatchNavigation();
    await vi.advanceTimersByTimeAsync(10000);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(await response.text()).toContain(enLayout.offlineFallback.title);
  });

  it('uses the handshaken localized strings, HTML-escaped, with the stored theme', async () => {
    const harness = loadServiceWorker(async () => {
      throw new TypeError('network down');
    });

    await harness.dispatchMessage({
      type: 'monize-offline-strings',
      payload: {
        lang: 'fr',
        dir: 'ltr',
        theme: 'dark',
        title: 'Connexion <impossible> & "test"',
        message: 'Réessayez plus tard.',
        retry: 'Réessayer',
      },
    });

    const response = await harness.dispatchNavigation();
    const html = await response.text();

    expect(html).toContain('lang="fr"');
    expect(html).toContain('Connexion &lt;impossible&gt; &amp; &quot;test&quot;');
    expect(html).not.toContain('<impossible>');
    expect(html).toContain('Réessayez plus tard.');
    // Stored dark theme forces the dark palette unconditionally.
    expect(html).toContain(`body{background:${BOOT_BACKGROUND.dark};color:${BOOT_FOREGROUND.dark};}`);
  });

  it('paints the offline page with the handshaken palette colours', async () => {
    const harness = loadServiceWorker(async () => {
      throw new TypeError('network down');
    });

    await harness.dispatchMessage({
      type: 'monize-offline-strings',
      payload: {
        theme: 'dark',
        background: 'rgb(39, 23, 1)',
        foreground: '#f0e2b0',
      },
    });

    const html = await (await harness.dispatchNavigation()).text();
    expect(html).toContain('body{background:rgb(39, 23, 1);color:#f0e2b0;}');
  });

  it('rejects handshaken colours that are not plain colour literals', async () => {
    const harness = loadServiceWorker(async () => {
      throw new TypeError('network down');
    });

    await harness.dispatchMessage({
      type: 'monize-offline-strings',
      payload: {
        theme: 'dark',
        background: '}body{background:url(javascript:x)',
        foreground: '#f0e2b0',
      },
    });

    const html = await (await harness.dispatchNavigation()).text();
    expect(html).not.toContain('javascript:x');
    // Falls back to the stored dark theme's stock palette.
    expect(html).toContain(
      `body{background:${BOOT_BACKGROUND.dark};color:${BOOT_FOREGROUND.dark};}`,
    );
  });

  it('ignores malformed handshake payloads and non-string fields', async () => {
    const harness = loadServiceWorker(async () => {
      throw new TypeError('network down');
    });

    await harness.dispatchMessage({ type: 'something-else' });
    await harness.dispatchMessage({
      type: 'monize-offline-strings',
      payload: { title: { evil: true }, message: 42 },
    });

    const html = await (await harness.dispatchNavigation()).text();
    expect(html).toContain(enLayout.offlineFallback.title);
    expect(html).toContain(enLayout.offlineFallback.message);
  });

  it('leaves non-navigation, non-static requests to the network', () => {
    const harness = loadServiceWorker(async () => new Response('x'));
    let intercepted = false;
    const event = {
      request: {
        method: 'GET',
        mode: 'cors',
        url: 'https://monize.test/api/v1/accounts',
      },
      respondWith: () => {
        intercepted = true;
      },
    };
    for (const listener of harness.listeners.fetch ?? []) listener(event);
    expect(intercepted).toBe(false);
  });

  it('offline palette mirrors the boot palette in lib/pwa-theme.ts', async () => {
    const harness = loadServiceWorker(async () => {
      throw new TypeError('network down');
    });
    const html = await (await harness.dispatchNavigation()).text();

    // Light palette is the body default; dark palette rides the media query
    // when no theme has been handshaken.
    expect(html).toContain(`background:${BOOT_BACKGROUND.light}`);
    expect(html).toContain(`color:${BOOT_FOREGROUND.light}`);
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain(`background:${BOOT_BACKGROUND.dark}`);
    expect(html).toContain(`color:${BOOT_FOREGROUND.dark}`);
  });

  it('default offline strings mirror the English layout catalog', () => {
    // The comment in sw.js promises the fallback copy matches
    // layout.offlineFallback; this is the check that keeps it true.
    expect(swSource).toContain(`'${enLayout.offlineFallback.title}'`);
    expect(swSource).toContain(`'${enLayout.offlineFallback.retry}'`);
    expect(swSource).toContain(enLayout.offlineFallback.message);
  });
});
