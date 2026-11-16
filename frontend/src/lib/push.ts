import type { AxiosRequestConfig } from 'axios';
import apiClient from './api';
import { getErrorCode } from './errors';
import { useAuthStore } from '@/store/authStore';

/** Why a device stopped being reachable. Mirrors the backend enum. */
export type PushDisabledReason = 'GONE' | 'KEY_ROTATED' | 'FAILING';

/**
 * The wire a device is on. `'webpush'` is a browser vendor's push service;
 * `'unifiedpush'` is a UnifiedPush distributor endpoint (ntfy/NextPush) -- the
 * same encrypted Web Push protocol, gated by a separate channel toggle. Mirrors
 * the backend `PushTransport`. Absent on a response from before it, so read it
 * defensively (treat a missing value as `'webpush'`, today's only wire).
 *
 * The array is the source the type derives from, so `push-transport.contract.test.ts`
 * can hold it equal to the backend entity's `PUSH_TRANSPORTS` (which the DB CHECK
 * is in turn held equal to) -- a type alone cannot be compared at test time.
 */
export const PUSH_TRANSPORTS = ['webpush', 'unifiedpush'] as const;
export type PushTransport = (typeof PUSH_TRANSPORTS)[number];

export interface PushDevice {
  id: string;
  /**
   * A prefix of the endpoint's SHA-256, so this browser can recognise which row
   * is itself. The endpoint is a delivery credential and never leaves the
   * server, so the list carries a digest instead.
   */
  endpointFingerprint: string;
  deviceName: string | null;
  userAgent: string | null;
  /**
   * The address this endpoint was registered from, refreshed on each
   * re-registration. `null` where the server could not determine one and
   * ABSENT on a response from a backend that predates the field -- both read as
   * unknown, and neither is a placeholder to render as an address.
   *
   * It is not where the device is now: a push goes from the server to the push
   * service, which reaches the device over a connection the server never sees.
   */
  registeredIp?: string | null;
  /** Which wire this device is on; absent means `'webpush'` (an older backend). */
  transport?: PushTransport;
  createdAt: string;
  lastSeenAt: string;
  lastSuccessAt: string | null;
  disabledAt: string | null;
  disabledReason: PushDisabledReason | null;
  /**
   * When this device's account signed out of the browser it lives in. Nothing
   * is delivered to it until that account signs in there again, and then it
   * resumes on its own. Absent on a response from an older backend, and read
   * as not held, which is the only state such a backend has.
   */
  heldAt?: string | null;
}

export interface PushConfig {
  /**
   * All three: the instance holds a key pair, that key pair can still be used,
   * and an administrator has left the channel on.
   */
  enabled: boolean;
  publicKey: string | null;
  /** False when the server has no key pair at all, so the UI can say which. */
  configured: boolean;
  /**
   * A stored key pair the server can no longer decrypt. Its own state, because
   * the repair differs from every other reason push is unavailable -- and
   * without it this surface told users an administrator had switched push off,
   * which is false and sends them to the wrong person.
   */
  keyUnreadable: boolean;
  /**
   * Whether the SERVER holds an encryption key at all.
   *
   * `keyUnreadable` has two causes and their repairs are opposites: a key that
   * changed under a live database is fixed by rotating the key pair, a missing
   * `ENCRYPTION_KEY` by setting it and restarting -- and rotation REFUSES in
   * that state, so telling the reader to rotate was an instruction that could
   * not work. Absent means "an older backend", which reads as the rotate case,
   * the message this surface has always shown.
   */
  encryptionAvailable?: boolean;
}

export type PushTestStatus = 'sent' | 'unconfigured' | 'expired' | 'transient';

export interface PushTestDeviceResult {
  id: string;
  deviceName: string | null;
  status: PushTestStatus;
  disabledReason?: PushDisabledReason;
}

export interface PushTestResult {
  attempted: number;
  delivered: number;
  devices: PushTestDeviceResult[];
}

/**
 * Marks a request the caller has already decided not to wait for, so a 401
 * arriving after the session it belonged to does not drive the interceptor's
 * refresh-and-redirect on top of a sign-out that is already navigating.
 */
type BestEffort = AxiosRequestConfig & { _skipAuthRedirect: true };

const BEST_EFFORT: BestEffort = { _skipAuthRedirect: true };

export const pushApi = {
  getConfig: async (): Promise<PushConfig> => {
    const response = await apiClient.get<PushConfig>('/push/config');
    return response.data;
  },

  listDevices: async (options?: BestEffort): Promise<PushDevice[]> => {
    const response = await apiClient.get<PushDevice[]>(
      '/push/subscriptions',
      options,
    );
    return response.data;
  },

  subscribe: async (payload: {
    endpoint: string;
    p256dh: string;
    auth: string;
    /** The key the browser subscribed with, which the server checks is current. */
    applicationServerKey: string;
    deviceName?: string;
  }): Promise<PushDevice> => {
    const response = await apiClient.post<PushDevice>(
      '/push/subscriptions',
      payload,
    );
    return response.data;
  },

  removeDevice: async (id: string, options?: BestEffort): Promise<void> => {
    await apiClient.delete(`/push/subscriptions/${id}`, options);
  },

  /** Stop delivery to one of the account's devices until it registers again. */
  holdDevice: async (id: string, options?: BestEffort): Promise<void> => {
    await apiClient.post(`/push/subscriptions/${id}/hold`, undefined, options);
  },

  sendTest: async (): Promise<PushTestResult> => {
    const response = await apiClient.post<PushTestResult>('/push/test');
    return response.data;
  },
};

/**
 * Why this browser cannot register for push, when it cannot.
 *
 * `unsupported` and `denied` need different words from the user's side: the
 * first is a browser that will never do this, the second is a decision the user
 * made and can undo in site settings. `ios-browser` is the one that looks like a
 * bug and is not -- Safari delivers Web Push only to a PWA installed on the home
 * screen (iOS 16.4+), so the repair is "Add to Home Screen", not "try again".
 */
export type PushUnavailableReason = 'unsupported' | 'denied' | 'ios-browser';

export interface PushSupport {
  supported: boolean;
  reason?: PushUnavailableReason;
}

function isIos(nav: Navigator): boolean {
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    // iPadOS 13+ reports as a Mac; the touch points are what give it away.
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  );
}

/**
 * Whether this is Monize running as an installed iOS web app.
 *
 * The one platform where "the prompt never appeared" is a real outcome rather
 * than a user dismissing it, so it is the one platform whose refusal message
 * has to say something different. See `requestNotificationPermission`.
 */
export function isInstalledIosWebApp(
  win: Window = window,
  nav: Navigator = navigator,
): boolean {
  return isIos(nav) && isStandalone(win);
}

function isStandalone(win: Window): boolean {
  const iosStandalone = (win.navigator as Navigator & { standalone?: boolean })
    .standalone;
  return (
    iosStandalone === true ||
    win.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

/**
 * Whether this browser can register for push, and why not when it cannot.
 *
 * Deliberately does NOT read `Notification.permission === 'default'` as a
 * failure: that is the state a first-time user is in, and the whole point of the
 * permission flow is that the prompt appears when they ask for it.
 */
export function getPushSupport(
  win: Window = window,
  nav: Navigator = navigator,
): PushSupport {
  // Read through a typed accessor rather than `in` narrowing: an `in` check
  // rewrites the parameter's type to an intersection, and the next property read
  // then fails to compile for a reason that has nothing to do with the runtime.
  const notification = (win as Window & { Notification?: typeof Notification })
    .Notification;

  if (
    !('serviceWorker' in nav) ||
    !('PushManager' in win) ||
    notification === undefined
  ) {
    // On iOS the missing PushManager is not a permanent verdict about the
    // browser -- it is a verdict about this *window*, and installing the app
    // changes it. Saying "unsupported" would send the user away for good.
    return {
      supported: false,
      reason: isIos(nav) && !isStandalone(win) ? 'ios-browser' : 'unsupported',
    };
  }
  if (notification.permission === 'denied') {
    return { supported: false, reason: 'denied' };
  }
  return { supported: true };
}

/**
 * The applicationServerKey `pushManager.subscribe` wants: the VAPID public key,
 * base64url as the server stores it, as raw bytes.
 */
export function urlBase64ToUint8Array(
  base64UrlKey: string,
): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64UrlKey.length % 4)) % 4);
  const base64 = (base64UrlKey + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Backed by an explicit ArrayBuffer, not the default ArrayBufferLike: the
  // Push API's applicationServerKey takes a BufferSource, which a possibly-shared
  // buffer does not satisfy.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** A browser subscription flattened into what the API accepts. */
export function toSubscriptionPayload(
  subscription: PushSubscriptionJSON,
): { endpoint: string; p256dh: string; auth: string } | null {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return null;
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/**
 * How long to wait for the service worker before giving up on it.
 *
 * `navigator.serviceWorker.ready` never rejects: a worker that fails to install
 * -- `/sw.js` misserved behind a proxy, say -- leaves the promise pending for
 * the life of the page. Awaited unbounded it takes the whole push block down
 * with it: the settings panel never leaves its loading state and simply
 * vanishes, and Enable and Remove hang with no error.
 */
export const SERVICE_WORKER_READY_TIMEOUT_MS = 5000;

/** Thrown when the service worker never became ready, so callers can say so. */
export class ServiceWorkerUnavailableError extends Error {
  constructor() {
    super('The Monize service worker is not available in this browser.');
    this.name = 'ServiceWorkerUnavailableError';
  }
}

/** `navigator.serviceWorker.ready` with a bound, because it has none of its own. */
export async function serviceWorkerReady(
  timeoutMs = SERVICE_WORKER_READY_TIMEOUT_MS,
): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ServiceWorkerUnavailableError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Thrown when the browser refuses, so the caller can tell the user which refusal. */
export class PushPermissionError extends Error {
  constructor(readonly reason: 'denied' | 'dismissed') {
    super(`Notification permission ${reason}`);
    this.name = 'PushPermissionError';
  }
}

/**
 * Ask for notification permission across both spellings of the API.
 *
 * `Notification.requestPermission()` returns a promise in every current
 * browser and `undefined` in the older WebKit builds that only implement the
 * callback form -- and `await undefined` is `undefined`, which is not
 * `'granted'`, so the caller reports a refusal the user was never asked for.
 * The callback argument is still in the specification and is ignored by
 * browsers that return a promise, so passing both covers either shape without
 * a feature test that cannot be written before the call.
 *
 * Deliberately unbounded: an open permission prompt the user has not answered
 * is not a timeout, and resolving early would register a device the browser
 * will never deliver to.
 *
 * **Must be reached from a live user gesture.** On iOS the prompt is dropped
 * silently -- resolving `'default'` with nothing shown -- once the transient
 * activation from the click has been spent, which is why the caller starts
 * this before any `await` and before any state update.
 */
export function requestNotificationPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (permission: NotificationPermission) => {
      if (settled) return;
      settled = true;
      resolve(permission);
    };
    const returned = Notification.requestPermission(settle) as
      | Promise<NotificationPermission>
      | undefined;
    if (typeof returned?.then === 'function') {
      // A rejection is not an answer, so fall back to what the browser now
      // holds rather than inventing one.
      returned.then(settle, () => settle(Notification.permission));
    }
  });
}

/**
 * Which refusal to report, as the key under `settings.notifications.push.toasts`.
 * `denied` is a decision the user can undo in site settings -- except on an
 * installed iOS web app, where the block lives in iOS Settings and no browser
 * menu exists. `dismissed` normally means they closed the prompt -- except on
 * that same installed app, where it is also what a prompt that never appeared
 * looks like, and "choose Allow when the browser asks" sends them to look for a
 * dialogue that is not coming. One rule, so the settings panel and the app-wide
 * banner cannot disagree about the same error.
 */
export function pushPermissionMessageKey(
  error: PushPermissionError,
  installedIos: boolean = isInstalledIosWebApp(),
):
  | 'permissionDenied'
  | 'permissionDeniedIos'
  | 'permissionDismissed'
  | 'permissionNoPrompt' {
  if (error.reason === 'denied') {
    return installedIos ? 'permissionDeniedIos' : 'permissionDenied';
  }
  return installedIos ? 'permissionNoPrompt' : 'permissionDismissed';
}

/**
 * The browser's push service refused to mint a subscription: permission was
 * granted, the service worker is active, and `pushManager.subscribe` still
 * rejected ("Registration failed - push service error"). On Brave that is the
 * default state -- it blocks Google's push service until "Use Google services
 * for push messaging" is switched on in its privacy settings -- so the error
 * carries whether this is Brave, and the copy can send the reader to the one
 * switch that fixes it rather than to a generic "try again".
 */
export class PushServiceError extends Error {
  readonly brave: boolean;

  constructor(brave: boolean, cause?: unknown) {
    super(
      brave
        ? 'The push service refused the registration (Brave blocks it until Google push messaging is enabled).'
        : 'The push service refused the registration.',
    );
    this.name = 'PushServiceError';
    this.brave = brave;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Brave exposes itself only through `navigator.brave.isBrave()`; the UA says Chrome. */
export async function isBraveBrowser(
  nav: Navigator | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
): Promise<boolean> {
  const brave = (nav as { brave?: { isBrave?: () => Promise<boolean> } } | undefined)
    ?.brave;
  if (!brave || typeof brave.isBrave !== 'function') return false;
  try {
    return (await brave.isBrave()) === true;
  } catch {
    return false;
  }
}

/**
 * `pushManager.subscribe`, with the one failure this app can explain named. A
 * refusal from the push service (AbortError, or Chromium's "push service error"
 * message) becomes a `PushServiceError`; anything else is rethrown as it was.
 */
async function subscribeOrExplain(
  registration: ServiceWorkerRegistration,
  applicationServerKey: Uint8Array<ArrayBuffer>,
): Promise<PushSubscription> {
  try {
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  } catch (error) {
    if (isPushServiceRefusal(error)) {
      throw new PushServiceError(await isBraveBrowser(), error);
    }
    throw error;
  }
}

function isPushServiceRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'AbortError' ||
    /push service error|registration failed/i.test(error.message)
  );
}

/**
 * Ask the browser for permission and register this device.
 *
 * The permission request is made here, on a user's click, and never on page
 * load: a prompt that arrives before anyone has asked for notifications is the
 * one users answer with "Block", and `denied` is not something the app can undo.
 *
 * It is also the FIRST thing this function does, and callers must reach it
 * without an `await` in between: the browser only shows the prompt while the
 * click's transient activation lasts, and iOS spends that on the first
 * suspension -- after which `requestPermission` resolves `'default'` with
 * nothing shown and the user is told to grant a permission they were never
 * asked for.
 *
 * Re-uses an existing browser subscription when there is one, and replaces it
 * when it was minted under a different key -- after an instance rotates its key
 * pair the old subscription still exists in the browser and is undeliverable.
 *
 * A 409 means the endpoint this browser holds is registered to a different
 * account (someone whose session ended without a logout). The server refuses to
 * take it over -- an endpoint is not proof of ownership -- so the repair is
 * here: unsubscribe and subscribe again, which mints a fresh endpoint nobody
 * holds. Exactly one retry, because a second 409 on a brand-new endpoint would
 * mean something other than a stale claim.
 */
export async function enablePushOnThisDevice(
  publicKey: string,
  deviceName?: string,
): Promise<PushDevice> {
  const permission = await requestNotificationPermission();
  if (permission === 'denied') throw new PushPermissionError('denied');
  if (permission !== 'granted') throw new PushPermissionError('dismissed');

  const registration = await serviceWorkerReady();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);

  let subscription = await registration.pushManager.getSubscription();
  if (
    subscription &&
    !keyMatches(
      subscription.options?.applicationServerKey,
      applicationServerKey,
    )
  ) {
    // Minted under a superseded key pair: the push service would reject every
    // message signed with the current one, so the stale subscription is dropped
    // rather than re-registered.
    //
    // The server row for it goes too. Replacing the subscription leaves a row
    // whose endpoint no longer exists anywhere -- listed as live, undeliverable,
    // and counting against the per-account device cap, with nothing that would
    // ever retire it (only a delivery's own 404 does, and nothing delivers to
    // it). Retiring it is part of replacing it, not a separate tidy-up.
    const superseded = await fingerprintEndpoint(subscription.endpoint);
    await subscription.unsubscribe();
    subscription = null;
    await retireServerRowFor(superseded);
  }
  // Whether THIS call minted the subscription: only then is dropping it on a
  // failure the right cleanup. A subscription the browser already had may well
  // belong to a row that is perfectly fine.
  let minted = false;
  if (!subscription) {
    subscription = await subscribeOrExplain(registration, applicationServerKey);
    minted = true;
  }

  try {
    return await postSubscription(subscription, publicKey, deviceName);
  } catch (error) {
    if (!isEndpointClaimed(error)) {
      // Any other refusal -- the per-account device cap, a rotated key, a 500 --
      // leaves a browser subscription with no server row behind it: a
      // permission this app holds, no longer uses, and the user cannot see. If
      // this call is what minted it, this call takes it back.
      if (minted) await safeUnsubscribe(subscription);
      throw error;
    }
    // This one DOES unsubscribe whatever the browser holds, including another
    // account's, and that is the difference from every other path here: it runs
    // only because the reader clicked Enable. A browser profile holds exactly
    // one subscription per origin, so there is no version of "B gets push in
    // this browser" that leaves A's endpoint alive -- the platform decides that,
    // not this code. What the 409 refuses is the silent half: taking over A's
    // ROW. A's row stays theirs, is undeliverable from this moment, and retires
    // itself on its next delivery (410 from the push service -> GONE).
    await safeUnsubscribe(subscription);
    const replacement = await subscribeOrExplain(
      registration,
      applicationServerKey,
    );
    try {
      return await postSubscription(replacement, publicKey, deviceName);
    } catch (retryError) {
      await safeUnsubscribe(replacement);
      throw retryError;
    }
  }
}

/** Unsubscribing is cleanup, so its own failure must not replace the real one. */
async function safeUnsubscribe(subscription: PushSubscription): Promise<void> {
  try {
    await subscription.unsubscribe();
  } catch {
    // Best effort.
  }
}

async function postSubscription(
  subscription: PushSubscription,
  applicationServerKey: string,
  deviceName?: string,
): Promise<PushDevice> {
  const payload = toSubscriptionPayload(subscription.toJSON());
  if (!payload) {
    throw new Error('The browser returned an incomplete push subscription.');
  }
  const device = await pushApi.subscribe({
    ...payload,
    applicationServerKey,
    deviceName,
  });
  // Recorded from the SERVER's digest of the endpoint rather than a second one
  // computed here, so "the endpoint I registered" and "the endpoint the row
  // names" are the same value by construction. Only on success: a refused
  // registration has nothing to remember.
  //
  // The owner is recorded with it: the row belongs to whoever this request was
  // authenticated as, and a browser profile outlives a session. With no id
  // available nothing is written, because a marker with an unknown owner is
  // read as somebody else's and would be worse than none.
  const ownerId = useAuthStore.getState().user?.id ?? null;
  if (ownerId !== null) {
    rememberRegisteredEndpoint(ownerId, device.endpointFingerprint);
  }
  return device;
}

/** Matches `ENDPOINT_CLAIMED_CODE` in the backend's push subscription service. */
export const ENDPOINT_CLAIMED_CODE = 'pushEndpointClaimed';

/**
 * This endpoint belongs to someone else -- and only that.
 *
 * Deliberately not "any 409": a key rotation between page load and click is
 * also a 409, and answering it by unsubscribing would destroy a working
 * registration and then retry with the same stale key, guaranteed to fail. The
 * server ships a machine-readable code for exactly this branch.
 */
function isEndpointClaimed(error: unknown): boolean {
  return getErrorCode(error) === ENDPOINT_CLAIMED_CODE;
}

/**
 * Delete the server row for an endpoint this browser no longer holds.
 *
 * Best effort by construction: it runs beside an operation whose success matters
 * more (registering the replacement), and a row left behind is untidy rather
 * than harmful -- it is retired by the retention sweep, or by its first delivery.
 */
export async function retireServerRowFor(fingerprint: string): Promise<void> {
  try {
    const row = (await pushApi.listDevices()).find(
      (device) => device.endpointFingerprint === fingerprint,
    );
    if (row) await pushApi.removeDevice(row.id);
  } catch {
    // As above.
  }
}

/**
 * Whether a subscription was minted under the key we are about to sign with.
 *
 * A browser that does not expose `options.applicationServerKey` answers
 * "unknown", and unknown is treated as a mismatch: a subscription minted under a
 * superseded key is silently undeliverable, while re-minting one that was
 * actually current costs a fresh endpoint and a retired row. Only one of those
 * two failures is visible to the user, so the guess goes the other way -- and
 * the row for the endpoint we drop is retired either way, which is what made the
 * conservative choice affordable.
 */
function keyMatches(
  stored: ArrayBuffer | null | undefined,
  wanted: Uint8Array,
): boolean {
  if (!stored) return false;
  const bytes = new Uint8Array(stored);
  if (bytes.length !== wanted.length) return false;
  return bytes.every((byte, index) => byte === wanted[index]);
}

/**
 * Remove this device: unsubscribe in the browser AND delete the server row.
 *
 * Both halves, always. A server row without a browser subscription is a device
 * the user cannot receive on; a browser subscription without a server row is a
 * permission the app has and no longer uses.
 */
export async function disablePushOnThisDevice(
  deviceId?: string,
): Promise<void> {
  try {
    if (deviceId) await pushApi.removeDevice(deviceId);
  } finally {
    // "Both halves, always" has to survive the first half failing. A browser
    // subscription with no server row is a permission the app holds and no
    // longer uses, and the user has no way to see it; the reverse self-heals on
    // the next delivery's 410.
    await releaseLocalPushSubscription();
  }
}

/**
 * Where this browser records the endpoint fingerprint it last registered.
 *
 * Per-browser, per-origin, and never read by the server -- what it exists for is
 * a question no server row can answer: when the server has no live row for the
 * endpoint this browser holds, WHY not. Two causes with opposite repairs. The
 * push service rotated the subscription under us, in which case the right move is
 * to register the new endpoint; or another device revoked this one, in which case
 * registering it again would undo the user's revocation.
 *
 * A cleared store (a private window, blocked site data) reads as `null`, which
 * classifies as a revocation -- the conservative half: nothing is re-registered
 * behind the user's back, and the Enable button is still there.
 */
const REGISTERED_ENDPOINT_KEY = 'monize.push.registeredEndpoint';

/**
 * The endpoint this browser registered, and WHOSE registration it was.
 *
 * `localStorage` is per origin, but a push subscription's owner is an account:
 * two people share one browser profile, and one of them signing in must not be
 * able to reason about the other's registration. Without the owner recorded, the
 * second account's Settings page saw a subscription it had no row for, read it
 * as "revoked" and unsubscribed the browser -- silently taking push away from
 * the first account, whose device list still showed the row as active.
 *
 * So the marker states both, and a marker written by somebody else is not
 * evidence about the reader. Stored as JSON; a value from the previous
 * single-string format reads as an unknown owner, which is the same answer as
 * "not mine" and errs toward doing nothing.
 */
interface RegisteredEndpointMarker {
  userId: string;
  fingerprint: string;
  /**
   * The account signed out of this browser and the server confirmed it holds
   * the row (`holdPushForSignOut`), so the subscription was kept on purpose and
   * the same account's next sign-in here resumes it
   * (`resumePushAfterSignIn`). A marker written before the field reads as
   * `false`.
   */
  held: boolean;
}

/** Every accessor is guarded: some browsers throw on `localStorage` outright. */
export function rememberRegisteredEndpoint(
  userId: string,
  fingerprint: string,
): void {
  writeRegisteredEndpoint({ userId, fingerprint, held: false });
}

/**
 * Record that the server holds this browser's row for `userId` across a
 * sign-out, so the subscription the browser keeps is resumed, not reconciled
 * away, when that account signs in here again.
 */
export function markRegisteredEndpointHeld(
  userId: string,
  fingerprint: string,
): void {
  writeRegisteredEndpoint({ userId, fingerprint, held: true });
}

function writeRegisteredEndpoint(marker: RegisteredEndpointMarker): void {
  try {
    window.localStorage.setItem(
      REGISTERED_ENDPOINT_KEY,
      JSON.stringify(marker satisfies RegisteredEndpointMarker),
    );
  } catch {
    // Storage blocked. The reconciliation degrades to doing nothing, which is
    // the behaviour before it existed.
  }
}

export function forgetRegisteredEndpoint(): void {
  try {
    window.localStorage.removeItem(REGISTERED_ENDPOINT_KEY);
  } catch {
    // As above.
  }
}

export function readRegisteredEndpoint(): RegisteredEndpointMarker | null {
  try {
    const raw = window.localStorage.getItem(REGISTERED_ENDPOINT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const marker = parsed as Partial<RegisteredEndpointMarker>;
    if (
      typeof marker.userId !== 'string' ||
      typeof marker.fingerprint !== 'string' ||
      marker.userId.length === 0 ||
      marker.fingerprint.length === 0
    ) {
      return null;
    }
    return {
      userId: marker.userId,
      fingerprint: marker.fingerprint,
      held: marker.held === true,
    };
  } catch {
    // Blocked storage, or a value from the pre-owner format (a bare
    // fingerprint, which is not JSON). Both are "no information".
    return null;
  }
}

/**
 * Whether Monize should ASK for notifications, and what it can honestly offer.
 *
 * There is no way to grant this permission at install time: the web app manifest
 * has no such field, and `Notification.requestPermission()` is the only door --
 * per origin, from a user gesture. So "install with notifications" is really
 * "ask at the right moment, with a button", and the moment is what this decides.
 *
 * It is deliberately NOT what a news site does. Those call
 * `requestPermission()` on page load, which browsers now punish rather than
 * honour: Firefox has required a user gesture since 72 and shows nothing
 * without one, Chrome quiets the prompt for origins with a poor grant rate, and
 * iOS shows it only inside an installed web app. So the browser prompt here is
 * always behind a click on our own copy, which explains what the notifications
 * are for first.
 *
 * Three answers, because the reader's next action differs in each -- and the
 * two that offer no button are the ones Monize had nothing to say about at all:
 * an iPhone user in a Safari tab, and anybody who has already refused.
 */
export type PushPromptState =
  /** One click away: our copy, then the browser's own prompt. */
  | { kind: 'enable' }
  /** iOS in a browser tab. Push needs the Home Screen app first. */
  | { kind: 'install-ios' }
  /** Refused. Only the browser's own settings can undo it. */
  | { kind: 'blocked'; installedIosWebApp: boolean }
  /** Nothing worth saying: already registered, unavailable, or not yet known. */
  | null;

export function pushPromptState(input: {
  /** Whether this deployment offers push at all, and can. */
  channelAvailable: boolean;
  /** `getPushSupport()`, or null before it has been read. */
  support: PushSupport | null;
  /** Whether this browser already holds a live registration for the reader. */
  registeredHere: boolean;
  /** Whether this window is Monize installed on iOS. */
  installedIosWebApp: boolean;
}): PushPromptState {
  const { channelAvailable, support, registeredHere, installedIosWebApp } =
    input;
  // An unavailable channel is an administrator's business, not a banner's; a
  // device already registered has nothing to be asked for; and `null` support
  // means the read has not happened, which is not the same as a refusal.
  if (!channelAvailable || registeredHere || support === null) return null;
  if (support.supported) return { kind: 'enable' };
  if (support.reason === 'denied') return { kind: 'blocked', installedIosWebApp };
  if (support.reason === 'ios-browser') return { kind: 'install-ios' };
  // 'unsupported': there is no instruction that would help, so there is no ask.
  return null;
}

const PROMPT_DISMISSED_KEY = 'monize.push.promptDismissed';

interface PromptDismissal {
  userId: string;
  kinds: string[];
}

/**
 * Whether this reader has already waved a given prompt away.
 *
 * Per account as well as per kind, for the reason the registered-endpoint marker
 * is: `localStorage` belongs to a browser profile and this decision belongs to a
 * person, so one account dismissing the ask must not silence it for the next
 * person to sign in. Per KIND because the three states ask for different things:
 * waving away "enable" says nothing about wanting to know that the browser is
 * blocking Monize later on.
 */
export function pushPromptDismissed(
  userId: string | null,
  kind: string,
): boolean {
  if (userId === null) return false;
  const stored = readDismissal();
  return stored !== null && stored.userId === userId && stored.kinds.includes(kind);
}

export function rememberPushPromptDismissal(
  userId: string | null,
  kind: string,
): void {
  if (userId === null) return;
  const stored = readDismissal();
  const kinds =
    stored !== null && stored.userId === userId
      ? [...new Set([...stored.kinds, kind])]
      : [kind];
  try {
    window.localStorage.setItem(
      PROMPT_DISMISSED_KEY,
      JSON.stringify({ userId, kinds } satisfies PromptDismissal),
    );
  } catch {
    // Storage blocked. The banner then reappears next load, which is the
    // behaviour before it could be dismissed -- annoying, never destructive.
  }
}

function readDismissal(): PromptDismissal | null {
  try {
    const raw = window.localStorage.getItem(PROMPT_DISMISSED_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const value = parsed as Partial<PromptDismissal>;
    if (typeof value.userId !== 'string' || !Array.isArray(value.kinds)) {
      return null;
    }
    return {
      userId: value.userId,
      kinds: value.kinds.filter((kind): kind is string => typeof kind === 'string'),
    };
  } catch {
    return null;
  }
}

/**
 * What this browser's push registration is, relative to the server's rows.
 *
 * `rotated` and `revoked` are the two ways "the server has no live row for the
 * endpoint I hold" happens, and reading them as one state is a defect either
 * way round: re-register on a revocation and the user's removal is undone the
 * next time the revoked device opens the app; do nothing on a rotation and
 * delivery is dead while the device list still shows the old row as active.
 */
export type PushRegistrationState =
  | { kind: 'in-sync' }
  | { kind: 'no-subscription' }
  | {
      kind: 'rotated';
      fingerprint: string;
      /** The endpoint the browser replaced, whose server row is now dead. */
      supersededFingerprint: string;
    }
  | { kind: 'revoked'; fingerprint: string }
  /** The subscription this browser holds belongs to a different account. */
  | { kind: 'foreign'; fingerprint: string };

export function classifyPushRegistration(input: {
  /** The fingerprint of the subscription this browser holds, or null. */
  currentFingerprint: string | null;
  /** The fingerprints of the account's LIVE server rows. */
  liveFingerprints: readonly string[];
  /** What this browser last registered, from `readRegisteredEndpoint`. */
  marker: { userId: string; fingerprint: string } | null;
  /** Who is reading. A marker naming anyone else says nothing about them. */
  readerUserId: string | null;
}): PushRegistrationState {
  const { currentFingerprint, liveFingerprints, marker, readerUserId } = input;
  if (currentFingerprint === null) return { kind: 'no-subscription' };
  if (liveFingerprints.includes(currentFingerprint)) return { kind: 'in-sync' };

  // A marker somebody else wrote is not evidence about the reader -- whichever
  // endpoint it names. Releasing the subscription would revoke their push from a
  // device they still hold; registering it would sign the reader up for
  // notifications they never asked for, passing the permission gate only because
  // the other account granted it. Neither repair is the reader's to make.
  if (
    marker !== null &&
    (readerUserId === null || marker.userId !== readerUserId)
  ) {
    return { kind: 'foreign', fingerprint: currentFingerprint };
  }

  if (marker !== null && marker.fingerprint !== currentFingerprint) {
    // The browser replaced the endpoint this account registered. Rotation --
    // and the endpoint it replaced is named, because the row for it is still
    // live on the server and nothing else will ever retire it.
    return {
      kind: 'rotated',
      fingerprint: currentFingerprint,
      supersededFingerprint: marker.fingerprint,
    };
  }
  return { kind: 'revoked', fingerprint: currentFingerprint };
}

/**
 * Drop this browser's push subscription without touching any server row.
 *
 * What logout needs: the subscription is scoped to the origin rather than to
 * the session, so leaving it registered keeps delivering the departing
 * account's notifications onto a browser the next person is using, and holds
 * the endpoint against their own subscribe. The server row is deliberately left
 * alone -- it belongs to the account that is leaving, and its next delivery
 * answers 410 and retires it.
 *
 * Never throws: a logout that fails on the push channel is worse than a
 * subscription that outlives it.
 */
export async function releaseLocalPushSubscription(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const registration = await serviceWorkerReady();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    // Best effort.
  } finally {
    // The endpoint this browser registered is gone either way, and a stale
    // marker would classify the next subscription as a rotation.
    forgetRegisteredEndpoint();
  }
}

/**
 * The same digest prefix the server puts on every device row, computed from this
 * browser's own endpoint -- which is how a row is recognised as "this device"
 * without the endpoint ever being sent back.
 */
export async function fingerprintEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(endpoint),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, ENDPOINT_FINGERPRINT_LENGTH);
}

/** Matches ENDPOINT_FINGERPRINT_LENGTH in the backend's push subscription service. */
export const ENDPOINT_FINGERPRINT_LENGTH = 16;

/**
 * The digest of the endpoint this browser currently holds, or null when it holds
 * none. What "this device" means on the settings page.
 */
export async function currentDeviceFingerprint(): Promise<string | null> {
  const endpoint = await currentEndpoint();
  return endpoint ? fingerprintEndpoint(endpoint) : null;
}

/**
 * How long a sign-out will wait for the push cleanup before moving on.
 *
 * The cleanup is best effort and the session revocation is not, so the two must
 * not share a deadline: awaiting the service worker's own 5-second bound here
 * would stall the sign-out that long, and a tab closed in that window would
 * never revoke its session at all.
 */
export const SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS = 1500;

/**
 * Release this browser's push registration on the way out of a session: the
 * server row AND the browser subscription.
 *
 * Both halves, and the server half is why this cannot wait until after the
 * cookies are cleared -- deleting the row needs the session that is ending.
 * Without it the row stays live, looks healthy in the device list, and counts
 * against the per-account cap while nothing will ever be delivered to it: the
 * 410 that would retire it only arrives when something tries to send.
 *
 * Never throws, and never waits long: whatever has not finished when the bound
 * elapses is abandoned rather than allowed to hold up the sign-out.
 */
export async function releasePushForSignOut(
  timeoutMs = SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      removeThisBrowsersRegistration(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Best effort.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Hold this browser's push registration on the way out of a session, instead
 * of releasing it: the server stops delivering to the row, and the browser
 * keeps its subscription so the same account's next sign-in here resumes push
 * with no prompt (INV-PUSH-011).
 *
 * The browser may keep the subscription only once the server has CONFIRMED
 * the hold. A subscription left in place while its row still delivers would
 * show the departing account's notifications to whoever uses the browser next,
 * which is the defect the release exists to prevent. So every other outcome
 * (no row for this browser, a refusal, an older backend's 404, a delegate's
 * 403, a network error) runs `releasePushForSignOut`'s full release instead.
 *
 * Bounded like the release. If the bound elapses before the hold is
 * confirmed, the browser subscription is released locally without waiting, so
 * an unconfirmed hold never leaves a subscription behind; a hold that commits
 * afterwards only leaves a row the daily sweep removes.
 *
 * Only the header sign-out holds. Account deletion keeps the full release.
 * Never throws.
 */
export async function holdPushForSignOut(
  timeoutMs = SIGN_OUT_PUSH_RELEASE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = { abandoned: false };
  try {
    const finished = await Promise.race([
      holdThisBrowsersRegistration(attempt).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (!finished) {
      attempt.abandoned = true;
      // Not awaited: the sign-out has already waited as long as it will.
      void releaseLocalPushSubscription();
    }
  } catch {
    // Best effort.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function holdThisBrowsersRegistration(attempt: {
  abandoned: boolean;
}): Promise<void> {
  const marker = readRegisteredEndpoint();
  const readerId = useAuthStore.getState().user?.id ?? null;
  // Another account's subscription: not this sign-out's to hold or release.
  if (marker !== null && readerId !== null && marker.userId !== readerId) {
    return;
  }

  let held = false;
  try {
    const fingerprint = readerId === null ? null : await currentDeviceFingerprint();
    if (readerId !== null && fingerprint !== null) {
      const mine = (await pushApi.listDevices(BEST_EFFORT)).find(
        (device) => device.endpointFingerprint === fingerprint,
      );
      if (mine) {
        await pushApi.holdDevice(mine.id, BEST_EFFORT);
        if (!attempt.abandoned) {
          // Written from what this browser holds and who is leaving, not
          // patched onto the old marker: a cleared or missing one must not
          // turn a confirmed hold into a subscription nothing will resume.
          markRegisteredEndpointHeld(readerId, fingerprint);
          held = true;
        }
      }
    }
  } catch {
    // Unconfirmed: the release below runs.
  }
  if (!held && !attempt.abandoned) await removeThisBrowsersRegistration();
}

/**
 * Resume push for the account that just signed in, when this browser kept its
 * subscription across that account's own sign-out (`holdPushForSignOut`).
 *
 * Acts only when the marker is held AND names the signed-in user; an ordinary
 * page load costs nothing. The resume is a re-registration, so the server's
 * cap, key and ownership checks all apply, and its upsert clears the hold.
 *
 * - Permission no longer granted: the subscription cannot show anything, so it
 *   is released and the held row retired rather than left for the sweep.
 * - No subscription any more: the marker is stale; it is forgotten and the
 *   held row retired.
 * - Minted under a key the instance no longer uses, or one the browser will
 *   not disclose: released locally and the held row retired (a real rotation
 *   has already retired it, and retiring it again is harmless). Enable is the
 *   repair.
 * - The browser replaced the endpoint while signed out: the old row is retired
 *   FIRST, so it does not hold a slot under the device cap against the new
 *   one, then the new endpoint is registered -- the repair the settings panel
 *   makes for a rotation.
 * - A refusal from the server (409 claimed, the device cap, any other 4xx):
 *   released locally and the held row retired, so neither half promises a
 *   delivery that will not happen. A request that never got an answer, or got
 *   a 5xx, a 401, a 408 or a 429, changes nothing, and the next sign-in or
 *   page load tries again.
 *
 * Returns whether it changed anything, so the caller knows to re-read the
 * device state. Never throws.
 */
export async function resumePushAfterSignIn(publicKey: string): Promise<boolean> {
  const marker = readRegisteredEndpoint();
  const readerId = useAuthStore.getState().user?.id ?? null;
  if (marker === null || !marker.held || readerId === null) return false;
  if (marker.userId !== readerId) return false;

  try {
    if (
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    ) {
      await releaseLocalPushSubscription();
      await retireServerRowFor(marker.fingerprint);
      return true;
    }

    const registration = await serviceWorkerReady();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      forgetRegisteredEndpoint();
      await retireServerRowFor(marker.fingerprint);
      return true;
    }
    if (
      !keyMatches(
        subscription.options?.applicationServerKey,
        urlBase64ToUint8Array(publicKey),
      )
    ) {
      await releaseLocalPushSubscription();
      await retireServerRowFor(marker.fingerprint);
      return true;
    }

    const current = await fingerprintEndpoint(subscription.endpoint);
    if (current !== marker.fingerprint) {
      await retireServerRowFor(marker.fingerprint);
    }
    try {
      await postSubscription(subscription, publicKey);
    } catch (error) {
      if (!isServerRefusal(error)) return false;
      await releaseLocalPushSubscription();
      await retireServerRowFor(marker.fingerprint);
      return true;
    }
    return true;
  } catch {
    // Best effort: the held row stays held, which delivers nothing.
    return false;
  }
}

/**
 * The server answered and refused THIS registration, as opposed to never
 * answering, failing on its own side (5xx, a gateway mid-deploy), losing the
 * session (401) or asking to be retried (408, 429). Only a refusal justifies
 * dropping the browser subscription.
 */
const RETRYABLE_CLIENT_STATUSES: readonly number[] = [401, 408, 429];

function isServerRefusal(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } } | null)
    ?.response?.status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    !RETRYABLE_CLIENT_STATUSES.includes(status)
  );
}

async function removeThisBrowsersRegistration(): Promise<void> {
  // A subscription another account registered in this browser profile is not
  // this sign-out's to destroy: unsubscribing it revokes THEIR push on a device
  // they still hold, and they find out when a notification does not arrive. The
  // marker is what distinguishes the two, so an absent one keeps the old
  // behaviour -- with no information, the departing account is the likely owner
  // and a subscription nobody claims must not outlive the session.
  const marker = readRegisteredEndpoint();
  const readerId = useAuthStore.getState().user?.id ?? null;
  if (marker !== null && readerId !== null && marker.userId !== readerId) {
    return;
  }

  try {
    const fingerprint = await currentDeviceFingerprint();
    if (fingerprint) {
      const mine = (await pushApi.listDevices(BEST_EFFORT)).find(
        (device) => device.endpointFingerprint === fingerprint,
      );
      if (mine) await pushApi.removeDevice(mine.id, BEST_EFFORT);
    }
  } catch {
    // The row may outlive the browser subscription; the local half below is
    // what actually stops notifications appearing, so it runs either way.
  }
  await releaseLocalPushSubscription();
}

/** The endpoint this browser currently holds, or null. */
export async function currentEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await serviceWorkerReady();
  const subscription = await registration.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}

/**
 * A name the user will recognise in their own device list, from the platform the
 * browser reports. Only ever a default -- the field is theirs to change later.
 * Shared by every path that registers this browser (the settings panel and the
 * app-wide banner), so the row they create is the same row.
 */
export function defaultDeviceName(
  nav: Navigator = navigator,
): string | undefined {
  const ua = nav.userAgent;
  if (!ua) return undefined;
  const platform = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Macintosh/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  if (!platform && !browser) return undefined;
  return [browser, platform].filter(Boolean).join(' on ');
}

/**
 * The `setState` updater for a re-read `PushSupport`: keeps the previous object
 * when the answer has not changed, so a tab switch is not a re-render.
 */
export function samePushSupportOr(
  previous: PushSupport | null,
  next: PushSupport,
): PushSupport {
  return previous !== null &&
    previous.supported === next.supported &&
    previous.reason === next.reason
    ? previous
    : next;
}
