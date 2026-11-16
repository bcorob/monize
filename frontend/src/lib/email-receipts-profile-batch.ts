import { emailReceiptsApi } from '@/lib/email-receipts-api';
import type { ProfileBatchAction, ProfileBatchResult } from '@/types/email-receipts';

/** A profile's bulk action summed over every page of its scan. */
export type ProfileEmailTotals = Omit<ProfileBatchResult, 'next'>;

const EMPTY: ProfileEmailTotals = { matched: 0, applied: 0, unreadable: 0, ignored: 0, done: 0 };

/**
 * Run `POST /email-receipts/profile-batch` over every page of the profile's
 * emails: each answer's `next` is sent back as `after` until it is null, so
 * every email is looked at once. `count` writes nothing; `ignore` and `delete`
 * act on the emails the server says the profile matches.
 */
export async function sweepProfileEmails(parserId: string, action: ProfileBatchAction): Promise<ProfileEmailTotals> {
  let totals = EMPTY;
  let after: string | undefined;
  for (;;) {
    const page = await emailReceiptsApi.receipts.profileBatch({ parserId, action, ...(after ? { after } : {}) });
    totals = {
      matched: totals.matched + page.matched,
      applied: totals.applied + page.applied,
      unreadable: totals.unreadable + page.unreadable,
      ignored: totals.ignored + page.ignored,
      done: totals.done + page.done,
    };
    if (page.next === null) return totals;
    after = page.next;
  }
}

/**
 * From a count: how many emails the action would ignore or delete, and how many
 * it keeps as they are. Both keep an email whose proposal was applied;
 * `ignore` also keeps one that could not be read, and has nothing to do for
 * one already ignored.
 */
export function profileActionCounts(
  totals: ProfileEmailTotals,
  action: Exclude<ProfileBatchAction, 'count'>,
): { acts: number; kept: number } {
  if (action === 'delete') return { acts: totals.matched - totals.applied, kept: totals.applied };
  const kept = totals.applied + totals.unreadable;
  return { acts: totals.matched - kept - totals.ignored, kept };
}
