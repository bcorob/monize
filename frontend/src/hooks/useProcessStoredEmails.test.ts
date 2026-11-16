import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import { useProcessStoredEmails } from './useProcessStoredEmails';

const api = vi.hoisted(() => ({ processBatch: vi.fn() }));
const clearAllCache = vi.hoisted(() => vi.fn());
const notifyAiAction = vi.hoisted(() => vi.fn());

vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { receipts: api } }));
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  clearAllCache,
}));
vi.mock('@/lib/aiActionSignal', () => ({ notifyAiAction }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const answer = (over: Partial<Record<string, unknown>> = {}) => ({
  processed: 2,
  byOutcome: { review: 2 },
  failed: 0,
  remaining: 0,
  since: '2026-10-04T10:00:00.000000Z',
  ...over,
});

describe('useProcessStoredEmails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is idle until a run starts', () => {
    const { result } = renderHook(() => useProcessStoredEmails());
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('sends the statuses it was given on every call of the run', async () => {
    api.processBatch.mockResolvedValueOnce(answer({ remaining: 1, since: 'T1' })).mockResolvedValueOnce(answer({ remaining: 0 }));
    const { result } = renderHook(() => useProcessStoredEmails());
    await act(async () => {
      await result.current.run(['shop.example.com'], ['parse_failed']);
    });
    expect(api.processBatch).toHaveBeenNthCalledWith(1, { domain: 'shop.example.com', statuses: ['parse_failed'] });
    expect(api.processBatch).toHaveBeenNthCalledWith(2, { domain: 'shop.example.com', statuses: ['parse_failed'], since: 'T1' });
  });

  it('loops on the server\'s remaining, sending back since, and sums the answers', async () => {
    api.processBatch
      .mockResolvedValueOnce(answer({ remaining: 3, since: 'T1' }))
      .mockResolvedValueOnce(answer({ processed: 3, byOutcome: { review: 1, unmatched: 2 }, failed: 1, remaining: 0, since: 'T1' }));
    const { result } = renderHook(() => useProcessStoredEmails());
    let totals;
    await act(async () => {
      totals = await result.current.run([undefined]);
    });
    expect(api.processBatch).toHaveBeenNthCalledWith(1, {});
    expect(api.processBatch).toHaveBeenNthCalledWith(2, { since: 'T1' });
    expect(totals).toEqual({ processed: 5, failed: 1, byOutcome: { review: 3, unmatched: 2 }, deleted: 0 });
    expect(result.current.state).toEqual({
      status: 'done',
      cancelled: false,
      totals: { processed: 5, failed: 1, byOutcome: { review: 3, unmatched: 2 }, deleted: 0 },
    });
    expect(clearAllCache).toHaveBeenCalledTimes(1);
    expect(notifyAiAction).toHaveBeenCalledTimes(1);
  });

  it('sums the emails a profile deleted, and reads an answer without the count as none', async () => {
    api.processBatch
      .mockResolvedValueOnce(answer({ deleted: 2, remaining: 3, since: 'T1' }))
      .mockResolvedValueOnce(answer({ remaining: 0, since: 'T1' }));
    const { result } = renderHook(() => useProcessStoredEmails());
    let totals: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      totals = await result.current.run([undefined]);
    });
    expect(totals).toMatchObject({ processed: 4, deleted: 2 });
  });

  it('stops when a call touched nothing, however many it says remain', async () => {
    api.processBatch.mockResolvedValue(answer({ processed: 0, byOutcome: {}, remaining: 7 }));
    const { result } = renderHook(() => useProcessStoredEmails());
    await act(async () => {
      await result.current.run([undefined]);
    });
    expect(api.processBatch).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('done');
    expect(clearAllCache).not.toHaveBeenCalled();
  });

  it('runs each domain in turn with its own since', async () => {
    api.processBatch
      .mockResolvedValueOnce(answer({ since: 'A' }))
      .mockResolvedValueOnce(answer({ since: 'B' }));
    const { result } = renderHook(() => useProcessStoredEmails());
    await act(async () => {
      await result.current.run(['shop.example.com', 'pay.example.com']);
    });
    expect(api.processBatch).toHaveBeenNthCalledWith(1, { domain: 'shop.example.com' });
    expect(api.processBatch).toHaveBeenNthCalledWith(2, { domain: 'pay.example.com' });
  });

  it('cancels between calls: the call in flight finishes, the next is not sent', async () => {
    let release!: (value: unknown) => void;
    api.processBatch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const { result } = renderHook(() => useProcessStoredEmails());
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run([undefined]);
    });
    act(() => result.current.cancel());
    expect(result.current.state).toMatchObject({ status: 'running', cancelling: true });
    await act(async () => {
      release(answer({ remaining: 5 }));
      await run;
    });
    expect(api.processBatch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ status: 'done', cancelled: true, totals: { processed: 2 } });
  });

  it('keeps what was done when a call fails, and says the server\'s reason', async () => {
    api.processBatch
      .mockResolvedValueOnce(answer({ remaining: 4 }))
      .mockRejectedValueOnce(Object.assign(new Error('x'), { response: { data: { message: 'Mailbox is busy' } } }));
    const { result } = renderHook(() => useProcessStoredEmails());
    await act(async () => {
      await result.current.run([undefined]);
    });
    expect(result.current.state).toMatchObject({ status: 'failed', message: 'Mailbox is busy', totals: { processed: 2 } });
    // What was processed before the failure may have changed the ledger.
    expect(clearAllCache).toHaveBeenCalledTimes(1);
  });

  it('has no message when the failure carries none', async () => {
    api.processBatch.mockRejectedValue(new Error(''));
    const { result } = renderHook(() => useProcessStoredEmails());
    await act(async () => {
      await result.current.run([undefined]);
    });
    expect(result.current.state).toMatchObject({ status: 'failed', message: null });
  });

  it('refuses a second run while one is going', async () => {
    let release!: (value: unknown) => void;
    api.processBatch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const { result } = renderHook(() => useProcessStoredEmails());
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run([undefined]);
    });
    await act(async () => {
      await result.current.run([undefined]);
    });
    expect(api.processBatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(answer());
      await first;
    });
  });

  it('dismiss returns to idle', async () => {
    api.processBatch.mockResolvedValue(answer());
    const { result } = renderHook(() => useProcessStoredEmails());
    await act(async () => {
      await result.current.run([undefined]);
    });
    act(() => result.current.dismiss());
    expect(result.current.state.status).toBe('idle');
  });

  it('writes nothing to state after the page was left', async () => {
    let release!: (value: unknown) => void;
    api.processBatch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const { result, unmount } = renderHook(() => useProcessStoredEmails());
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run([undefined]);
    });
    unmount();
    release(answer({ remaining: 9 }));
    await run;
    // The loop stopped after the call in flight.
    expect(api.processBatch).toHaveBeenCalledTimes(1);
  });
});
