/**
 * Guards for turning a payee's stored contact details into links.
 *
 * Deliberate siblings of `toSafeExternalUrl` in `external-url.ts` rather than a
 * loosening of it: that guard rejects everything but http(s) precisely so a
 * stored `javascript:...` cannot become a runnable `href`, and widening it to
 * admit `tel:` would admit far more than that. These build the one scheme each
 * caller needs, from a value each one has checked itself.
 *
 * Every value is a stored row -- possibly imported, possibly predating any
 * normaliser -- so nothing here trusts its input.
 */

/**
 * Map services an address link can be sent to, as stored in the user's
 * `defaultMapProvider` preference.
 *
 * Every one of these applies on DESKTOP only: iOS and Android always hand off
 * to the device's own map app (see mapsUrl). 'device' is the unset default and
 * resolves to OpenStreetMap on a desktop; it is a value rather than an absence
 * so a user can deliberately choose it again after picking something specific.
 *
 * Mirrors MAP_PROVIDERS in the backend's update-preferences DTO, which is what
 * the API and the database CHECK constraint validate against.
 */
export const MAP_PROVIDERS = [
  'device',
  'openstreetmap',
  'google',
  'apple',
  'bing',
  'waze',
] as const;

export type MapProvider = (typeof MAP_PROVIDERS)[number];

/** Which maps application the viewer's device will open. */
export type MapPlatform = 'ios' | 'android' | 'other';

/**
 * The viewer's platform, for choosing a maps URL scheme.
 *
 * User-agent sniffing is the wrong tool for feature detection, but this is not
 * feature detection: `geo:` and `maps.apple.com` are the handoffs each platform
 * registers a default app for, and nothing in the DOM reports which one the
 * device honours. `other` is the safe answer -- a web map opens everywhere.
 */
export function detectMapPlatform(
  userAgent: string | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.userAgent,
): MapPlatform {
  if (!userAgent) return 'other';
  // iPadOS 13+ reports a desktop Safari UA, distinguishable by touch support.
  if (/iPad|iPhone|iPod/.test(userAgent)) return 'ios';
  if (/Macintosh/.test(userAgent) && typeof navigator !== 'undefined') {
    if (navigator.maxTouchPoints > 1) return 'ios';
  }
  if (/Android/.test(userAgent)) return 'android';
  return 'other';
}

/**
 * A multi-line address as a single query string. Newlines and runs of
 * whitespace collapse to one separator, because a maps query is one line and an
 * encoded newline is just noise in it.
 */
export function addressQuery(address: string): string {
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MapsUrlInput {
  address: string;
  /**
   * The user's chosen map service, which applies on desktop only -- a device
   * with its own map app ignores it. Absent or 'device' means OpenStreetMap on
   * desktop, which is what everyone got before the preference existed.
   */
  provider?: MapProvider;
  /** Injectable for tests; defaults to the current device. */
  platform?: MapPlatform;
}

/**
 * A URL that opens the viewer's default maps application at the payee.
 *
 * The address is handed over as a search rather than a resolved point: nothing
 * here geocodes, so the maps application does that itself, which is what it is
 * good at. Returns null when there is no address to search for, so a caller
 * renders text rather than a link to nowhere.
 */
export function mapsUrl({
  address,
  provider,
  platform,
}: MapsUrlInput): string | null {
  const query = addressQuery(address);
  if (!query) return null;

  const label = encodeURIComponent(query);
  const target = platform ?? detectMapPlatform();

  // A device with its own map app always hands off to it, whatever the
  // preference says. The setting describes what a DESKTOP browser should do,
  // where there is no such app -- sending a phone to a web map instead of the
  // app it has installed is the behaviour the address link exists to avoid.
  //
  // The check lives here rather than at the call site because this is the one
  // place a provider becomes a URL: a second caller that skipped it would be a
  // rule nobody enforces.
  if (target === 'ios') return `https://maps.apple.com/?q=${label}`;
  // geo:0,0?q=<query> is the documented form for searching by text rather than
  // dropping a pin at literal 0,0.
  if (target === 'android') return `geo:0,0?q=${label}`;

  switch (provider) {
    case 'openstreetmap':
      return `https://www.openstreetmap.org/search?query=${label}`;
    case 'google':
      // The documented Maps URLs form, which every platform's Google app
      // registers as a deep link.
      return `https://www.google.com/maps/search/?api=1&query=${label}`;
    case 'apple':
      return `https://maps.apple.com/?q=${label}`;
    case 'bing':
      return `https://www.bing.com/maps?where1=${label}`;
    case 'waze':
      return `https://waze.com/ul?q=${label}`;
    default:
      // 'device' on a desktop, and any value a newer build might have stored.
      return `https://www.openstreetmap.org/search?query=${label}`;
  }
}

/**
 * A `tel:` href for a stored phone number, or null when it holds no number.
 *
 * Only the FIRST dialable run, not every digit in the value. Stripping the
 * non-digits out of the whole string folds whatever trails the number into it:
 * "555 0100 ext. 12" becomes tel:555010012, which dials a number nobody wrote
 * down. The run therefore ends where one number has to end -- at a letter, a
 * slash, a comma -- so an extension, a note ("555 0100 (mobile)") or a second
 * number after it is left out rather than concatenated.
 *
 * A value holding no digits at all ("call the shop") returns null, so the
 * caller renders text rather than a link that opens the dialer on nothing.
 */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // The optional leading + belongs to the number wherever it sits, so it is
  // captured beside the first digit rather than assumed to start the string.
  const run = phone.trim().match(/(\+?)[0-9][0-9\s()+.-]*/);
  if (!run) return null;
  const digits = run[0].replace(/\D/g, '');
  // An extension is part of the number to dial, and `tel:` has a way to say so
  // (RFC 3966), which is the same way the value is stored -- so it travels
  // rather than being dropped or, worse, folded into the digits. Read from the
  // stored suffix only: the dialable run above deliberately stops before it, so
  // "555 0100 ext. 12" cannot become tel:555010012.
  const ext = /;ext=([0-9]+)/.exec(phone)?.[1];
  return `tel:${run[1] ? '+' : ''}${digits}${ext ? `;ext=${ext}` : ''}`;
}

/**
 * A `mailto:` href for a stored email address, or null when the value is not
 * one.
 *
 * The shape check is deliberately the same shallow one the form applies rather
 * than a full RFC parse; what it is really for is rejecting a value carrying
 * whitespace or a newline, which is how a header would be injected into the
 * composed message.
 */
export function mailtoHref(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return `mailto:${encodeURIComponent(trimmed)}`;
}
