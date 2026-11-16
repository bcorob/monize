import { describe, it, expect } from 'vitest';
import {
  countConditionLeaves,
  ruleInvalidReasonKeys,
  ruleSummaryValues,
  ruleTriggerKind,
} from './rule-summary';
import type { TransactionRule } from '@/types/transaction-rule';

const leaf = { field: 'referenceNumber', op: 'contains', value: 'x' };

describe('ruleTriggerKind', () => {
  it('reads each combination', () => {
    expect(ruleTriggerKind(['create'])).toBe('create');
    expect(ruleTriggerKind(['import'])).toBe('import');
    expect(ruleTriggerKind(['import', 'create'])).toBe('both');
    expect(ruleTriggerKind([])).toBe('none');
    expect(ruleTriggerKind(undefined)).toBe('none');
  });
});

describe('countConditionLeaves', () => {
  it('counts leaves through nested groups', () => {
    expect(countConditionLeaves({ all: [leaf, { any: [leaf, leaf], not: true }] })).toBe(3);
  });

  it('counts a bare leaf', () => {
    expect(countConditionLeaves(leaf)).toBe(1);
  });

  it('reads an unreadable stored definition as none', () => {
    expect(countConditionLeaves({})).toBe(0);
    expect(countConditionLeaves(null)).toBe(0);
    expect(countConditionLeaves([leaf])).toBe(0);
    expect(countConditionLeaves({ all: 'x' })).toBe(0);
  });
});

describe('ruleSummaryValues', () => {
  it('does not throw on the shape a restore leaves', () => {
    const broken = { triggers: [], condition: {}, actions: {} } as unknown as TransactionRule;
    expect(ruleSummaryValues(broken)).toEqual({ trigger: 'none', conditions: 0, actions: 0 });
  });

  it('counts actions', () => {
    const rule = {
      triggers: ['create'],
      condition: { all: [leaf] },
      actions: [{ type: 'add_tags' }, { type: 'set_payee' }],
    } as unknown as TransactionRule;
    expect(ruleSummaryValues(rule)).toEqual({ trigger: 'create', conditions: 1, actions: 2 });
  });
});

describe('ruleInvalidReasonKeys', () => {
  it('maps codes to catalog keys once each', () => {
    const rule = {
      invalidReasons: [
        { path: 'actions[0]', code: 'REFERENCE_NOT_FOUND' },
        { path: 'condition', code: 'MAX_DEPTH' },
        { path: 'condition', code: 'MAX_NODES' },
        { path: 'condition.all[0]', code: 'VALUE_TYPE' },
      ],
    } as unknown as TransactionRule;
    expect(ruleInvalidReasonKeys(rule)).toEqual(['referenceMissing', 'tooLarge', 'other']);
  });

  it('falls back to an empty list when the reasons are missing', () => {
    expect(ruleInvalidReasonKeys({} as unknown as TransactionRule)).toEqual([]);
  });
});
