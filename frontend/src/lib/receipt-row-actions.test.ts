import { describe, it, expect } from 'vitest';
import { leadActionKey, orderActionsForCard } from './receipt-row-actions';
import { EMAIL_RECEIPT_STATUSES } from '@/types/email-receipts';

describe('leadActionKey', () => {
  it.each([
    ['review', 'approve'],
    ['no_parser', 'draftParser'],
    ['unmatched', 'link'],
    ['ambiguous', 'link'],
    ['pending', 'reprocess'],
    ['ignored', 'view'],
    ['component', 'view'],
  ] as const)('leads the %s card with %s', (status, lead) => {
    expect(leadActionKey(status, { status: 'pending' })).toBe(lead);
  });

  it('knows a lead for every state', () => {
    for (const status of EMAIL_RECEIPT_STATUSES) expect(leadActionKey(status, { status })).toBeTruthy();
  });

  it('leads the all-emails card by the email\'s own state', () => {
    expect(leadActionKey('all', { status: 'review' })).toBe('approve');
    expect(leadActionKey('all', { status: 'unmatched' })).toBe('link');
  });
});

describe('orderActionsForCard', () => {
  const actions = [{ key: 'view' }, { key: 'approve' }, { key: 'delete' }];

  it('moves the lead first and keeps the rest in order', () => {
    expect(orderActionsForCard(actions, 'approve').map((a) => a.key)).toEqual(['approve', 'view', 'delete']);
  });

  it('changes nothing when the lead is not among the actions', () => {
    expect(orderActionsForCard(actions, 'link')).toEqual(actions);
  });

  it('does not mutate its input', () => {
    orderActionsForCard(actions, 'delete');
    expect(actions.map((a) => a.key)).toEqual(['view', 'approve', 'delete']);
  });
});
