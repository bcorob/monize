import { describe, expect, it } from 'vitest';
import {
  addressQuery,
  detectMapPlatform,
  mailtoHref,
  MAP_PROVIDERS,
  mapsUrl,
  telHref,
} from './contact-links';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120';

describe('detectMapPlatform', () => {
  it('recognises iOS devices', () => {
    expect(detectMapPlatform(IOS_UA)).toBe('ios');
  });

  it('recognises Android devices', () => {
    expect(detectMapPlatform(ANDROID_UA)).toBe('android');
  });

  it('falls back to a web map everywhere else', () => {
    expect(detectMapPlatform(DESKTOP_UA)).toBe('other');
    expect(detectMapPlatform(undefined)).toBe('other');
    expect(detectMapPlatform('')).toBe('other');
  });
});

describe('addressQuery', () => {
  it('collapses a multi-line address to one line', () => {
    expect(addressQuery('1912 Pike Pl\nSeattle, WA 98101')).toBe(
      '1912 Pike Pl, Seattle, WA 98101',
    );
  });

  it('drops blank lines and repeated whitespace', () => {
    expect(addressQuery('  1912   Pike Pl \n\n\n  Seattle  ')).toBe(
      '1912 Pike Pl, Seattle',
    );
  });
});

describe('mapsUrl', () => {
  const address = '1912 Pike Pl, Seattle';

  it('opens Apple Maps with the address on iOS', () => {
    expect(mapsUrl({ address, platform: 'ios' })).toBe(
      `https://maps.apple.com/?q=${encodeURIComponent(address)}`,
    );
  });

  it('hands the address to the default app via geo: on Android', () => {
    // geo:0,0?q=<text> searches; a bare geo:0,0 would drop a pin in the
    // Atlantic.
    expect(mapsUrl({ address, platform: 'android' })).toBe(
      `geo:0,0?q=${encodeURIComponent(address)}`,
    );
  });

  it('links a web map elsewhere', () => {
    expect(mapsUrl({ address, platform: 'other' })).toBe(
      `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`,
    );
  });

  it('collapses a multi-line address into the query', () => {
    const url = mapsUrl({
      address: '1912 Pike Pl\nSeattle, WA',
      platform: 'other',
    });

    expect(url).toContain(encodeURIComponent('1912 Pike Pl, Seattle, WA'));
  });

  describe('with an explicit provider, on a desktop', () => {
    it.each([
      ['openstreetmap', 'https://www.openstreetmap.org/search?query='],
      ['google', 'https://www.google.com/maps/search/?api=1&query='],
      ['apple', 'https://maps.apple.com/?q='],
      ['bing', 'https://www.bing.com/maps?where1='],
      ['waze', 'https://waze.com/ul?q='],
    ] as const)('sends %s to its own search URL', (provider, prefix) => {
      expect(mapsUrl({ address, provider, platform: 'other' })).toBe(
        `${prefix}${encodeURIComponent(address)}`,
      );
    });
  });

  describe('on a device with its own map app', () => {
    // The preference describes what a desktop browser does. A phone or tablet
    // hands off to the app it has installed, whatever is stored -- sending it
    // to a web map instead is what the address link exists to avoid.
    //
    // Parametrised over every provider rather than a representative one, so a
    // provider added later cannot quietly escape the rule.
    const IOS_HANDOFF = `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
    const ANDROID_HANDOFF = `geo:0,0?q=${encodeURIComponent(address)}`;

    it.each(MAP_PROVIDERS)('ignores %s on iOS', (provider) => {
      expect(mapsUrl({ address, provider, platform: 'ios' })).toBe(IOS_HANDOFF);
    });

    it.each(MAP_PROVIDERS)('ignores %s on Android', (provider) => {
      expect(mapsUrl({ address, provider, platform: 'android' })).toBe(
        ANDROID_HANDOFF,
      );
    });

    it('ignores a provider a newer build might have stored', () => {
      expect(
        mapsUrl({ address, provider: 'yandex' as never, platform: 'ios' }),
      ).toBe(IOS_HANDOFF);
    });
  });

  describe("falling back to the platform", () => {
    it.each([
      ['ios', 'https://maps.apple.com/?q='],
      ['android', 'geo:0,0?q='],
      ['other', 'https://www.openstreetmap.org/search?query='],
    ] as const)("uses the %s hand-off for 'device'", (platform, prefix) => {
      expect(mapsUrl({ address, provider: 'device', platform })).toBe(
        `${prefix}${encodeURIComponent(address)}`,
      );
    });

    it('treats an absent provider exactly as device', () => {
      // Preferences load asynchronously, so the first render passes nothing.
      // It must behave as it did before the preference existed.
      for (const platform of ['ios', 'android', 'other'] as const) {
        expect(mapsUrl({ address, platform })).toBe(
          mapsUrl({ address, provider: 'device', platform }),
        );
      }
    });

    it('falls back for a provider it does not recognise', () => {
      // A value written by a newer build must not produce a broken link.
      expect(
        mapsUrl({
          address,
          provider: 'yandex' as never,
          platform: 'other',
        }),
      ).toContain('openstreetmap.org');
    });
  });

  it('returns null when there is no address to search for', () => {
    expect(mapsUrl({ address: '  ', platform: 'ios' })).toBeNull();
  });

  it('encodes an address that would otherwise break out of the query', () => {
    const url = mapsUrl({ address: 'A & B St #3?x=1', platform: 'other' });

    expect(url).not.toContain('&x=1');
    expect(url).toContain(encodeURIComponent('A & B St #3?x=1'));
  });
});

describe('telHref', () => {
  it('strips formatting a stored number carries', () => {
    expect(telHref('+1 (555) 010-1234')).toBe('tel:+15550101234');
  });

  it('keeps a number with no country code', () => {
    expect(telHref('555-0100')).toBe('tel:5550100');
  });

  it('drops an extension suffix rather than dialling it as digits', () => {
    // The extension's digits are not part of the number: folding them in gives
    // 555010012, which is not a number anyone wrote down.
    expect(telHref('555 0100 ext. 12')).toBe('tel:5550100');
    expect(telHref('+1 206-448-8762 x99')).toBe('tel:+12064488762');
  });

  it('stops at a note or a second number rather than running them together', () => {
    expect(telHref('555 0100 (mobile)')).toBe('tel:5550100');
    expect(telHref('555-0100 / 555-0200')).toBe('tel:5550100');
  });

  it('keeps a country code that does not sit at the very start of the value', () => {
    expect(telHref('Tel: +1 555-0100')).toBe('tel:+15550100');
  });

  it('returns null for a value holding no number at all', () => {
    expect(telHref('call the shop')).toBeNull();
    expect(telHref('')).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref(undefined)).toBeNull();
  });
});

describe('mailtoHref', () => {
  it('builds a mailto for a well-formed address', () => {
    expect(mailtoHref('hello@starbucks.com')).toBe(
      'mailto:hello%40starbucks.com',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(mailtoHref('  hello@starbucks.com  ')).toBe(
      'mailto:hello%40starbucks.com',
    );
  });

  it.each([
    ['plain text', 'not an email'],
    ['no domain dot', 'hello@localhost'],
    ['an embedded newline, which is how a header gets injected', 'a@b.com\nBcc: x@y.com'],
    ['an internal space', 'hello world@example.com'],
    ['nothing before the @', '@example.com'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, value) => {
    expect(mailtoHref(value)).toBeNull();
  });

  it('returns null for absent values', () => {
    expect(mailtoHref(null)).toBeNull();
    expect(mailtoHref(undefined)).toBeNull();
  });
});
describe('telHref with a stored extension', () => {
  it('carries the extension into the dialer, in the form tel: defines', () => {
    // The extension is part of what has to be dialled, and dropping it hands
    // the user a link that reaches a switchboard and stops.
    expect(telHref('+442079460958;ext=12')).toBe('tel:+442079460958;ext=12');
  });

  it('never folds an extension into the digits', () => {
    // The failure this avoids is a link that dials a number nobody wrote down.
    expect(telHref('+442079460958;ext=12')).not.toBe('tel:+44207946095812');
    expect(telHref('555 0100 ext. 12')).toBe('tel:5550100');
  });

  it('leaves a number without one exactly as it was', () => {
    expect(telHref('+12064488762')).toBe('tel:+12064488762');
  });
});

