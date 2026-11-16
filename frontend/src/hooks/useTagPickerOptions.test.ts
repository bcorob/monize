import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@/test/render';
import { useTagPickerOptions } from './useTagPickerOptions';
import type { Tag } from '@/types/tag';

vi.mock('@/lib/tags', () => ({
  tagsApi: { getUsage: vi.fn() },
}));

import { tagsApi } from '@/lib/tags';

const getUsage = tagsApi.getUsage as unknown as ReturnType<typeof vi.fn>;

const tag = (id: string, name: string): Tag => ({
  id,
  userId: 'user-1',
  name,
  color: null,
  icon: null,
  createdAt: '',
  updatedAt: '',
});

const TAGS = [tag('art', 'Art'), tag('h26', 'Holiday 2026')];
const labels = (options: { label: string }[]) => options.map((o) => o.label);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useTagPickerOptions', () => {
  it('is A-Z until usage answers, then recent-first', async () => {
    const usage = { h26: { lastUsed: '2026-10-01', count: 1 } };
    getUsage.mockResolvedValue(usage);

    const { result } = renderHook(() => useTagPickerOptions(TAGS));
    expect(labels(result.current.tagOptions)).toEqual(['Art', 'Holiday 2026']);

    await waitFor(() => expect(labels(result.current.tagOptions)).toEqual(['Holiday 2026', 'Art']));
    expect(result.current.tagUsage).toEqual(usage);
  });

  it('does not ask for usage while disabled, and asks once enabled', async () => {
    getUsage.mockResolvedValue({});

    const { rerender } = renderHook(({ enabled }) => useTagPickerOptions(TAGS, enabled), {
      initialProps: { enabled: false },
    });
    await act(async () => {});
    expect(getUsage).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(getUsage).toHaveBeenCalledTimes(1));
  });

  it('logs a failed lookup and stays A-Z', async () => {
    const consoleError = vi.spyOn(console, 'error');
    getUsage.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useTagPickerOptions(TAGS));

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        '[TagPickerOptions]',
        expect.stringContaining('Tag usage lookup failed'),
        expect.any(Error),
      ),
    );
    expect(labels(result.current.tagOptions)).toEqual(['Art', 'Holiday 2026']);
    consoleError.mockRestore();
  });
});
