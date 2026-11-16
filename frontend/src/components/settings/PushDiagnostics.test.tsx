import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { PushDiagnostics } from './PushDiagnostics';
import { markRegisteredEndpointHeld } from '@/lib/push';

// Keep the pure helpers real; stub only the network, so the mount gather does
// not reach axios.
vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: {
    getConfig: vi.fn().mockResolvedValue({
      enabled: true,
      publicKey: 'BPublicKey',
      configured: true,
      keyUnreadable: false,
    }),
    listDevices: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn(),
    removeDevice: vi.fn(),
    sendTest: vi.fn(),
  },
}));

/**
 * A "granted" web permission in front of a service worker -- the state in which
 * Android can still hide every notification, which is the whole reason this
 * readout exists.
 */
function installBrowser() {
  const registration = {
    active: {},
    installing: null,
    waiting: null,
    scope: 'https://app.example/',
    getNotifications: vi.fn().mockResolvedValue([]),
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(null),
      permissionState: vi.fn().mockResolvedValue('granted'),
    },
  };
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: { permission: 'granted' },
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn().mockResolvedValue(registration) },
  });
  return registration;
}

async function renderDiagnostics() {
  await act(async () => {
    render(<PushDiagnostics />);
  });
  // Drain the mount gather's promise chain so nothing lands outside act.
  await act(async () => {});
}

describe('PushDiagnostics', () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(globalThis as object, 'Notification');
    Reflect.deleteProperty(navigator as object, 'serviceWorker');
  });

  beforeEach(() => {
    installBrowser();
  });

  it('dumps the signals this browser reports, with the API names verbatim', async () => {
    await renderDiagnostics();

    // The three permission doors, side by side: a disagreement between them is
    // itself the signal a reader is looking for.
    expect(screen.getByText('Notification.permission')).toBeInTheDocument();
    expect(
      screen.getByText('permissions.query(notifications)'),
    ).toBeInTheDocument();
    expect(screen.getByText('pushManager.permissionState')).toBeInTheDocument();
    expect(screen.getByText('server devices')).toBeInTheDocument();
  });

  // Whether the browser kept a subscription across a sign-out for the server
  // to hold, which is the state a "push did not come back" report turns on.
  it('reports whether the stored marker is held', async () => {
    markRegisteredEndpointHeld('someone', 'aaaabbbbccccdddd');

    await renderDiagnostics();

    const label = screen.getByText('registeredEndpoint marker.held');
    expect(label.nextElementSibling).toHaveTextContent('true');
    window.localStorage.clear();
  });

  /**
   * The regression this replaced. "Show a test notification" showed a
   * notification straight from the service worker and could only ever report
   * that the browser had CREATED one -- indistinguishable, on the Android device
   * the panel exists for, from having done nothing at all. "Send test
   * notification", one panel above, exercises the real delivery path and reports
   * per device, so the weaker of the two tests was the one sitting next to the
   * evidence.
   */
  it('offers no notification of its own -- the delivery test above is the test', async () => {
    await renderDiagnostics();

    expect(screen.queryByText('Show a test notification')).toBeNull();
    expect(screen.queryByText(/nothing here can confirm/i)).toBeNull();
    // What it does still offer: re-read the signals, and copy them out.
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Copy report')).toBeInTheDocument();
  });
});
