import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@/test/render';
import { waitFor } from '@testing-library/react';
import { useAuthStore } from '@/store/authStore';
import {
  markRegisteredEndpointHeld,
  rememberRegisteredEndpoint,
} from '@/lib/push';
import { subscribePushDevices } from '@/lib/pushDevicesSignal';
import { usePushResumeOnSignIn } from './usePushResumeOnSignIn';

const mockGetConfig = vi.fn();
const mockResume = vi.fn();

vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: { getConfig: () => mockGetConfig() },
  resumePushAfterSignIn: (publicKey: string) => mockResume(publicKey),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('usePushResumeOnSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockResolvedValue({
      enabled: true,
      publicKey: 'PUB',
      configured: true,
      keyUnreadable: false,
    });
    mockResume.mockResolvedValue(true);
    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'user-1' } as never,
    });
  });

  afterEach(() => {
    // Unmount first: a store write with the hook still mounted re-renders
    // outside act(), which `src/test/act-guard.ts` fails.
    cleanup();
    useAuthStore.setState({ isAuthenticated: false, user: null });
  });

  // An ordinary page load: the cost of mounting this everywhere is one
  // localStorage read.
  it('requests nothing on a load without a held marker', async () => {
    rememberRegisteredEndpoint('user-1', 'aaaabbbbccccdddd');

    renderHook(() => usePushResumeOnSignIn());
    await act(async () => {});

    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('requests nothing when no marker exists at all', async () => {
    renderHook(() => usePushResumeOnSignIn());
    await act(async () => {});

    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  it("leaves another account's held subscription alone", async () => {
    markRegisteredEndpointHeld('user-2', 'aaaabbbbccccdddd');

    renderHook(() => usePushResumeOnSignIn());
    await act(async () => {});

    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('waits for a signed-in reader', async () => {
    markRegisteredEndpointHeld('user-1', 'aaaabbbbccccdddd');
    useAuthStore.setState({ isAuthenticated: false, user: null });

    renderHook(() => usePushResumeOnSignIn());
    await act(async () => {});

    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  it('resumes once for the account the marker names, then re-reads the devices', async () => {
    markRegisteredEndpointHeld('user-1', 'aaaabbbbccccdddd');
    const changed = vi.fn();
    const unsubscribe = subscribePushDevices(changed);

    const { rerender } = renderHook(() => usePushResumeOnSignIn());

    await waitFor(() => expect(mockResume).toHaveBeenCalledWith('PUB'));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));

    rerender();
    await act(async () => {});
    expect(mockResume).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  // The shell stays mounted across a client-side sign-out and sign-in, so the
  // same account signing in again must get a second attempt.
  it('resumes again after the same account signs out and back in without a reload', async () => {
    markRegisteredEndpointHeld('user-1', 'aaaabbbbccccdddd');

    const { rerender } = renderHook(() => usePushResumeOnSignIn());
    await waitFor(() => expect(mockResume).toHaveBeenCalledTimes(1));

    await act(async () => {
      useAuthStore.setState({ isAuthenticated: false, user: null });
    });
    rerender();
    markRegisteredEndpointHeld('user-1', 'aaaabbbbccccdddd');
    await act(async () => {
      useAuthStore.setState({
        isAuthenticated: true,
        user: { id: 'user-1' } as never,
      });
    });
    rerender();

    await waitFor(() => expect(mockResume).toHaveBeenCalledTimes(2));
  });

  it('does nothing while the instance offers no push', async () => {
    markRegisteredEndpointHeld('user-1', 'aaaabbbbccccdddd');
    mockGetConfig.mockResolvedValue({
      enabled: false,
      publicKey: null,
      configured: false,
      keyUnreadable: false,
    });

    renderHook(() => usePushResumeOnSignIn());

    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled());
    await act(async () => {});
    expect(mockResume).not.toHaveBeenCalled();
  });
});
