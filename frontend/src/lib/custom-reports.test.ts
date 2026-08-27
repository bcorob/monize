import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { customReportsApi } from './custom-reports';
import { invalidateCache } from './apiCache';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe('customReportsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCache('reports:');
  });

  it('create posts to /reports/custom', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { id: 'r-1' } });
    const result = await customReportsApi.create({ name: 'My Report' } as any);
    expect(apiClient.post).toHaveBeenCalledWith('/reports/custom', { name: 'My Report' });
    expect(result.id).toBe('r-1');
  });

  it('getAll fetches /reports/custom', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'r-1' }] });
    const result = await customReportsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledWith('/reports/custom');
    expect(result).toHaveLength(1);
  });

  it('getById fetches /reports/custom/:id', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { id: 'r-1' } });
    await customReportsApi.getById('r-1');
    expect(apiClient.get).toHaveBeenCalledWith('/reports/custom/r-1');
  });

  it('update patches /reports/custom/:id', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'r-1' } });
    await customReportsApi.update('r-1', { name: 'Updated' } as any);
    expect(apiClient.patch).toHaveBeenCalledWith('/reports/custom/r-1', { name: 'Updated' });
  });

  it('delete calls DELETE /reports/custom/:id', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({});
    await customReportsApi.delete('r-1');
    expect(apiClient.delete).toHaveBeenCalledWith('/reports/custom/r-1');
  });

  it('execute posts to /reports/custom/:id/execute', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { rows: [] } });
    await customReportsApi.execute('r-1', { startDate: '2025-01-01' });
    expect(apiClient.post).toHaveBeenCalledWith('/reports/custom/r-1/execute', { startDate: '2025-01-01' });
  });

  it('execute sends empty object when no params', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { rows: [] } });
    await customReportsApi.execute('r-1');
    expect(apiClient.post).toHaveBeenCalledWith('/reports/custom/r-1/execute', {});
  });

  it('toggleFavourite patches isFavourite', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { id: 'r-1', isFavourite: true } });
    const result = await customReportsApi.toggleFavourite('r-1', true);
    expect(apiClient.patch).toHaveBeenCalledWith('/reports/custom/r-1', { isFavourite: true });
    expect(result.isFavourite).toBe(true);
  });

  it('getAll returns cached result on second call without hitting the API', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'r-1', name: 'My Report' }] });
    const first = await customReportsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    const second = await customReportsApi.getAll();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  // Issue #1224 requirement 3: a favourite change is reflected in the switcher's
  // order immediately -- even for the report the user starred and then navigated
  // straight to, while the PATCH is still on the wire. The switcher reads getAll
  // through the shared cache, so the toggle must patch that cache up front.
  it('reflects a favourite toggle in the cache before the request settles', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [
        { id: 'r-1', name: 'A', isFavourite: false },
        { id: 'r-2', name: 'B', isFavourite: false },
      ],
    });
    await customReportsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    // Hold the PATCH open to observe the in-flight window.
    let resolvePatch!: (value: unknown) => void;
    vi.mocked(apiClient.patch).mockReturnValue(
      new Promise((resolve) => {
        resolvePatch = resolve;
      }) as never,
    );
    const toggle = customReportsApi.toggleFavourite('r-1', true);

    // A read racing the in-flight toggle sees the new favourite, from cache,
    // without a fresh request.
    vi.mocked(apiClient.get).mockClear();
    const midFlight = await customReportsApi.getAll();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(midFlight.find((r) => r.id === 'r-1')?.isFavourite).toBe(true);
    expect(midFlight.find((r) => r.id === 'r-2')?.isFavourite).toBe(false);

    // Once the server answers, the optimistic copy is dropped: the next read
    // reconciles against the server.
    resolvePatch({ data: { id: 'r-1', isFavourite: true } });
    await toggle;
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [{ id: 'r-1', isFavourite: true }],
    });
    await customReportsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('drops the optimistic favourite and rethrows when the toggle fails', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [{ id: 'r-1', name: 'A', isFavourite: false }],
    });
    await customReportsApi.getAll();

    vi.mocked(apiClient.patch).mockRejectedValue(new Error('boom'));
    await expect(customReportsApi.toggleFavourite('r-1', true)).rejects.toThrow('boom');

    // The optimistic value is gone: the next read refetches server truth.
    vi.mocked(apiClient.get).mockClear();
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [{ id: 'r-1', isFavourite: false }],
    });
    const after = await customReportsApi.getAll();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(after.find((r) => r.id === 'r-1')?.isFavourite).toBe(false);
  });
});
