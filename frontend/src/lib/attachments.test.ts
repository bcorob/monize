import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import {
  ATTACHMENT_STORE_UNREACHABLE_CODE,
  isStoreUnreachable,
} from './attachments';
import { attachmentsApi, ATTACHMENT_BYTES_TIMEOUT_MS } from './attachments';
import { invalidateCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('./apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./apiCache')>()),
  invalidateCache: vi.fn(),
}));

const mockGet = apiClient.get as ReturnType<typeof vi.fn>;
const mockPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockDelete = apiClient.delete as ReturnType<typeof vi.fn>;
const mockInvalidate = invalidateCache as ReturnType<typeof vi.fn>;

/** The multipart body a call posted, as name -> value pairs. */
function postedFields(callIndex = 0): Array<[string, FormDataEntryValue]> {
  const body = mockPost.mock.calls[callIndex][1] as FormData;
  return Array.from(body.entries());
}

describe('attachmentsApi.list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a transaction's attachments from the transaction route", async () => {
    mockGet.mockResolvedValue({ data: [] });
    await attachmentsApi.list({ transactionId: 'tx-1' });
    expect(mockGet).toHaveBeenCalledWith('/transactions/tx-1/attachments');
  });

  it("reads a warranty's documents from the warranty route", async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'a-1' }] });
    const result = await attachmentsApi.list({ warrantyId: 'w-1' });
    expect(mockGet).toHaveBeenCalledWith('/warranties/w-1/attachments');
    expect(result).toEqual([{ id: 'a-1' }]);
  });
});

describe('attachmentsApi.upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ data: { id: 'a-1' } });
  });

  const file = new File(['x'], 'receipt.png', { type: 'image/png' });
  const original = new File(['y'], 'photo.jpg', { type: 'image/jpeg' });

  it('posts a transaction attachment with no document kind, even when one is passed', async () => {
    await attachmentsApi.upload({ transactionId: 'tx-1' }, file, original, 'receipt');

    expect(mockPost.mock.calls[0][0]).toBe('/transactions/tx-1/attachments');
    expect(postedFields().map(([name]) => name)).toEqual(['file', 'original']);
    expect(mockInvalidate).toHaveBeenCalledWith('attachments:');
    expect(mockInvalidate).not.toHaveBeenCalledWith('warranties:');
  });

  it('posts a warranty document with its kind and drops the cached warranty views', async () => {
    const result = await attachmentsApi.upload({ warrantyId: 'w-1' }, file, undefined, 'manual');

    expect(mockPost.mock.calls[0][0]).toBe('/warranties/w-1/attachments');
    expect(postedFields()).toEqual([
      ['file', expect.any(File)],
      ['documentKind', 'manual'],
    ]);
    expect(mockInvalidate).toHaveBeenCalledWith('attachments:');
    expect(mockInvalidate).toHaveBeenCalledWith('warranties:');
    expect(result).toEqual({ id: 'a-1' });
  });

  it('leaves the kind to the server default when none is chosen', async () => {
    await attachmentsApi.upload({ warrantyId: 'w-1' }, file);
    expect(postedFields().map(([name]) => name)).toEqual(['file']);
  });
});

describe('attachmentsApi.delete', () => {
  it('drops the attachment and warranty caches, since the parent may be either', async () => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue({});
    await attachmentsApi.delete('a-1');
    expect(mockDelete).toHaveBeenCalledWith('/attachments/a-1');
    expect(mockInvalidate).toHaveBeenCalledWith('attachments:');
    expect(mockInvalidate).toHaveBeenCalledWith('warranties:');
  });
});

describe('attachmentsApi.updateDocumentKind', () => {
  it('patches the kind by id and drops the attachment and warranty caches', async () => {
    vi.clearAllMocks();
    mockPatch.mockResolvedValue({ data: { id: 'a-1', documentKind: 'manual' } });
    const result = await attachmentsApi.updateDocumentKind('a-1', 'manual');
    expect(mockPatch).toHaveBeenCalledWith('/attachments/a-1', { documentKind: 'manual' });
    expect(result).toEqual({ id: 'a-1', documentKind: 'manual' });
    expect(mockInvalidate).toHaveBeenCalledWith('attachments:');
    expect(mockInvalidate).toHaveBeenCalledWith('warranties:');
  });
});

describe('attachmentsApi.fetchBytes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the bytes as an array buffer with a long timeout and the caller signal', async () => {
    const bytes = new Uint8Array([1, 2]).buffer;
    mockGet.mockResolvedValue({
      data: bytes,
      headers: { 'content-type': 'image/png' },
    });
    const controller = new AbortController();

    const result = await attachmentsApi.fetchBytes('a-1', controller.signal);

    expect(mockGet).toHaveBeenCalledWith('/attachments/a-1/download', {
      responseType: 'arraybuffer',
      timeout: ATTACHMENT_BYTES_TIMEOUT_MS,
      signal: controller.signal,
    });
    expect(ATTACHMENT_BYTES_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(result).toEqual({ bytes, contentType: 'image/png' });
  });

  it('takes the type from the server, without its parameters', async () => {
    mockGet.mockResolvedValue({
      data: new ArrayBuffer(0),
      headers: { 'content-type': 'application/pdf; charset=binary' },
    });
    const result = await attachmentsApi.fetchBytes('a-1');
    expect(result.contentType).toBe('application/pdf');
  });

  it('falls back to an opaque type when the server sends none', async () => {
    mockGet.mockResolvedValue({ data: new ArrayBuffer(0), headers: {} });
    const result = await attachmentsApi.fetchBytes('a-1');
    expect(result.contentType).toBe('application/octet-stream');
  });
});

describe('isStoreUnreachable', () => {
  const refusal = (data: unknown, status = 503) =>
    Object.assign(new Error('refused'), { isAxiosError: true, response: { status, data } });

  const coded = JSON.stringify({ code: ATTACHMENT_STORE_UNREACHABLE_CODE });

  it('recognises the coded refusal however axios handed the body over', () => {
    // The download asks for an arraybuffer, so the body of the refusal arrives as
    // bytes; other callers get it parsed. Both are the same answer.
    expect(isStoreUnreachable(refusal(new TextEncoder().encode(coded).buffer))).toBe(true);
    expect(isStoreUnreachable(refusal(new TextEncoder().encode(coded)))).toBe(true);
    expect(isStoreUnreachable(refusal(coded))).toBe(true);
    expect(isStoreUnreachable(refusal({ code: ATTACHMENT_STORE_UNREACHABLE_CODE }))).toBe(true);
  });

  it('does not claim it for a 503 that is not this refusal', () => {
    // A proxy answering 503 while the backend restarts, and the same code on a
    // different status: neither says this attachment's storage is unconfigured.
    expect(isStoreUnreachable(refusal('<html>503</html>'))).toBe(false);
    expect(isStoreUnreachable(refusal({ message: 'busy' }))).toBe(false);
    expect(isStoreUnreachable(refusal(undefined))).toBe(false);
    expect(isStoreUnreachable(refusal(coded, 500))).toBe(false);
    expect(isStoreUnreachable(new Error('offline'))).toBe(false);
  });
});
