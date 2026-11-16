import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@/test/render';
import { act, waitFor } from '@testing-library/react';
import { useContactLookupAvailable } from './useContactLookupAvailable';

vi.mock('@/lib/payee-lookup', () => ({
  payeeLookupApi: { getStatus: vi.fn() },
}));

import { payeeLookupApi } from '@/lib/payee-lookup';

const getStatus = payeeLookupApi.getStatus as unknown as ReturnType<typeof vi.fn>;

const status = (over: Record<string, unknown> = {}) => ({
  available: true,
  source: 'ai',
  aiConfigured: true,
  googlePlaces: { mode: 'none', enabled: true, capReached: false },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useContactLookupAvailable', () => {
  it('offers nothing until the status answers', async () => {
    getStatus.mockResolvedValue(status());

    const { result } = renderHook(() => useContactLookupAvailable());
    expect(result.current).toMatchObject({
      available: false,
      resolved: false,
      source: null,
      aiConfigured: false,
    });

    await waitFor(() => {
      expect(result.current).toMatchObject({
        available: true,
        resolved: true,
        source: 'ai',
        // The settings section reads this to decide whether the AI row is
        // worth drawing at all.
        aiConfigured: true,
      });
    });
  });

  it('answers again on refresh, because the settings card changes the answer', async () => {
    // Switching the last source off is what MAKES a lookup impossible, and a
    // status read once on mount would go on saying a lookup can run for the
    // rest of the session.
    getStatus.mockResolvedValue(status());

    const { result } = renderHook(() => useContactLookupAvailable());
    await waitFor(() => expect(result.current.available).toBe(true));

    getStatus.mockResolvedValue(
      status({ available: false, source: null, aiConfigured: false }),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      available: false,
      resolved: true,
      source: null,
    });
  });

  it('is available on Google Places with no AI provider at all', async () => {
    // The whole reason this hook replaced useAiConfigured: a user who
    // configured Places and no AI would otherwise never see the button.
    getStatus.mockResolvedValue(
      status({
        source: 'google-places',
        aiConfigured: false,
        googlePlaces: { mode: 'user', enabled: true, capReached: false },
      }),
    );

    const { result } = renderHook(() => useContactLookupAvailable());

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.available).toBe(true);
    expect(result.current.source).toBe('google-places');
  });

  it('reports nothing available when neither source is configured', async () => {
    getStatus.mockResolvedValue(
      status({ available: false, source: null, aiConfigured: false }),
    );

    const { result } = renderHook(() => useContactLookupAvailable());

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.available).toBe(false);
    expect(result.current.source).toBeNull();
  });

  it('treats a failed status read as "cannot offer it", not as available', async () => {
    // A surface reading this offers a paid lookup. A network failure is not
    // evidence that a source exists, so it must not open that door.
    getStatus.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useContactLookupAvailable());

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.available).toBe(false);
    expect(result.current.source).toBeNull();
  });

  it('ignores an answer that arrives after unmount', async () => {
    let settle: (value: unknown) => void = () => {};
    getStatus.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    const { unmount } = renderHook(() => useContactLookupAvailable());
    unmount();
    settle(status());

    await Promise.resolve();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});
