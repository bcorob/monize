import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@/test/render';
import { waitFor } from '@testing-library/react';
import { useAiConfigured } from './useAiConfigured';

vi.mock('@/lib/ai', () => ({
  aiApi: { getStatus: vi.fn() },
}));

import { aiApi } from '@/lib/ai';

const getStatus = aiApi.getStatus as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAiConfigured', () => {
  it('reports not configured until the status answers', async () => {
    getStatus.mockResolvedValue({ configured: true });

    const { result } = renderHook(() => useAiConfigured());
    expect(result.current).toEqual({ configured: false, resolved: false });

    await waitFor(() => {
      expect(result.current).toEqual({ configured: true, resolved: true });
    });
  });

  it('reports not configured when the user has no provider', async () => {
    getStatus.mockResolvedValue({ configured: false });

    const { result } = renderHook(() => useAiConfigured());

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.configured).toBe(false);
  });

  it('treats a failed status read as "cannot offer it", not as configured', async () => {
    // A surface reading this offers a paid lookup. A network failure is not
    // evidence that a provider exists, so it must not open that door.
    getStatus.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useAiConfigured());

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.configured).toBe(false);
  });

  it('ignores an answer that arrives after unmount', async () => {
    let settle: (value: unknown) => void = () => {};
    getStatus.mockReturnValue(new Promise((resolve) => { settle = resolve; }));

    const { unmount } = renderHook(() => useAiConfigured());
    unmount();
    settle({ configured: true });

    // No act() warning and no state write: the assertion is that resolving
    // after unmount does not throw.
    await Promise.resolve();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});
