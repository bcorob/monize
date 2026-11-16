import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@/test/render';
import toast from 'react-hot-toast';
import { EnableThisEndpointButton } from './EnableThisEndpointButton';
import { subscribePushDevices } from '@/lib/pushDevicesSignal';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetConfig = vi.fn();
const mockEnable = vi.fn();
const mockGetPushSupport = vi.fn();

vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: { getConfig: () => mockGetConfig() },
  enablePushOnThisDevice: (...args: unknown[]) => mockEnable(...args),
  getPushSupport: () => mockGetPushSupport(),
  isInstalledIosWebApp: () => false,
  // Declared inside the factory: `vi.mock` is hoisted above every top-level
  // binding in this file, so a class defined outside it is not yet initialised
  // when the factory runs.
  PushPermissionError: class extends Error {
    constructor(readonly reason: 'denied' | 'dismissed') {
      super('permission');
      this.name = 'PushPermissionError';
    }
  },
}));

async function renderButton(props: { registeredHere: boolean; hint?: string }) {
  await act(async () => {
    render(<EnableThisEndpointButton {...props} />);
  });
  await act(async () => {}); // drain the config read
}

describe('EnableThisEndpointButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockResolvedValue({
      enabled: true,
      publicKey: 'PUB',
      configured: true,
      keyUnreadable: false,
    });
    mockGetPushSupport.mockReturnValue({ supported: true });
    mockEnable.mockResolvedValue({ id: 'd-1' });
  });
  afterEach(() => cleanup());

  it('offers the action, with its hint, for an unregistered endpoint', async () => {
    await renderButton({ registeredHere: false, hint: 'Not registered here.' });

    expect(screen.getByText('Not registered here.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Enable on this device' }),
    ).toBeInTheDocument();
  });

  it('registers this browser and announces it to every list on the page', async () => {
    const reload = vi.fn();
    const stop = subscribePushDevices(reload);
    await renderButton({ registeredHere: false });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable on this device' }));
    });

    await waitFor(() => expect(mockEnable).toHaveBeenCalledTimes(1));
    // The public key the instance published -- a subscription minted under any
    // other one is rejected by the push service.
    expect(mockEnable.mock.calls[0][0]).toBe('PUB');
    // Announced rather than handed to one caller: the devices panel below reads
    // the same rows and would otherwise go on offering to enable a device that
    // was just registered.
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith(
      'Push notifications enabled on this device',
    );
    stop();
  });

  it('announces nothing when the registration failed', async () => {
    const { PushPermissionError } = await import('@/lib/push');
    mockEnable.mockRejectedValue(new PushPermissionError('denied'));
    const reload = vi.fn();
    const stop = subscribePushDevices(reload);
    await renderButton({ registeredHere: false });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable on this device' }));
    });
    await act(async () => {}); // drain the rejection handler

    expect(reload).not.toHaveBeenCalled();
    stop();
  });

  it('maps a refused permission to its own repair, not a generic failure', async () => {
    const { PushPermissionError } = await import('@/lib/push');
    mockEnable.mockRejectedValue(new PushPermissionError('denied'));
    await renderButton({ registeredHere: false });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable on this device' }));
    });
    await act(async () => {}); // drain the rejection handler

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This browser is blocking notifications for Monize. Allow them in the browser’s site settings, then try again.',
      ),
    );
  });

  // The three states where the control disappears WITH its hint. A button whose
  // only outcome is failure is worse than no button, and a sentence left
  // standing beside a button that is not there tells the reader to press it.
  it('renders nothing once the endpoint is registered', async () => {
    await renderButton({ registeredHere: true, hint: 'Not registered here.' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Not registered here.')).toBeNull();
  });

  it('renders nothing when the instance does not offer push', async () => {
    mockGetConfig.mockResolvedValue({
      enabled: false,
      publicKey: null,
      configured: false,
      keyUnreadable: false,
    });
    await renderButton({ registeredHere: false, hint: 'Not registered here.' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Not registered here.')).toBeNull();
  });

  it('renders nothing when this browser cannot receive push', async () => {
    mockGetPushSupport.mockReturnValue({ supported: false, reason: 'denied' });
    await renderButton({ registeredHere: false, hint: 'Not registered here.' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Not registered here.')).toBeNull();
  });

  // A failed config read is not "push is off here" either, but this control's
  // contract is to disappear whenever it cannot help -- so it disappears rather
  // than offering an action it has no key for.
  it('renders nothing when the configuration could not be read', async () => {
    mockGetConfig.mockRejectedValue(new Error('boom'));
    await renderButton({ registeredHere: false, hint: 'Not registered here.' });
    expect(screen.queryByRole('button')).toBeNull();
  });
});
