import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { mnyImportApi } from './import-mny';
import { setCache, getCached, clearAllCache } from './apiCache';

vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockedClient = vi.mocked(apiClient);

/**
 * The timeouts, mostly.
 *
 * The shared axios client allows 10 s, which fits none of these calls: parsing
 * a 200 MB Money file takes minutes, starting an import can carry a whole
 * delete-my-data operation, and a poll that hangs for 10 s makes the progress
 * bar look broken. Each override is a single argument that is easy to omit and
 * impossible to notice -- `start` shipped without one -- so each is asserted.
 */
describe('mnyImportApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedClient.post.mockResolvedValue({ data: {} } as never);
    mockedClient.get.mockResolvedValue({ data: {} } as never);
    mockedClient.delete.mockResolvedValue({ data: {} } as never);
  });

  describe('parse', () => {
    it('uploads the file as multipart with a timeout that fits a 200 MB file', async () => {
      const file = new File(['bytes'], 'finances.mny');

      await mnyImportApi.parse(file);

      const [url, body, config] = mockedClient.post.mock.calls[0];
      expect(url).toBe('/import/mny/parse');
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get('file')).toBe(file);
      expect(config?.headers?.['Content-Type']).toBe('multipart/form-data');
      expect(config?.timeout).toBeGreaterThanOrEqual(300_000);
    });

    it('sends the password only when there is one', async () => {
      const file = new File(['bytes'], 'finances.mny');

      await mnyImportApi.parse(file);
      expect(
        (mockedClient.post.mock.calls[0][1] as FormData).has('password'),
      ).toBe(false);

      await mnyImportApi.parse(file, 'hunter2');
      expect(
        (mockedClient.post.mock.calls[1][1] as FormData).get('password'),
      ).toBe('hunter2');
    });
  });

  describe('start', () => {
    it('allows far longer than the shared default, because the wipe runs inside it', async () => {
      // The regression: `start` was the one call with no override, so a
      // "start fresh" import of a populated profile aborted client-side at
      // 10 s while the server carried on wiping and importing.
      await mnyImportApi.start('staged-1');

      const [url, , config] = mockedClient.post.mock.calls[0];
      expect(url).toBe('/import/mny/start');
      expect(config?.timeout).toBeGreaterThan(10_000);
    });

    it('omits the wipe credentials when there are none', async () => {
      await mnyImportApi.start('staged-1', { importPrices: false });

      expect(mockedClient.post.mock.calls[0][1]).toEqual({
        stagedFileId: 'staged-1',
        options: { importPrices: false },
      });
    });

    it('forwards the wipe password when one was collected', async () => {
      await mnyImportApi.start('staged-1', undefined, { password: 'hunter2' });

      expect(mockedClient.post.mock.calls[0][1]).toMatchObject({
        wipePassword: 'hunter2',
      });
    });
  });

  describe('getJob', () => {
    it('polls with a short timeout, so a stuck poll does not freeze the bar', async () => {
      await mnyImportApi.getJob('job-1');

      const [url, config] = mockedClient.get.mock.calls[0];
      expect(url).toBe('/import/mny/jobs/job-1');
      expect(config?.timeout).toBeLessThanOrEqual(10_000);
    });
  });
});

describe('mnyImportApi.getJob cache scope (INV-CACHE-001)', () => {
  const KEYS = ['categories:all', 'payees:all', 'tags:all', 'scheduled:all'];

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCache();
    for (const key of KEYS) setCache(key, [{ id: key }]);
  });

  it.each(['completed', 'failed'])('a %s job drops the reference-data caches', async (status) => {
    mockedClient.get.mockResolvedValue({ data: { status } } as never);
    await mnyImportApi.getJob('job-1');
    for (const key of KEYS) expect(getCached(key)).toBeUndefined();
  });

  it('a running job leaves the caches', async () => {
    mockedClient.get.mockResolvedValue({ data: { status: 'running' } } as never);
    await mnyImportApi.getJob('job-1');
    for (const key of KEYS) expect(getCached(key)).toEqual([{ id: key }]);
  });
});
