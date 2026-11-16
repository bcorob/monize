import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pushPromptDismissed,
  pushPromptState,
  rememberPushPromptDismissal,
  type PushSupport,
} from './push';

/**
 * When Monize may ask for notifications, and what it can honestly offer.
 *
 * The whole point is that this is a DECISION, not a page-load side effect: the
 * browser prompt is always behind a click, so this function decides only which
 * of three things to say -- and two of them offer no button at all, because
 * nothing a button could do would help an iPhone user in a Safari tab or
 * somebody who has already refused. Those two states are exactly what the
 * product had nothing to say about.
 */
describe('pushPromptState', () => {
  const supported: PushSupport = { supported: true };
  const denied: PushSupport = { supported: false, reason: 'denied' };
  const iosBrowser: PushSupport = { supported: false, reason: 'ios-browser' };
  const unsupported: PushSupport = { supported: false, reason: 'unsupported' };

  const ask = (overrides: Partial<Parameters<typeof pushPromptState>[0]> = {}) =>
    pushPromptState({
      channelAvailable: true,
      support: supported,
      registeredHere: false,
      installedIosWebApp: false,
      ...overrides,
    });

  it('offers to turn notifications on when a click could do it', () => {
    expect(ask()).toEqual({ kind: 'enable' });
  });

  // The two states with no button, and the reason this exists at all.
  it('tells an iPhone in a browser tab to install the app first', () => {
    expect(ask({ support: iosBrowser })).toEqual({ kind: 'install-ios' });
  });

  it('names the repair when the browser is already refusing', () => {
    expect(ask({ support: denied })).toEqual({
      kind: 'blocked',
      installedIosWebApp: false,
    });
  });

  // Which repair differs by platform, and only the caller knows the platform:
  // an installed iOS app is blocked in iOS Settings, not in any site settings.
  it('carries whether the refusal is an installed iOS app', () => {
    expect(ask({ support: denied, installedIosWebApp: true })).toEqual({
      kind: 'blocked',
      installedIosWebApp: true,
    });
  });

  it.each([
    [
      'the instance does not offer push',
      { channelAvailable: false } as const,
    ],
    ['this browser is already registered', { registeredHere: true } as const],
    // Not the same as a refusal: nothing has been read yet, and a banner that
    // renders on "not known" flickers on every page load.
    ['support has not been read yet', { support: null } as const],
    // There is no instruction that would help, so there is no ask.
    ['the browser cannot do push at all', { support: unsupported } as const],
  ])('says nothing when %s', (_name, overrides) => {
    expect(ask(overrides)).toBeNull();
  });
});

describe('the prompt dismissal', () => {
  afterEach(() => vi.unstubAllGlobals());

  const withStore = (initial?: string) => {
    const store = new Map<string, string>();
    if (initial !== undefined) {
      store.set('monize.push.promptDismissed', initial);
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

  it('remembers one kind without silencing the others', () => {
    withStore();

    rememberPushPromptDismissal('user-1', 'enable');

    expect(pushPromptDismissed('user-1', 'enable')).toBe(true);
    // Waving away the offer says nothing about wanting to know, later, that the
    // browser has started blocking Monize.
    expect(pushPromptDismissed('user-1', 'blocked')).toBe(false);
  });

  it('accumulates kinds for the same reader', () => {
    withStore();

    rememberPushPromptDismissal('user-1', 'enable');
    rememberPushPromptDismissal('user-1', 'blocked');

    expect(pushPromptDismissed('user-1', 'enable')).toBe(true);
    expect(pushPromptDismissed('user-1', 'blocked')).toBe(true);
  });

  // `localStorage` belongs to a browser profile and this decision belongs to a
  // person: one account waving the ask away must not silence it for the next
  // person to sign in on the same machine.
  it('does not silence the ask for a different account', () => {
    withStore();

    rememberPushPromptDismissal('user-1', 'enable');

    expect(pushPromptDismissed('user-2', 'enable')).toBe(false);
  });

  it('replaces a previous account\'s record rather than merging with it', () => {
    withStore();

    rememberPushPromptDismissal('user-1', 'enable');
    rememberPushPromptDismissal('user-2', 'blocked');

    expect(pushPromptDismissed('user-2', 'enable')).toBe(false);
    expect(pushPromptDismissed('user-2', 'blocked')).toBe(true);
    expect(pushPromptDismissed('user-1', 'enable')).toBe(false);
  });

  it('treats an unknown reader as not having dismissed anything', () => {
    withStore();

    rememberPushPromptDismissal(null, 'enable');

    expect(pushPromptDismissed(null, 'enable')).toBe(false);
  });

  it.each([
    ['a malformed record', '{"userId":"user-1"}'],
    ['a JSON scalar', '"user-1"'],
    ['not JSON at all', 'user-1'],
  ])('reads %s as nothing dismissed', (_name, raw) => {
    withStore(raw);

    expect(pushPromptDismissed('user-1', 'enable')).toBe(false);
  });

  // A private window throws on localStorage outright. The banner then reappears
  // next load, which is annoying and never destructive -- it must not take the
  // page down.
  it('survives a store that throws', () => {
    vi.stubGlobal('window', {
      get localStorage(): never {
        throw new Error('blocked');
      },
    });

    expect(() => rememberPushPromptDismissal('user-1', 'enable')).not.toThrow();
    expect(pushPromptDismissed('user-1', 'enable')).toBe(false);
  });
});
