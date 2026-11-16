import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient from './api';
import { cleanup } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import {
  ENDPOINT_FINGERPRINT_LENGTH,
  PushPermissionError,
  currentDeviceFingerprint,
  disablePushOnThisDevice,
  releaseLocalPushSubscription,
  releasePushForSignOut,
  holdPushForSignOut,
  resumePushAfterSignIn,
  markRegisteredEndpointHeld,
  SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS,
  ENDPOINT_CLAIMED_CODE,
  ServiceWorkerUnavailableError,
  SERVICE_WORKER_READY_TIMEOUT_MS,
  enablePushOnThisDevice,
  fingerprintEndpoint,
  classifyPushRegistration,
  forgetRegisteredEndpoint,
  getPushSupport,
  isInstalledIosWebApp,
  readRegisteredEndpoint,
  rememberRegisteredEndpoint,
  requestNotificationPermission,
  pushApi,
  toSubscriptionPayload,
  urlBase64ToUint8Array,
  defaultDeviceName,
  PushServiceError,
  isBraveBrowser,
} from './push';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/abcdef';
// A real VAPID public key is 65 raw bytes as 87 base64url characters.
const PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkTtF4kzVfPYlLpTfLmXQNDSjEhBWIhkbBLPuLNKlP8fMKPXCkPvxKA';

describe('pushApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the instance configuration', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        enabled: true,
        publicKey: PUBLIC_KEY,
        configured: true,
        keyUnreadable: false,
      },
    });

    const config = await pushApi.getConfig();

    expect(apiClient.get).toHaveBeenCalledWith('/push/config');
    expect(config.enabled).toBe(true);
  });

  it('lists devices and posts a subscription without naming a user', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'd-1' } });

    await pushApi.listDevices();
    await pushApi.subscribe({
      endpoint: ENDPOINT,
      p256dh: 'p',
      auth: 'a',
      applicationServerKey: PUBLIC_KEY,
      deviceName: 'Pixel',
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      '/push/subscriptions',
      undefined,
    );
    const [, payload] = vi.mocked(apiClient.post).mock.calls[0];
    // The owner is the JWT's, and there is no field here that could say otherwise.
    expect(Object.keys(payload as object).sort()).toEqual([
      'applicationServerKey',
      'auth',
      'deviceName',
      'endpoint',
      'p256dh',
    ]);
  });

  it('removes a device by id and sends a test', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { attempted: 1, delivered: 1, devices: [] },
    });

    await pushApi.removeDevice('d-1');
    await pushApi.sendTest();

    expect(apiClient.delete).toHaveBeenCalledWith(
      '/push/subscriptions/d-1',
      undefined,
    );
    expect(apiClient.post).toHaveBeenCalledWith('/push/test');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a VAPID public key to its 65 raw bytes', () => {
    const bytes = urlBase64ToUint8Array(PUBLIC_KEY);

    expect(bytes).toHaveLength(65);
    // An uncompressed P-256 point starts with 0x04.
    expect(bytes[0]).toBe(0x04);
    // Backed by a plain ArrayBuffer, which is what applicationServerKey needs.
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('handles the base64url alphabet and missing padding', () => {
    // '-' and '_' stand in for '+' and '/', and the server stores no '='.
    expect(urlBase64ToUint8Array('-_-_')).toEqual(
      new Uint8Array([0xfb, 0xff, 0xbf]),
    );
    expect(urlBase64ToUint8Array('AQ')).toEqual(new Uint8Array([0x01]));
  });
});

describe('toSubscriptionPayload', () => {
  it('flattens a browser subscription', () => {
    expect(
      toSubscriptionPayload({
        endpoint: ENDPOINT,
        keys: { p256dh: 'p', auth: 'a' },
      }),
    ).toEqual({ endpoint: ENDPOINT, p256dh: 'p', auth: 'a' });
  });

  // Half a subscription cannot be delivered to, so it is refused rather than
  // stored as a device the user believes works.
  it.each([
    ['no keys', { endpoint: ENDPOINT }],
    ['no endpoint', { keys: { p256dh: 'p', auth: 'a' } }],
    ['no auth', { endpoint: ENDPOINT, keys: { p256dh: 'p' } }],
    ['no p256dh', { endpoint: ENDPOINT, keys: { auth: 'a' } }],
  ])('refuses a subscription with %s', (_name, subscription) => {
    expect(
      toSubscriptionPayload(subscription as PushSubscriptionJSON),
    ).toBeNull();
  });
});

describe('getPushSupport', () => {
  interface SupportFixture {
    serviceWorker?: boolean;
    pushManager?: boolean;
    notification?: NotificationPermission | null;
    userAgent?: string;
    platform?: string;
    maxTouchPoints?: number;
    /** iOS Safari's own installed-app flag; absent on every other browser. */
    standalone?: boolean;
    displayModeStandalone?: boolean;
  }

  // Built as loose records rather than partial Window/Navigator: both declare
  // the properties under test as readonly, so a typed partial cannot express
  // "this browser does not have a PushManager at all", which is the whole
  // subject here.
  function build({
    serviceWorker = true,
    pushManager = true,
    notification = 'default',
    userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
    platform = 'Linux x86_64',
    maxTouchPoints = 0,
    standalone,
    displayModeStandalone = false,
  }: SupportFixture = {}) {
    const win: Record<string, unknown> = {
      matchMedia: () => ({ matches: displayModeStandalone }),
      navigator: { standalone },
    };
    if (pushManager) win.PushManager = class {};
    if (notification !== null) win.Notification = { permission: notification };
    const nav: Record<string, unknown> = {
      userAgent,
      platform,
      maxTouchPoints,
    };
    if (serviceWorker) nav.serviceWorker = {};
    return { win: win as unknown as Window, nav: nav as unknown as Navigator };
  }

  it('reports support on a capable browser that has not been asked yet', () => {
    const { win, nav } = build();

    expect(getPushSupport(win, nav)).toEqual({ supported: true });
  });

  // 'default' is where a first-time user is. Treating it as a failure would hide
  // the button whose whole job is to trigger the prompt.
  it('does not treat an unanswered permission prompt as a refusal', () => {
    const { win, nav } = build({ notification: 'default' });

    expect(getPushSupport(win, nav).supported).toBe(true);
  });

  it('separates a blocked permission from an incapable browser', () => {
    const denied = build({ notification: 'denied' });
    const incapable = build({ pushManager: false });

    expect(getPushSupport(denied.win, denied.nav)).toEqual({
      supported: false,
      reason: 'denied',
    });
    expect(getPushSupport(incapable.win, incapable.nav)).toEqual({
      supported: false,
      reason: 'unsupported',
    });
  });

  // The case that looks like a bug and is not: Safari delivers Web Push only to
  // a PWA installed on the Home Screen, so "unsupported" would send an iPhone
  // user away for good from a thing that works after one more step.
  it('names the installable case on an iPhone browser tab', () => {
    const { win, nav } = build({
      pushManager: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605',
      platform: 'iPhone',
    });

    expect(getPushSupport(win, nav)).toEqual({
      supported: false,
      reason: 'ios-browser',
    });
  });

  it('names the installable case on an iPad reporting itself as a Mac', () => {
    const { win, nav } = build({
      pushManager: false,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });

    expect(getPushSupport(win, nav).reason).toBe('ios-browser');
  });

  it('does not blame iOS once the app is installed', () => {
    const { win, nav } = build({
      pushManager: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605',
      platform: 'iPhone',
      standalone: true,
    });

    expect(getPushSupport(win, nav).reason).toBe('unsupported');
  });

  it('treats a standalone display mode as installed', () => {
    const { win, nav } = build({
      pushManager: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605',
      platform: 'iPhone',
      displayModeStandalone: true,
    });

    expect(getPushSupport(win, nav).reason).toBe('unsupported');
  });
});

describe('classifyPushRegistration', () => {
  const MINE = 'aaaabbbbccccdddd';
  const OTHER = '1111222233334444';
  const READER = 'user-1';
  const SOMEBODY_ELSE = 'user-2';
  const mine = (fingerprint: string) => ({
    userId: READER,
    fingerprint,
  });

  /**
   * The whole truth table, because the interesting rows are the ways "the server
   * has no live row for the endpoint I hold" happens -- and reading any two of
   * them as one state is a defect. Re-register on a revocation and the user's
   * removal is undone the next time that device opens the app; do nothing on a
   * rotation and delivery is dead while the device list still shows the old row
   * as active; act on ANOTHER account's subscription in a shared browser and you
   * revoke push for somebody who is not even signed in.
   */
  it.each([
    // current, live rows, marker, reader, expected
    ['no subscription at all', null, [], null, READER, 'no-subscription'],
    [
      'no subscription, but a stale marker',
      null,
      [],
      mine(OTHER),
      READER,
      'no-subscription',
    ],
    ['registered and live', MINE, [MINE], mine(MINE), READER, 'in-sync'],
    [
      'live alongside another device',
      MINE,
      [OTHER, MINE],
      mine(MINE),
      READER,
      'in-sync',
    ],
    ['endpoint changed under us', MINE, [], mine(OTHER), READER, 'rotated'],
    [
      'endpoint changed, other rows live',
      MINE,
      [OTHER],
      mine(OTHER),
      READER,
      'rotated',
    ],
    ['our row removed elsewhere', MINE, [], mine(MINE), READER, 'revoked'],
    [
      'our row removed, others remain',
      MINE,
      [OTHER],
      mine(MINE),
      READER,
      'revoked',
    ],
    // A cleared store cannot prove a rotation, so it takes the conservative
    // half: nothing is re-registered behind the user's back.
    ['no marker at all', MINE, [], null, READER, 'revoked'],
    // The shared-browser rows. `localStorage` is per origin and a subscription's
    // owner is an account, so a marker naming somebody else is not evidence
    // about the reader -- and both repairs would be aimed at that other
    // account's device.
    [
      "another account's subscription, still held by the browser",
      MINE,
      [],
      { userId: SOMEBODY_ELSE, fingerprint: MINE },
      READER,
      'foreign',
    ],
    [
      "another account's, while the reader also has rows",
      MINE,
      [OTHER],
      { userId: SOMEBODY_ELSE, fingerprint: MINE },
      READER,
      'foreign',
    ],
    // An unknown reader cannot claim a marked subscription either: it is one of
    // the two, and only one of them is safe to assume.
    [
      'a marked subscription with no reader identity',
      MINE,
      [],
      { userId: SOMEBODY_ELSE, fingerprint: MINE },
      null,
      'foreign',
    ],
    // A marker somebody else wrote is not evidence about the reader whichever
    // endpoint it names. Read as a rotation, this registered a device for a
    // reader who never asked for notifications -- passing the permission gate
    // only because the other account had granted it.
    [
      "another account's marker, different endpoint",
      MINE,
      [],
      { userId: SOMEBODY_ELSE, fingerprint: OTHER },
      READER,
      'foreign',
    ],
  ])(
    '%s',
    (_case, currentFingerprint, liveFingerprints, marker, reader, kind) => {
      expect(
        classifyPushRegistration({
          currentFingerprint: currentFingerprint as string | null,
          liveFingerprints: liveFingerprints as string[],
          marker: marker as { userId: string; fingerprint: string } | null,
          readerUserId: reader as string | null,
        }).kind,
      ).toBe(kind);
    },
  );

  it('names the endpoint on every state that acts on one', () => {
    // The caller registers or releases a specific subscription, so the state
    // carries which -- not merely that something is out of step.
    expect(
      classifyPushRegistration({
        currentFingerprint: MINE,
        liveFingerprints: [],
        marker: mine(OTHER),
        readerUserId: READER,
      }),
    ).toEqual({
      kind: 'rotated',
      fingerprint: MINE,
      // The endpoint the browser replaced, so its dead server row can go.
      supersededFingerprint: OTHER,
    });
    expect(
      classifyPushRegistration({
        currentFingerprint: MINE,
        liveFingerprints: [],
        marker: mine(MINE),
        readerUserId: READER,
      }),
    ).toEqual({ kind: 'revoked', fingerprint: MINE });
    expect(
      classifyPushRegistration({
        currentFingerprint: MINE,
        liveFingerprints: [],
        marker: { userId: SOMEBODY_ELSE, fingerprint: MINE },
        readerUserId: READER,
      }),
    ).toEqual({ kind: 'foreign', fingerprint: MINE });
  });

  // A disabled row is not a registration: the panel filters those out before
  // asking, and this is the assertion that says so.
  it("treats only live rows as registrations, which is the caller's job", () => {
    expect(
      classifyPushRegistration({
        currentFingerprint: MINE,
        liveFingerprints: [],
        marker: mine(MINE),
        readerUserId: READER,
      }).kind,
    ).toBe('revoked');
  });
});

describe('the registered-endpoint marker', () => {
  afterEach(() => vi.unstubAllGlobals());

  const withStore = (initial?: string) => {
    const store = new Map<string, string>();
    if (initial !== undefined) {
      store.set('monize.push.registeredEndpoint', initial);
    }
    vi.stubGlobal('window', {
      localStorage: {
        setItem: (k: string, v: string) => store.set(k, v),
        getItem: (k: string) => store.get(k) ?? null,
        removeItem: (k: string) => store.delete(k),
      },
    });
    return store;
  };

  it('remembers its owner alongside the endpoint, reads back and forgets', () => {
    withStore();

    rememberRegisteredEndpoint('user-1', 'abc123');
    expect(readRegisteredEndpoint()).toEqual({
      userId: 'user-1',
      fingerprint: 'abc123',
      held: false,
    });
    forgetRegisteredEndpoint();
    expect(readRegisteredEndpoint()).toBeNull();
  });

  it('records a confirmed hold, and a fresh registration clears it', () => {
    withStore();

    markRegisteredEndpointHeld('user-1', 'abc123');
    expect(readRegisteredEndpoint()).toEqual({
      userId: 'user-1',
      fingerprint: 'abc123',
      held: true,
    });
    rememberRegisteredEndpoint('user-1', 'abc123');
    expect(readRegisteredEndpoint()?.held).toBe(false);
  });

  // Written before the hold existed: it reads exactly as it did then.
  it('reads a marker without the held flag as not held', () => {
    withStore('{"userId":"user-1","fingerprint":"abc123"}');

    expect(readRegisteredEndpoint()).toEqual({
      userId: 'user-1',
      fingerprint: 'abc123',
      held: false,
    });
  });

  // The pre-owner format was a bare fingerprint. Read as an owner-less marker it
  // would be treated as the reader's own, which is the state this format exists
  // to stop assuming -- so it reads as no information.
  it('reads a value from the previous format as no information', () => {
    withStore('abc123');

    expect(readRegisteredEndpoint()).toBeNull();
  });

  it.each([
    ['a JSON scalar', '"abc123"'],
    ['an object missing the owner', '{"fingerprint":"abc123"}'],
    ['an object missing the endpoint', '{"userId":"user-1"}'],
    ['an empty owner', '{"userId":"","fingerprint":"abc123"}'],
    ['a non-string owner', '{"userId":7,"fingerprint":"abc123"}'],
    ['null', 'null'],
  ])('reads %s as no information', (_name, raw) => {
    withStore(raw);

    expect(readRegisteredEndpoint()).toBeNull();
  });

  // Some browsers throw on `localStorage` outright (a private window, blocked
  // site data). The reconciliation then degrades to doing nothing, which is the
  // behaviour before the marker existed -- it must not take the page down.
  it('survives a store that throws', () => {
    vi.stubGlobal('window', {
      get localStorage(): never {
        throw new Error('blocked');
      },
    });

    expect(() => rememberRegisteredEndpoint('user-1', 'abc123')).not.toThrow();
    expect(() => forgetRegisteredEndpoint()).not.toThrow();
    expect(readRegisteredEndpoint()).toBeNull();
  });
});

describe('isInstalledIosWebApp', () => {
  const fake = (
    userAgent: string,
    extras: Record<string, unknown> = {},
    standalone?: boolean,
  ) => ({
    win: {
      matchMedia: () => ({ matches: false }),
      navigator: { standalone },
    } as unknown as Window,
    nav: {
      userAgent,
      platform: 'iPhone',
      maxTouchPoints: 0,
      ...extras,
    } as unknown as Navigator,
  });

  it('recognises an iPhone launched from the Home Screen', () => {
    const { win, nav } = fake(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605',
      {},
      true,
    );

    expect(isInstalledIosWebApp(win, nav)).toBe(true);
  });

  it('does not claim an iPhone browser tab is the installed app', () => {
    const { win, nav } = fake(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605',
    );

    expect(isInstalledIosWebApp(win, nav)).toBe(false);
  });

  // iPadOS reports itself as a Mac, so the touch points are what give it away --
  // and a real Mac in standalone display mode must not be mistaken for it.
  it('separates an installed iPad from a desktop Safari', () => {
    const ipad = fake(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605',
      { platform: 'MacIntel', maxTouchPoints: 5 },
      true,
    );
    const mac = fake(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605',
      { platform: 'MacIntel', maxTouchPoints: 0 },
      true,
    );

    expect(isInstalledIosWebApp(ipad.win, ipad.nav)).toBe(true);
    expect(isInstalledIosWebApp(mac.win, mac.nav)).toBe(false);
  });
});

describe('requestNotificationPermission', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves from the returned promise', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn(async () => 'granted'),
    });

    await expect(requestNotificationPermission()).resolves.toBe('granted');
  });

  // Older WebKit implements only the callback form and returns undefined, on
  // which `await` yields undefined -- read as a refusal the user never made.
  it('resolves from the legacy callback when nothing is returned', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn((cb: (p: NotificationPermission) => void) => {
        cb('granted');
        return undefined;
      }),
    });

    await expect(requestNotificationPermission()).resolves.toBe('granted');
  });

  it('settles once on a browser that answers both ways', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn((cb: (p: NotificationPermission) => void) => {
        cb('granted');
        return Promise.resolve('denied' as NotificationPermission);
      }),
    });

    // The first answer wins, and the second cannot overwrite it: a promise that
    // has already resolved ignores a later resolve, which is the property this
    // pins rather than a preference for one of the two values.
    await expect(requestNotificationPermission()).resolves.toBe('granted');
  });

  // A rejection is not an answer; the browser's own state is.
  it('falls back to the stored permission when the request rejects', async () => {
    vi.stubGlobal('Notification', {
      permission: 'denied',
      requestPermission: vi.fn(() => Promise.reject(new Error('no'))),
    });

    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });
});

describe('fingerprintEndpoint', () => {
  it('matches the prefix length the server publishes', async () => {
    const fingerprint = await fingerprintEndpoint(ENDPOINT);

    expect(fingerprint).toHaveLength(ENDPOINT_FINGERPRINT_LENGTH);
    expect(fingerprint).toMatch(/^[0-9a-f]+$/);
  });

  it('is stable for one endpoint and different for another', async () => {
    const [a, b, c] = await Promise.all([
      fingerprintEndpoint(ENDPOINT),
      fingerprintEndpoint(ENDPOINT),
      fingerprintEndpoint(`${ENDPOINT}x`),
    ]);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('enabling and disabling push on this device', () => {
  let subscribe: ReturnType<typeof vi.fn>;
  let getSubscription: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let requestPermission: ReturnType<typeof vi.fn>;

  function browserSubscription(applicationServerKey?: ArrayBuffer) {
    return {
      endpoint: ENDPOINT,
      options: { applicationServerKey: applicationServerKey ?? null },
      unsubscribe,
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribe = vi.fn(async () => true);
    getSubscription = vi.fn(async () => null);
    subscribe = vi.fn(async () => browserSubscription());
    requestPermission = vi.fn(async () => 'granted' as NotificationPermission);

    vi.stubGlobal('Notification', { requestPermission, permission: 'default' });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { subscribe, getSubscription } }),
      },
    });
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'd-1' } });
    vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('asks for permission, then registers, and reports the stored device', async () => {
    const device = await enablePushOnThisDevice(PUBLIC_KEY, 'Pixel 9');

    // The key the browser actually used travels with the registration: the
    // server checks it is still current rather than stamping its own value over
    // a subscription minted under a superseded pair.
    expect(vi.mocked(apiClient.post).mock.calls[0][1]).toMatchObject({
      applicationServerKey: PUBLIC_KEY,
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(PUBLIC_KEY),
    });
    expect(device.id).toBe('d-1');
  });

  // A browser that only implements `requestPermission(callback)` returns
  // undefined, and awaiting that yields undefined -- which is not 'granted', so
  // the user was told to grant a permission they had just granted, with the
  // prompt they answered still on screen.
  it('registers on a browser that only implements the callback form', async () => {
    requestPermission.mockImplementation(
      (cb: (p: NotificationPermission) => void) => {
        cb('granted');
        return undefined;
      },
    );

    const device = await enablePushOnThisDevice(PUBLIC_KEY, 'iPhone');

    expect(device.id).toBe('d-1');
    expect(subscribe).toHaveBeenCalled();
  });

  // 'denied' and 'dismissed' need different words: the first is a decision only
  // the user can undo in site settings, the second is "ask me again".
  it.each([
    ['denied', 'denied'],
    ['default', 'dismissed'],
  ])(
    'reports a %s permission as %s without subscribing',
    async (permission, reason) => {
      requestPermission.mockResolvedValue(permission as NotificationPermission);

      await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toMatchObject({
        name: 'PushPermissionError',
        reason,
      });
      expect(subscribe).not.toHaveBeenCalled();
      expect(apiClient.post).not.toHaveBeenCalled();
    },
  );

  // The marker is what tells a later page load whether the endpoint this browser
  // holds is this account's -- so it is written on a successful registration,
  // with the owner, and the fingerprint is the SERVER's digest rather than a
  // second one computed here.
  it("records the registration against the account that made it", async () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { id: 'd-1', endpointFingerprint: 'server-digest' },
    });

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(readRegisteredEndpoint()).toEqual({
      userId: 'user-1',
      fingerprint: 'server-digest',
      held: false,
    });
  });

  // No identity, no marker: one that names an unknown owner is read as somebody
  // else's, and would classify this browser's own subscription as foreign.
  it('writes no marker when no account is signed in', async () => {
    useAuthStore.setState({ user: null });
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );
    // A complete response on purpose: the only reason nothing may be written
    // here is the missing identity, so the fingerprint must not be what makes
    // the assertion pass.
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { id: 'd-1', endpointFingerprint: 'server-digest' },
    });

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(readRegisteredEndpoint()).toBeNull();
  });

  // Replacing this browser's subscription leaves a server row for an endpoint
  // that no longer exists anywhere: listed as a live device, undeliverable, and
  // spending one of the account's slots, with nothing that would ever retire it
  // (only a delivery's own 404 does, and nothing delivers to it).
  it("retires the row for the endpoint it replaces", async () => {
    getSubscription.mockResolvedValue(
      browserSubscription(new Uint8Array([1, 2, 3]).buffer),
    );
    const superseded = await fingerprintEndpoint(ENDPOINT);
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        { id: 'd-other', endpointFingerprint: '0000000000000000' },
        { id: 'd-stale', endpointFingerprint: superseded },
      ],
    });

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(apiClient.delete).toHaveBeenCalledWith(
      '/push/subscriptions/d-stale',
      undefined,
    );
  });

  it('deletes nothing when the replaced endpoint has no row', async () => {
    getSubscription.mockResolvedValue(
      browserSubscription(new Uint8Array([1, 2, 3]).buffer),
    );
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [{ id: 'd-other', endpointFingerprint: '0000000000000000' }],
    });

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it('reuses a subscription already minted under the current key', async () => {
    const current = urlBase64ToUint8Array(PUBLIC_KEY);
    getSubscription.mockResolvedValue(browserSubscription(current.buffer));

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalled();
  });

  // After an instance rotates its key pair the browser still holds the old
  // subscription, and every message signed with the new key would be rejected.
  it('replaces a subscription minted under a superseded key', async () => {
    getSubscription.mockResolvedValue(
      browserSubscription(new Uint8Array([1, 2, 3]).buffer),
    );

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('replaces a subscription whose key the browser will not disclose', async () => {
    getSubscription.mockResolvedValue(browserSubscription(undefined));

    await enablePushOnThisDevice(PUBLIC_KEY);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('refuses an incomplete subscription rather than storing a dead device', async () => {
    subscribe.mockResolvedValue({
      endpoint: ENDPOINT,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint: ENDPOINT, keys: {} }),
    });

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow(
      /incomplete push subscription/,
    );
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  // Both halves, always: a server row without a browser subscription is a
  // device the user cannot receive on, and the reverse is a permission the app
  // holds and no longer uses.
  it('removes the server row and the browser subscription together', async () => {
    getSubscription.mockResolvedValue(browserSubscription());

    await disablePushOnThisDevice('d-1');

    expect(apiClient.delete).toHaveBeenCalledWith(
      '/push/subscriptions/d-1',
      undefined,
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // A refusal that is not a stale claim -- the per-account cap, a rotated key, a
  // 500 -- must not leave a browser subscription with no server row behind it:
  // a permission this app holds, no longer uses, and the user cannot see.
  it('takes back a subscription it minted when the registration is refused', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error('too many devices'), {
        response: { status: 400 },
      }),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow(
      'too many devices',
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // ...but one the browser already had may back a perfectly good row, so a
  // failure here is not licence to drop it.
  it('leaves a pre-existing subscription alone when the registration is refused', async () => {
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error('boom'), { response: { status: 500 } }),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow('boom');

    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('takes back the replacement too when the retry is refused', async () => {
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error('conflict'), {
        response: { status: 409, data: { errorCode: ENDPOINT_CLAIMED_CODE } },
      }),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow(
      'conflict',
    );

    // One for the stale claim, one taking the replacement back.
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  // Deleting the server row needs the session that is ending, so this runs
  // before the cookies are cleared -- and under its own short bound, because
  // the cleanup is best effort and revoking the session is not.
  it("removes this browser's server row and subscription on sign-out", async () => {
    getSubscription.mockResolvedValue(browserSubscription());
    const fingerprint = await fingerprintEndpoint(ENDPOINT);
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        { id: 'd-other', endpointFingerprint: '0000000000000000' },
        { id: 'd-1', endpointFingerprint: fingerprint },
      ],
    });

    await releasePushForSignOut();

    // Flagged so a 401 arriving after the session is gone does not drive the
    // interceptor's refresh-and-redirect on top of a sign-out already
    // navigating.
    expect(apiClient.delete).toHaveBeenCalledWith('/push/subscriptions/d-1', {
      _skipAuthRedirect: true,
    });
    expect(apiClient.get).toHaveBeenCalledWith('/push/subscriptions', {
      _skipAuthRedirect: true,
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // A shared browser profile. The subscription belongs to an account that is not
  // the one signing out, so destroying it revokes THEIR push on a device they
  // still hold -- and takes the marker the `foreign` classification depends on
  // with it, so nothing can ever recognise the state again.
  it("leaves another account's subscription alone on sign-out", async () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    rememberRegisteredEndpoint('user-2', await fingerprintEndpoint(ENDPOINT));
    getSubscription.mockResolvedValue(browserSubscription());

    await releasePushForSignOut();

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(apiClient.delete).not.toHaveBeenCalled();
    expect(readRegisteredEndpoint()).toEqual({
      userId: 'user-2',
      fingerprint: await fingerprintEndpoint(ENDPOINT),
      held: false,
    });
  });

  // With no marker there is no information, and the departing account is the
  // likely owner: a subscription nobody claims must not outlive the session.
  it('still releases when no marker says whose the subscription is', async () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    forgetRegisteredEndpoint();
    getSubscription.mockResolvedValue(browserSubscription());
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await releasePushForSignOut();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('still unsubscribes locally when the row cannot be removed', async () => {
    getSubscription.mockResolvedValue(browserSubscription());
    vi.mocked(apiClient.get).mockRejectedValue(new Error('401'));

    await expect(releasePushForSignOut()).resolves.toBeUndefined();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than holding a sign-out open', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: new Promise<never>(() => {}) },
    });
    try {
      const pending = releasePushForSignOut();
      await vi.advanceTimersByTimeAsync(SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the browser subscription even when the server delete fails', async () => {
    getSubscription.mockResolvedValue(browserSubscription());
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('server down'));

    await expect(disablePushOnThisDevice('d-1')).rejects.toThrow('server down');

    // The failure propagates -- the row may well still be there -- but the
    // local half runs regardless, because a browser subscription with no server
    // row is a permission the app holds and the user cannot see.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('still unsubscribes in the browser when there is no server row to remove', async () => {
    getSubscription.mockResolvedValue(browserSubscription());

    await disablePushOnThisDevice();

    expect(apiClient.delete).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reports no current device when the browser holds no subscription', async () => {
    await expect(currentDeviceFingerprint()).resolves.toBeNull();
  });

  it('reports the current device as the same digest the server publishes', async () => {
    getSubscription.mockResolvedValue(browserSubscription());

    await expect(currentDeviceFingerprint()).resolves.toBe(
      await fingerprintEndpoint(ENDPOINT),
    );
  });

  // The server refuses to take an endpoint over from another account -- an
  // endpoint is a string the client supplied, not proof of ownership -- so the
  // repair belongs here: drop the stale subscription and mint a fresh endpoint
  // nobody holds.
  it('recovers from a claimed endpoint by subscribing again', async () => {
    const claimed = Object.assign(new Error('conflict'), {
      response: { status: 409, data: { errorCode: ENDPOINT_CLAIMED_CODE } },
    });
    vi.mocked(apiClient.post)
      .mockRejectedValueOnce(claimed)
      .mockResolvedValueOnce({ data: { id: 'd-2' } });
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );

    const device = await enablePushOnThisDevice(PUBLIC_KEY);

    // One unsubscribe and one subscribe, both caused by the 409 rather than by
    // a key mismatch: the browser held a subscription minted under this very
    // key, so nothing before the POST had any reason to replace it.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledTimes(2);
    expect(device.id).toBe('d-2');
  });

  // A second 409 on a brand-new endpoint means something other than a stale
  // claim, so it surfaces instead of looping.
  it('retries a claimed endpoint exactly once', async () => {
    const claimed = Object.assign(new Error('conflict'), {
      response: { status: 409, data: { errorCode: ENDPOINT_CLAIMED_CODE } },
    });
    vi.mocked(apiClient.post).mockRejectedValue(claimed);
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toBe(claimed);
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });

  // The key-rotation refusal is also a 409, and recovering from it by
  // unsubscribing would destroy a working registration and retry with the same
  // stale key. Branching on the status alone was exactly that bug.
  it.each([
    ['a plain 400', { status: 400 }],
    ['a plain 403', { status: 403 }],
    ['a 500', { status: 500 }],
    ['a 409 that is not a claimed endpoint', { status: 409 }],
    [
      'a 409 carrying some other code',
      { status: 409, data: { errorCode: 'somethingElse' } },
    ],
  ])('does not re-subscribe on %s', async (_name, response) => {
    vi.mocked(apiClient.post).mockRejectedValue(
      Object.assign(new Error('nope'), { response }),
    );
    getSubscription.mockResolvedValue(
      browserSubscription(urlBase64ToUint8Array(PUBLIC_KEY).buffer),
    );

    await expect(enablePushOnThisDevice(PUBLIC_KEY)).rejects.toThrow('nope');
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  // Logout's half: the subscription is scoped to the origin, not the session,
  // so leaving it registered keeps delivering the departing account's
  // notifications onto a browser the next person is using.
  it('releases the local subscription without deleting any server row', async () => {
    getSubscription.mockResolvedValue(browserSubscription());

    await releaseLocalPushSubscription();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it('never throws while releasing, so a logout cannot fail on the push channel', async () => {
    getSubscription.mockRejectedValue(new Error('service worker gone'));

    await expect(releaseLocalPushSubscription()).resolves.toBeUndefined();
  });

  // `navigator.serviceWorker.ready` never rejects, so an unbounded await on a
  // worker that never installs leaves the whole push block stuck in its loading
  // state -- it simply disappears from Settings, with no error anywhere.
  it('gives up on a service worker that never becomes ready', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: new Promise<never>(() => {}) },
    });
    try {
      const pending = enablePushOnThisDevice(PUBLIC_KEY);
      const assertion = expect(pending).rejects.toThrow(
        ServiceWorkerUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(SERVICE_WORKER_READY_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes the permission refusal as a named error class', () => {
    const error = new PushPermissionError('denied');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PushPermissionError');
  });
});

describe('defaultDeviceName', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/605.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/121.0',
      'Firefox on Mac',
    ],
  ])('names %s as %s', (userAgent, expected) => {
    expect(defaultDeviceName({ userAgent } as Navigator)).toBe(expected);
  });

  it('offers no name rather than a wrong one for an unrecognised agent', () => {
    expect(defaultDeviceName({ userAgent: '' } as Navigator)).toBeUndefined();
    expect(
      defaultDeviceName({ userAgent: 'curl/8' } as Navigator),
    ).toBeUndefined();
  });
});

describe('isBraveBrowser', () => {
  it('is false when the browser does not expose navigator.brave', async () => {
    expect(await isBraveBrowser({} as Navigator)).toBe(false);
    expect(await isBraveBrowser(undefined)).toBe(false);
  });

  it('asks navigator.brave.isBrave(), which is the only thing that tells Brave from Chrome', async () => {
    const brave = { brave: { isBrave: async () => true } } as unknown as Navigator;
    expect(await isBraveBrowser(brave)).toBe(true);
    const notBrave = {
      brave: { isBrave: async () => false },
    } as unknown as Navigator;
    expect(await isBraveBrowser(notBrave)).toBe(false);
  });

  it('treats a probe that throws as not Brave rather than as an error', async () => {
    const broken = {
      brave: {
        isBrave: async () => {
          throw new Error('nope');
        },
      },
    } as unknown as Navigator;
    expect(await isBraveBrowser(broken)).toBe(false);
  });
});

describe('PushServiceError', () => {
  it('names the refusal and carries whether Brave is the cause', () => {
    const generic = new PushServiceError(false);
    expect(generic).toBeInstanceOf(Error);
    expect(generic.name).toBe('PushServiceError');
    expect(generic.brave).toBe(false);
    const brave = new PushServiceError(true, new Error('Registration failed - push service error'));
    expect(brave.brave).toBe(true);
    expect(brave.message).toMatch(/Brave/);
    expect((brave as { cause?: Error }).cause?.message).toMatch(/push service error/);
  });
});

/**
 * INV-PUSH-011 on the client: a sign-out holds this browser's row and keeps
 * the subscription only once the server has confirmed the hold; the same
 * account's next sign-in resumes it. Every other outcome releases.
 */
describe('holding push across a sign-out, and resuming it', () => {
  let getSubscription: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let fingerprint: string;

  function browserSubscription(
    endpoint = ENDPOINT,
    applicationServerKey: ArrayBuffer | null = urlBase64ToUint8Array(
      PUBLIC_KEY,
    ).buffer,
  ) {
    return {
      endpoint,
      options: { applicationServerKey },
      unsubscribe,
      toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    };
  }

  function httpError(status: number, errorCode?: string) {
    return Object.assign(new Error(`HTTP ${status}`), {
      response: { status, data: errorCode ? { errorCode } : {} },
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    fingerprint = await fingerprintEndpoint(ENDPOINT);
    unsubscribe = vi.fn(async () => true);
    getSubscription = vi.fn(async () => browserSubscription());
    vi.stubGlobal('Notification', {
      requestPermission: vi.fn(),
      permission: 'granted',
    });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { getSubscription } }),
      },
    });
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [{ id: 'd-1', endpointFingerprint: fingerprint }],
    });
    vi.mocked(apiClient.post).mockResolvedValue({ data: undefined });
    vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });
  });

  afterEach(() => {
    // Nothing is rendered here, but the store reset still follows cleanup()
    // (`test-hygiene.test.ts`): a no-op unmount costs nothing.
    cleanup();
    vi.unstubAllGlobals();
    useAuthStore.setState({ user: null });
  });

  describe('holdPushForSignOut', () => {
    it('asks nothing of a subscription another account registered', async () => {
      rememberRegisteredEndpoint('user-2', fingerprint);

      await holdPushForSignOut();

      expect(apiClient.get).not.toHaveBeenCalled();
      expect(apiClient.post).not.toHaveBeenCalled();
      expect(apiClient.delete).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(readRegisteredEndpoint()?.userId).toBe('user-2');
    });

    it('keeps the subscription and flags the marker once the hold is confirmed', async () => {
      rememberRegisteredEndpoint('user-1', fingerprint);

      await holdPushForSignOut();

      expect(apiClient.post).toHaveBeenCalledWith(
        '/push/subscriptions/d-1/hold',
        undefined,
        { _skipAuthRedirect: true },
      );
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(apiClient.delete).not.toHaveBeenCalled();
      expect(readRegisteredEndpoint()).toEqual({
        userId: 'user-1',
        fingerprint,
        held: true,
      });
    });

    // A cleared store must not turn a confirmed hold into a subscription
    // nothing will ever resume.
    it('writes the held marker even when none was stored', async () => {
      await holdPushForSignOut();

      expect(readRegisteredEndpoint()).toEqual({
        userId: 'user-1',
        fingerprint,
        held: true,
      });
    });

    // Decision 3: an unconfirmed hold releases. 404 is also an older backend,
    // 403 a delegate session.
    it.each([
      ['a 404', httpError(404)],
      ['a 403', httpError(403)],
      ['a network error', new Error('Network Error')],
    ])('releases both halves when the hold answers %s', async (_name, failure) => {
      rememberRegisteredEndpoint('user-1', fingerprint);
      vi.mocked(apiClient.post).mockRejectedValue(failure);

      await holdPushForSignOut();

      expect(apiClient.delete).toHaveBeenCalledWith('/push/subscriptions/d-1', {
        _skipAuthRedirect: true,
      });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(readRegisteredEndpoint()).toBeNull();
    });

    it('releases when the server has no row for this browser', async () => {
      rememberRegisteredEndpoint('user-1', fingerprint);
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [{ id: 'd-other', endpointFingerprint: '0000000000000000' }],
      });

      await holdPushForSignOut();

      expect(apiClient.post).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(readRegisteredEndpoint()).toBeNull();
    });

    it('releases when the device list cannot be read', async () => {
      vi.mocked(apiClient.get).mockRejectedValue(httpError(500));

      await holdPushForSignOut();

      expect(apiClient.post).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    // Real timers and a short bound: the fingerprint is a real digest, which
    // fake time does not wait for, so each test waits for the hold request
    // itself rather than letting it land in the next test.
    it('returns within the bound, releasing locally rather than keeping an unconfirmed subscription', async () => {
      rememberRegisteredEndpoint('user-1', fingerprint);
      vi.mocked(apiClient.post).mockReturnValue(new Promise<never>(() => {}));

      await expect(holdPushForSignOut(20)).resolves.toBeUndefined();

      await vi.waitFor(() => expect(apiClient.post).toHaveBeenCalled());
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
      expect(readRegisteredEndpoint()).toBeNull();
    });

    it('does not flag a hold that is confirmed after the bound elapsed', async () => {
      rememberRegisteredEndpoint('user-1', fingerprint);
      let confirm: ((value: unknown) => void) | null = null;
      vi.mocked(apiClient.post).mockImplementation(
        () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      );

      await holdPushForSignOut(20);
      await vi.waitFor(() => expect(confirm).not.toBeNull());
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
      confirm!({ data: undefined });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readRegisteredEndpoint()).toBeNull();
      expect(apiClient.delete).not.toHaveBeenCalled();
    });
  });

  describe('resumePushAfterSignIn', () => {
    it('requests nothing when the marker is not held', async () => {
      rememberRegisteredEndpoint('user-1', fingerprint);

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(false);

      expect(apiClient.get).not.toHaveBeenCalled();
      expect(apiClient.post).not.toHaveBeenCalled();
      expect(getSubscription).not.toHaveBeenCalled();
    });

    it("requests nothing for a hold another account made", async () => {
      markRegisteredEndpointHeld('user-2', fingerprint);

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(false);

      expect(apiClient.post).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(readRegisteredEndpoint()?.held).toBe(true);
    });

    it('releases and retires the held row once permission is no longer granted', async () => {
      markRegisteredEndpointHeld('user-1', fingerprint);
      vi.stubGlobal('Notification', { permission: 'denied' });

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(true);

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(apiClient.delete).toHaveBeenCalledWith(
        '/push/subscriptions/d-1',
        undefined,
      );
      expect(apiClient.post).not.toHaveBeenCalled();
      expect(readRegisteredEndpoint()).toBeNull();
    });

    // A browser that will not disclose its key reads as a mismatch too, and
    // then the held row is still live: it is retired with the subscription.
    it.each([
      ['a different key', new Uint8Array([1, 2, 3]).buffer],
      ['an undisclosed key', null],
    ])('releases and retires the held row, without posting, under %s', async (_name, key) => {
      markRegisteredEndpointHeld('user-1', fingerprint);
      getSubscription.mockResolvedValue(browserSubscription(ENDPOINT, key));

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(true);

      expect(apiClient.post).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(apiClient.delete).toHaveBeenCalledWith(
        '/push/subscriptions/d-1',
        undefined,
      );
      expect(readRegisteredEndpoint()).toBeNull();
    });

    it('re-posts the same endpoint once and clears the held flag', async () => {
      markRegisteredEndpointHeld('user-1', fingerprint);
      vi.mocked(apiClient.post).mockResolvedValue({
        data: { id: 'd-1', endpointFingerprint: fingerprint },
      });

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(true);

      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(apiClient.post).toHaveBeenCalledWith('/push/subscriptions', {
        endpoint: ENDPOINT,
        p256dh: 'p',
        auth: 'a',
        applicationServerKey: PUBLIC_KEY,
        deviceName: undefined,
      });
      expect(apiClient.delete).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(readRegisteredEndpoint()).toEqual({
        userId: 'user-1',
        fingerprint,
        held: false,
      });
    });

    it('registers a rotated endpoint and retires the row it replaced', async () => {
      const rotated = 'https://updates.push.services.mozilla.com/wpush/v2/rotated';
      const rotatedFingerprint = await fingerprintEndpoint(rotated);
      markRegisteredEndpointHeld('user-1', fingerprint);
      getSubscription.mockResolvedValue(browserSubscription(rotated));
      vi.mocked(apiClient.post).mockResolvedValue({
        data: { id: 'd-2', endpointFingerprint: rotatedFingerprint },
      });
      vi.mocked(apiClient.get).mockResolvedValue({
        data: [
          { id: 'd-1', endpointFingerprint: fingerprint },
          { id: 'd-2', endpointFingerprint: rotatedFingerprint },
        ],
      });

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(true);

      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(apiClient.delete).toHaveBeenCalledWith(
        '/push/subscriptions/d-1',
        undefined,
      );
      // Retired BEFORE the new endpoint is posted, so the old held row does not
      // count against the device cap the new row is checked under.
      expect(
        vi.mocked(apiClient.delete).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(apiClient.post).mock.invocationCallOrder[0]);
      expect(readRegisteredEndpoint()).toEqual({
        userId: 'user-1',
        fingerprint: rotatedFingerprint,
        held: false,
      });
    });

    it.each([
      ['a 409 claimed', httpError(409, ENDPOINT_CLAIMED_CODE)],
      ['the device cap', httpError(400)],
    ])('releases locally and retires the held row on %s', async (_name, refusal) => {
      markRegisteredEndpointHeld('user-1', fingerprint);
      vi.mocked(apiClient.post).mockRejectedValue(refusal);

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(true);

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(apiClient.delete).toHaveBeenCalledWith(
        '/push/subscriptions/d-1',
        undefined,
      );
      expect(readRegisteredEndpoint()).toBeNull();
    });

    // Not a refusal of this registration: the next sign-in or load tries again.
    it.each([
      ['no answer at all', new Error('Network Error')],
      ['a 503 from a gateway mid-deploy', httpError(503)],
      ['a 500', httpError(500)],
      ['a 401', httpError(401)],
      ['a 429', httpError(429)],
    ])('keeps the subscription and the held marker on %s', async (_name, failure) => {
      markRegisteredEndpointHeld('user-1', fingerprint);
      vi.mocked(apiClient.post).mockRejectedValue(failure);

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(false);

      expect(unsubscribe).not.toHaveBeenCalled();
      expect(apiClient.delete).not.toHaveBeenCalled();
      expect(readRegisteredEndpoint()?.held).toBe(true);
    });

    it('forgets a held marker the browser no longer has a subscription for', async () => {
      markRegisteredEndpointHeld('user-1', fingerprint);
      getSubscription.mockResolvedValue(null);

      await expect(resumePushAfterSignIn(PUBLIC_KEY)).resolves.toBe(true);

      expect(apiClient.post).not.toHaveBeenCalled();
      expect(apiClient.delete).toHaveBeenCalledWith(
        '/push/subscriptions/d-1',
        undefined,
      );
      expect(readRegisteredEndpoint()).toBeNull();
    });
  });
});
