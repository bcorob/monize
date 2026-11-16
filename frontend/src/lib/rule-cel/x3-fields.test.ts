import { describe, expect, it } from 'vitest';
import { parseCondition, printCondition } from '@/lib/rule-cel';
import { complete } from '@/lib/rule-cel';
import { INDEX, group, leaf, stripUids } from '@/test/rule-cel-support';

/** The fields of design 10.3 (X3) in the expression mode. */
const CASES: ReadonlyArray<readonly [string, ReturnType<typeof leaf>]> = [
  ['transaction.referenceNumber == "CHK-1"', leaf('referenceNumber', 'eq', 'CHK-1')],
  ['transaction.referenceNumber.startsWith("CHK")', leaf('referenceNumber', 'startsWith', 'CHK')],
  ['transaction.referenceNumber.matchesGlob("CHK-{n}")', leaf('referenceNumber', 'matches', 'CHK-{n}')],
  ['isEmpty(transaction.referenceNumber)', leaf('referenceNumber', 'isEmpty')],
  ['transaction.dayOfMonth == 1', leaf('dayOfMonth', 'eq', 1)],
  ['transaction.dayOfMonth >= 28', leaf('dayOfMonth', 'gte', 28)],
  ['transaction.dayOfMonth < 15', leaf('dayOfMonth', 'lt', 15)],
  ['transaction.dayOfMonth.between(10, 20)', leaf('dayOfMonth', 'between', [10, 20])],
  ['transaction.dayOfMonth in [1, 15, 31]', leaf('dayOfMonth', 'in', [1, 15, 31] as never)],
  ['transaction.weekday == "MON"', leaf('weekday', 'eq', 'MON')],
  ['transaction.weekday in ["SAT", "SUN"]', leaf('weekday', 'in', ['SAT', 'SUN'])],
  ['transaction.status != "VOID"', leaf('status', 'neq', 'VOID')],
  ['transaction.status in ["CLEARED", "RECONCILED"]', leaf('status', 'in', ['CLEARED', 'RECONCILED'])],
  ['transaction.hasAttachment == true', leaf('hasAttachment', 'eq', true)],
  ['transaction.hasAttachment == false', leaf('hasAttachment', 'eq', false)],
];

describe('expression mode: the X3 fields', () => {
  it.each(CASES)('prints and parses %s', (text, node) => {
    const tree = group('all', [node]);
    expect(printCondition(tree, INDEX)).toBe(text);
    const parsed = parseCondition(text, INDEX);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(stripUids(parsed.root)).toEqual(stripUids(tree));
  });

  it('refuses a weekday or status the field does not have, and a text where a day belongs', () => {
    for (const text of [
      'transaction.weekday == "MONDAY"',
      'transaction.status == "PENDING"',
      'transaction.dayOfMonth == "5"',
      'transaction.hasAttachment == "yes"',
      'transaction.weekday > "MON"',
    ]) {
      expect(parseCondition(text, INDEX).ok, text).toBe(false);
    }
  });

  it('suggests the field names and their values', () => {
    const fields = complete('transaction.', 12, INDEX);
    expect(fields?.items.map((i) => i.label)).toEqual(expect.arrayContaining(['dayOfMonth', 'weekday', 'status']));
    const weekdays = complete('transaction.weekday == "', 24, INDEX);
    expect(weekdays?.items.map((i) => i.label)).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
  });
});
