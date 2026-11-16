import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@/test/render';
import { useRereadOnVisible } from './useRereadOnVisible';

describe('useRereadOnVisible', () => {
  it('re-reads on focus and on becoming visible, and not on mount', () => {
    const reread = vi.fn();
    const { unmount } = renderHook(() => useRereadOnVisible(reread));
    expect(reread).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reread).toHaveBeenCalledTimes(2);

    // Detached on unmount: a listener that outlives its surface re-reads into
    // state nobody renders.
    unmount();
    window.dispatchEvent(new Event('focus'));
    expect(reread).toHaveBeenCalledTimes(2);
  });

  it('ignores a visibility change to hidden', () => {
    const reread = vi.fn();
    renderHook(() => useRereadOnVisible(reread));
    const spy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reread).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
