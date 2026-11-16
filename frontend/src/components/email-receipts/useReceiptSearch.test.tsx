import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import { RECEIPT_SEARCH_DEBOUNCE_MS, useReceiptSearch } from './useReceiptSearch';

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  router: { replace: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => '/email-receipts',
  useSearchParams: () => nav.params,
}));

describe('useReceiptSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    nav.params = new URLSearchParams();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts from the URL and writes nothing while the URL already says it', () => {
    nav.params = new URLSearchParams('tab=emails&q=hello&in=body&from=2026-09-01&to=2026-09-30');
    const { result } = renderHook(() => useReceiptSearch());
    expect(result.current.input).toEqual({ text: 'hello', searchIn: 'body', dateFrom: '2026-09-01', dateTo: '2026-09-30' });
    expect(result.current.search).toEqual({ search: 'hello', searchIn: 'body', dateFrom: '2026-09-01', dateTo: '2026-09-30' });
    expect(result.current.active).toBe(true);
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  it('applies the text after it has rested, and writes it to the URL', () => {
    const { result } = renderHook(() => useReceiptSearch());
    const idle = result.current.search;
    act(() => result.current.change({ text: 'inv' }));
    act(() => result.current.change({ text: 'invoice ' }));
    expect(result.current.input.text).toBe('invoice ');
    expect(result.current.search).toBe(idle);
    act(() => {
      vi.advanceTimersByTime(RECEIPT_SEARCH_DEBOUNCE_MS - 1);
    });
    expect(result.current.search).toBe(idle);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.search).toEqual({ search: 'invoice' });
    expect(nav.router.replace).toHaveBeenLastCalledWith('/email-receipts?q=invoice&tab=emails', { scroll: false });
  });

  it('applies the field and the dates at once, and the search is left out without a text', () => {
    const { result } = renderHook(() => useReceiptSearch());
    act(() => result.current.change({ searchIn: 'sender', dateFrom: '2026-09-01' }));
    expect(result.current.search).toEqual({ dateFrom: '2026-09-01' });
    expect(nav.router.replace).toHaveBeenLastCalledWith('/email-receipts?from=2026-09-01&tab=emails', { scroll: false });
  });

  it('does not apply a backwards range and says so', () => {
    const { result } = renderHook(() => useReceiptSearch());
    act(() => result.current.change({ dateFrom: '2026-09-10', dateTo: '2026-09-01' }));
    expect(result.current.rangeBackwards).toBe(true);
    expect(result.current.search).toEqual({});
  });

  it('keeps the same search object while the applied search is the same', () => {
    const { result } = renderHook(() => useReceiptSearch());
    act(() => result.current.change({ text: 'a' }));
    act(() => {
      vi.advanceTimersByTime(RECEIPT_SEARCH_DEBOUNCE_MS);
    });
    const applied = result.current.search;
    act(() => result.current.change({ text: 'a ' }));
    act(() => {
      vi.advanceTimersByTime(RECEIPT_SEARCH_DEBOUNCE_MS);
    });
    expect(result.current.search).toBe(applied);
  });

  it('clears at once, without waiting for the delay', () => {
    nav.params = new URLSearchParams('q=hello&from=2026-09-01');
    const { result } = renderHook(() => useReceiptSearch());
    expect(result.current.hasInput).toBe(true);
    act(() => result.current.clear());
    expect(result.current.search).toEqual({});
    expect(result.current.active).toBe(false);
    expect(result.current.hasInput).toBe(false);
    expect(nav.router.replace).toHaveBeenLastCalledWith('/email-receipts?tab=emails', { scroll: false });
  });
});
