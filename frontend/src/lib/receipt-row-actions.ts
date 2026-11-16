import type { EmailReceiptListItem, EmailReceiptStatus } from '@/types/email-receipts';

/** The keys of the actions a stored email's row can offer. */
export type ReceiptActionKey =
  | 'view'
  | 'approve'
  | 'draftParser'
  | 'createParser'
  | 'link'
  | 'recognizeAi'
  | 'recognizeTradeAi'
  | 'reprocess'
  | 'ignore'
  | 'delete';

/**
 * The action a person comes to a state's card to do: a proposal in review is
 * approved, an email nothing read is turned into a profile, one without a
 * transaction is linked to one, one waiting is read now. The states with no
 * such action lead with View. Pure data so each card's lead action is pinned by a test.
 */
const LEAD_ACTION: Record<EmailReceiptStatus, ReceiptActionKey> = {
  pending: 'reprocess',
  skipped: 'view',
  no_parser: 'draftParser',
  parse_failed: 'reprocess',
  unmatched: 'link',
  ambiguous: 'link',
  review_conflict: 'view',
  review: 'approve',
  ignored: 'view',
  // Nothing to approve or link: it waits for the settlement that pays for it.
  component: 'view',
};

/**
 * The lead action of an email on the card being looked at: the card's own state
 * (`filter`), or for the all-emails card the email's own state.
 */
export function leadActionKey(
  filter: EmailReceiptStatus | 'all',
  receipt: Pick<EmailReceiptListItem, 'status'>,
): ReceiptActionKey {
  return LEAD_ACTION[filter === 'all' ? receipt.status : filter];
}

/** The actions with the card's lead action first (after nothing else moves), so the row's inline buttons start with it. */
export function orderActionsForCard<T extends { key: string }>(
  actions: readonly T[],
  lead: ReceiptActionKey,
): T[] {
  const first = actions.find((action) => action.key === lead);
  return first ? [first, ...actions.filter((action) => action !== first)] : [...actions];
}
