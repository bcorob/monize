import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act, waitFor } from '@/test/render';
import { attachmentsApi } from '@/lib/attachments';
import {
  previewSourceKey,
  useAttachmentBytes,
  type PreviewSource,
} from './useAttachmentBytes';

vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  attachmentsApi: { fetchBytes: vi.fn() },
}));

const fetchBytes = attachmentsApi.fetchBytes as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer;

/**
 * What axios throws for the server's "I cannot reach that backend" answer: 503
 * with the code, and the body as bytes because the request asked for an
 * arraybuffer.
 */
const unreachableStoreError = () =>
  Object.assign(new Error('unreachable'), {
    isAxiosError: true,
    response: {
      status: 503,
      data: new TextEncoder().encode(
        JSON.stringify({
          message: 'held in the "s3" storage backend',
          code: 'ATTACHMENT_STORE_UNREACHABLE',
        }),
      ).buffer,
    },
  });
const saved = (id: string): PreviewSource => ({ kind: 'saved', id });

describe('useAttachmentBytes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null while nothing is being previewed, and asks for nothing', () => {
    const { result } = renderHook(() => useAttachmentBytes(null));
    expect(result.current).toBeNull();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('loads a saved attachment and reports its bytes and type', async () => {
    const request = deferred<{ bytes: ArrayBuffer; contentType: string }>();
    fetchBytes.mockReturnValue(request.promise);
    const { result } = renderHook(() => useAttachmentBytes(saved('a-1')));
    expect(result.current).toEqual({ status: 'loading' });
    expect(fetchBytes).toHaveBeenCalledWith('a-1', expect.any(AbortSignal));

    await act(async () => {
      request.resolve({ bytes: bytesOf('png'), contentType: 'image/png' });
    });
    expect(result.current).toMatchObject({ status: 'ready', contentType: 'image/png' });
  });

  it('adopts only the answer to the source on screen', async () => {
    const first = deferred<{ bytes: ArrayBuffer; contentType: string }>();
    const second = deferred<{ bytes: ArrayBuffer; contentType: string }>();
    fetchBytes.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ source }: { source: PreviewSource }) => useAttachmentBytes(source),
      { initialProps: { source: saved('enhanced') } },
    );
    rerender({ source: saved('original') });
    // The switch shows loading on the render it happens.
    expect(result.current).toEqual({ status: 'loading' });

    await act(async () => {
      second.resolve({ bytes: bytesOf('orig'), contentType: 'image/jpeg' });
    });
    expect(result.current).toMatchObject({ status: 'ready', contentType: 'image/jpeg' });

    // The slower first answer arrives late and is dropped.
    await act(async () => {
      first.resolve({ bytes: bytesOf('enh'), contentType: 'image/png' });
    });
    expect(result.current).toMatchObject({ status: 'ready', contentType: 'image/jpeg' });
  });

  it('aborts the request a source change abandons', () => {
    fetchBytes.mockReturnValue(new Promise(() => {}));
    const { rerender } = renderHook(
      ({ source }: { source: PreviewSource | null }) => useAttachmentBytes(source),
      { initialProps: { source: saved('a-1') as PreviewSource | null } },
    );
    const signal = fetchBytes.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    rerender({ source: null });
    expect(signal.aborted).toBe(true);
  });

  it('reports a failed read as an error, never as an empty result', async () => {
    const request = deferred<{ bytes: ArrayBuffer; contentType: string }>();
    fetchBytes.mockReturnValue(request.promise);
    const { result } = renderHook(() => useAttachmentBytes(saved('a-1')));
    await act(async () => {
      request.reject(new Error('boom'));
    });
    expect(result.current).toEqual({ status: 'error', storeUnreachable: false });
  });

  it('distinguishes a backend this deployment cannot reach', async () => {
    // The server answers 503 naming the backend when a row's bytes are in a
    // storage provider it is not configured for -- a provider switch whose old
    // backend went away. Nothing is lost, and downloading fails the same way, so
    // the reader needs a different message from a generic failure.
    const request = deferred<{ bytes: ArrayBuffer; contentType: string }>();
    fetchBytes.mockReturnValue(request.promise);
    const { result } = renderHook(() => useAttachmentBytes(saved('a-1')));
    await act(async () => {
      request.reject(unreachableStoreError());
    });
    expect(result.current).toEqual({ status: 'error', storeUnreachable: true });
  });

  it('does not read a bare 503 as an unreachable backend', async () => {
    // A reverse proxy answers 503 while the backend restarts. Nothing is wrong
    // with this attachment's storage, so the reader must not be told there is.
    const request = deferred<{ bytes: ArrayBuffer; contentType: string }>();
    fetchBytes.mockReturnValue(request.promise);
    const { result } = renderHook(() => useAttachmentBytes(saved('a-1')));
    await act(async () => {
      request.reject(
        Object.assign(new Error('bad gateway'), {
          isAxiosError: true,
          response: { status: 503, data: '<html>503</html>' },
        }),
      );
    });
    expect(result.current).toEqual({ status: 'error', storeUnreachable: false });
  });

  it('does not read a plain 404 as an unreachable backend', async () => {
    const request = deferred<{ bytes: ArrayBuffer; contentType: string }>();
    fetchBytes.mockReturnValue(request.promise);
    const { result } = renderHook(() => useAttachmentBytes(saved('a-1')));
    await act(async () => {
      request.reject(
        Object.assign(new Error('gone'), {
          isAxiosError: true,
          response: { status: 404 },
        }),
      );
    });
    expect(result.current).toEqual({ status: 'error', storeUnreachable: false });
  });

  it('reads a staged file from the file itself', async () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const { result } = renderHook(() =>
      useAttachmentBytes({ kind: 'file', file }),
    );
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: 'ready', contentType: 'text/plain' }),
    );
    expect(fetchBytes).not.toHaveBeenCalled();
    const ready = result.current as { bytes: ArrayBuffer };
    expect(new TextDecoder().decode(ready.bytes)).toBe('hello');
  });

  it('tells two staged files apart by identity, not by their fields', () => {
    const a = new File(['x'], 'same.jpg', { type: 'image/jpeg' });
    const b = new File(['x'], 'same.jpg', { type: 'image/jpeg' });
    expect(previewSourceKey({ kind: 'file', file: a })).not.toBe(
      previewSourceKey({ kind: 'file', file: b }),
    );
    expect(previewSourceKey({ kind: 'file', file: a })).toBe(
      previewSourceKey({ kind: 'file', file: a }),
    );
  });

  it('still loads under StrictMode, whose first request is abandoned', async () => {
    fetchBytes.mockImplementation((_id: string, signal: AbortSignal) =>
      signal.aborted
        ? Promise.reject(new DOMException('aborted', 'AbortError'))
        : Promise.resolve({ bytes: bytesOf('png'), contentType: 'image/png' }),
    );
    const { result } = renderHook(() => useAttachmentBytes(saved('a-1')), {
      wrapper: StrictMode,
    });
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: 'ready' }),
    );
  });
});
