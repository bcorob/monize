import type { PendingAction, PendingActionRule, PendingActionRuleTest } from '@/types/ai';

/** The names the fixtures' ids resolve to; ids are opaque strings here. */
export const RULE_LABELS = {
  accounts: { 'acc-1': 'Checking', 'acc-2': 'Savings' },
  payees: { 'pay-1': 'Starbucks' },
  categories: { 'cat-1': 'Food: Coffee' },
  tags: { 'tag-1': 'coffee', 'tag-2': 'treat' },
};

export function makeRule(overrides: Partial<PendingActionRule> = {}): PendingActionRule {
  return {
    name: 'Tag coffee shops',
    enabled: true,
    triggers: ['create', 'import'],
    condition: {
      all: [
        { field: 'payeeText', op: 'contains', value: 'starbucks' },
        {
          any: [
            { field: 'accountId', op: 'eq', value: 'acc-1' },
            { field: 'absAmount', op: 'between', value: [2, 15.5] },
            { field: 'type', op: 'eq', value: 'EXPENSE' },
          ],
        },
        { field: 'tagIds', op: 'hasNone', value: ['tag-2'] },
      ],
    },
    actions: [
      { type: 'set_category', categoryId: 'cat-1', onlyIfEmpty: true },
      { type: 'set_payee', payeeId: 'pay-1', onlyIfEmpty: false },
      { type: 'add_tags', tagIds: ['tag-1', 'tag-2'] },
      { type: 'request_ai_review', instruction: 'Check the receipt' },
    ],
    stopProcessing: true,
    labels: RULE_LABELS,
    ...overrides,
  };
}

export function makeTest(overrides: Partial<PendingActionRuleTest> = {}): PendingActionRuleTest {
  return {
    matchedCount: 14,
    conditionMatchedCount: 14,
    scanned: 200,
    truncated: false,
    rows: [
      {
        transactionId: 'tx-1',
        date: '2026-01-15',
        payeeName: 'Starbucks 123',
        amount: -4.5,
        currencyCode: 'USD',
        changes: {
          categoryId: { before: null, after: 'cat-1' },
          tagIds: { before: [], after: ['tag-1'] },
        },
      },
      {
        transactionId: 'tx-2',
        date: '2026-01-16',
        payeeName: null,
        amount: -7,
        currencyCode: 'EUR',
        changes: { payeeId: { before: 'gone', after: 'pay-1' } },
      },
    ],
    skipped: [
      { transactionId: 'tx-3', reason: 'reconciled_locked' },
      { transactionId: 'tx-4', reason: 'split_category' },
    ],
    skippedCount: 5,
    aiReviewRequests: 3,
    labels: { categories: { 'cat-1': 'Food: Coffee' }, payees: { 'pay-1': 'Starbucks' }, tags: { 'tag-1': 'coffee' }, rules: {} },
    ...overrides,
  };
}

export function makeRuleAction(
  type: PendingAction['type'],
  rule: PendingActionRule | undefined,
  overrides: Partial<PendingAction> = {},
): PendingAction {
  return {
    actionId: 'r1',
    type,
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    signature: 'sig',
    descriptor: { type },
    preview: rule ? { rule } : {},
    ...overrides,
  };
}
