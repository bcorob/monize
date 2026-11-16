import { beforeEach, describe, expect, it, vi } from 'vitest';
import { profileActionCounts, sweepProfileEmails } from './email-receipts-profile-batch';
import { emailReceiptsApi } from '@/lib/email-receipts-api';

vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: { receipts: { profileBatch: vi.fn() } },
}));

const profileBatch = vi.mocked(emailReceiptsApi.receipts.profileBatch);
const page = (over: Partial<Awaited<ReturnType<typeof profileBatch>>> = {}) => ({
  matched: 0,
  applied: 0,
  unreadable: 0,
  ignored: 0,
  done: 0,
  next: null,
  ...over,
});

describe('sweepProfileEmails', () => {
  beforeEach(() => profileBatch.mockReset());

  it('follows the cursor until it is null and sums every page', async () => {
    profileBatch
      .mockResolvedValueOnce(page({ matched: 3, applied: 1, done: 2, next: 'id-100' }))
      .mockResolvedValueOnce(page({ matched: 2, ignored: 1, unreadable: 1, done: 0 }));
    await expect(sweepProfileEmails('p1', 'ignore')).resolves.toEqual({
      matched: 5,
      applied: 1,
      unreadable: 1,
      ignored: 1,
      done: 2,
    });
    expect(profileBatch.mock.calls).toEqual([
      [{ parserId: 'p1', action: 'ignore' }],
      [{ parserId: 'p1', action: 'ignore', after: 'id-100' }],
    ]);
  });

  it('stops at the first failure and passes it on', async () => {
    profileBatch.mockResolvedValueOnce(page({ next: 'x' })).mockRejectedValueOnce(new Error('boom'));
    await expect(sweepProfileEmails('p1', 'count')).rejects.toThrow('boom');
  });
});

describe('profileActionCounts', () => {
  const totals = { matched: 10, applied: 2, unreadable: 1, ignored: 3, done: 0 };

  it('deletes every matched email but the applied ones', () => {
    expect(profileActionCounts(totals, 'delete')).toEqual({ acts: 8, kept: 2 });
  });

  it('ignores neither applied nor unreadable emails, and has nothing to do for ignored ones', () => {
    expect(profileActionCounts(totals, 'ignore')).toEqual({ acts: 4, kept: 3 });
  });
});
