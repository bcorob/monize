const CACHE_NAME = 'monize-static-v3';

// Synthetic cache key for the localized offline-fallback strings. Populated
// by OfflineFallbackSync (a postMessage handshake from the app), read by
// buildOfflineResponse. Never served to a fetch: it is not a static asset
// and navigations are handled separately.
var OFFLINE_STRINGS_URL = '/__monize/offline-strings';

// How long a navigation may hang before the offline fallback is served.
// Without this, an unreachable or stalled server leaves the installed PWA
// sitting on the OS splash screen with no error UI and no way out except
// force-closing the app.
var NAVIGATION_TIMEOUT_MS = 10000;

// Last-resort copy for a launch that failed before the app ever ran (so no
// handshake has stored localized strings yet). Must mirror
// layout.offlineFallback in src/i18n/messages/en/layout.json.
var OFFLINE_DEFAULT_STRINGS = {
  lang: 'en',
  dir: 'ltr',
  theme: '',
  // The computed page colours of the user's active palette, handshaken from
  // the app; empty until then.
  background: '',
  foreground: '',
  title: 'Unable to connect',
  message: 'Monize could not reach the server. Check your connection and try again.',
  retry: 'Try again',
};

// Stock-palette fallback, used until a handshake has stored the active
// palette's computed colours. Must mirror BOOT_BACKGROUND / BOOT_FOREGROUND
// in src/lib/pwa-theme.ts (asserted by src/test/sw-offline.test.ts).
var OFFLINE_COLORS = {
  light: { background: '#f9fafb', foreground: '#101828' },
  dark: { background: '#101828', foreground: '#f3f4f6' },
};

// The handshaken colours are interpolated into a style block, so only plain
// colour literals are accepted -- anything else falls back to the stock
// palette rather than risking CSS injection through a forged message.
var SAFE_CSS_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9.,%\s/-]*\)|[a-z]{3,20})$/i;

function isSafeCssColor(value) {
  return typeof value === 'string' && value.length <= 40 && SAFE_CSS_COLOR.test(value);
}

const STATIC_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.ico', '.webp',
];

function isStaticAsset(url) {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith('/_next/static/')) return true;
  return STATIC_EXTENSIONS.some(function (ext) { return pathname.endsWith(ext); });
}

// Install: activate immediately
self.addEventListener('install', function () {
  self.skipWaiting();
});

// Activate: clean up old caches, claim clients
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function (name) { return name !== CACHE_NAME; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Offline-strings handshake from the app (OfflineFallbackSync).
self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || data.type !== 'monize-offline-strings' || !data.payload) return;

  var stored = {};
  Object.keys(OFFLINE_DEFAULT_STRINGS).forEach(function (key) {
    var value = data.payload[key];
    if (typeof value === 'string' && value.length <= 500) {
      stored[key] = value;
    }
  });

  var write = caches.open(CACHE_NAME).then(function (cache) {
    return cache.put(
      OFFLINE_STRINGS_URL,
      new Response(JSON.stringify(stored), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });
  if (event.waitUntil) event.waitUntil(write);
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadOfflineStrings() {
  return caches.open(CACHE_NAME)
    .then(function (cache) { return cache.match(OFFLINE_STRINGS_URL); })
    .then(function (response) { return response ? response.json() : null; })
    .then(function (stored) {
      return Object.assign({}, OFFLINE_DEFAULT_STRINGS, stored || {});
    })
    .catch(function () {
      return OFFLINE_DEFAULT_STRINGS;
    });
}

function buildOfflineHtml(strings) {
  var darkRules =
    'background:' + OFFLINE_COLORS.dark.background + ';' +
    'color:' + OFFLINE_COLORS.dark.foreground + ';';
  // The computed colours of the user's active palette win outright; failing
  // those, an explicit resolved theme picks the stock palette; with neither
  // stored the palette follows the system preference.
  var themeCss;
  if (isSafeCssColor(strings.background) && isSafeCssColor(strings.foreground)) {
    themeCss =
      'body{background:' + strings.background + ';color:' + strings.foreground + ';}';
  } else if (strings.theme === 'dark') {
    themeCss = 'body{' + darkRules + '}';
  } else if (strings.theme === 'light') {
    themeCss = '';
  } else {
    themeCss = '@media (prefers-color-scheme: dark){body{' + darkRules + '}}';
  }

  return '<!doctype html>' +
    '<html lang="' + escapeHtml(strings.lang) + '" dir="' + escapeHtml(strings.dir) + '">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>' + escapeHtml(strings.title) + '</title>' +
    '<style>' +
    'body{margin:0;min-height:100vh;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:12px;' +
    'padding:calc(env(safe-area-inset-top) + 16px) 24px calc(env(safe-area-inset-bottom) + 16px);' +
    'text-align:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;' +
    'background:' + OFFLINE_COLORS.light.background + ';' +
    'color:' + OFFLINE_COLORS.light.foreground + ';}' +
    themeCss +
    'img{width:72px;height:72px;margin-bottom:8px;}' +
    'h1{font-size:20px;margin:0;}' +
    'p{font-size:14px;line-height:1.5;margin:0;max-width:28rem;}' +
    'a{color:inherit;font-weight:600;font-size:14px;text-decoration:underline;}' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<img src="/icons/monize-logo-transparent.svg" alt="">' +
    '<h1>' + escapeHtml(strings.title) + '</h1>' +
    '<p>' + escapeHtml(strings.message) + '</p>' +
    '<a href="/">' + escapeHtml(strings.retry) + '</a>' +
    '</body></html>';
}

function buildOfflineResponse() {
  return loadOfflineStrings()
    .then(function (strings) {
      return new Response(buildOfflineHtml(strings), {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    })
    .catch(function () {
      return new Response(buildOfflineHtml(OFFLINE_DEFAULT_STRINGS), {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    });
}

// Race the navigation against a timer rather than aborting it: a navigation
// Request's mode cannot be reconstructed for an AbortController-wrapped
// fetch, and a late success is simply ignored. The returned promise always
// resolves -- a rejection here would surface as a browser error page, which
// in the installed PWA looks like the stuck splash this exists to prevent.
function handleNavigation(request) {
  return new Promise(function (resolve) {
    var settled = false;
    var finish = function (responsePromise) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.resolve(responsePromise).then(resolve, function () {
        resolve(buildOfflineResponse());
      });
    };
    var timer = setTimeout(function () {
      finish(buildOfflineResponse());
    }, NAVIGATION_TIMEOUT_MS);

    fetch(request).then(
      function (response) { finish(response); },
      function () { finish(buildOfflineResponse()); }
    );
  });
}

// Fetch: Network-with-fallback for navigations, Cache-First for static
// assets, Network-Only for everything else
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(handleNavigation(event.request));
    return;
  }

  if (!isStaticAsset(event.request.url)) return;

  event.respondWith(
    caches.match(event.request).then(function (cachedResponse) {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then(function (networkResponse) {
        if (!networkResponse || networkResponse.status !== 200) {
          return networkResponse;
        }

        var responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});
