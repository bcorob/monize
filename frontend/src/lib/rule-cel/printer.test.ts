import { describe, expect, it } from 'vitest';
import { printCondition } from '@/lib/rule-cel';
import { CATALOG, INDEX, group, leaf } from '@/test/rule-cel-support';
import { EntityIndex } from '@/lib/rule-cel';

const print = (tree: ReturnType<typeof group>) => printCondition(tree, INDEX);

describe('printCondition', () => {
  it('prints the example rule of the design', () => {
    const tree = group('all', [
      leaf('type', 'eq', 'TRANSFER'),
      leaf('fromAccountId', 'eq', 'acc-2'),
      group('any', [leaf('payeeText', 'matches', '*BIEDRONKA*'), leaf('amount', 'between', [-500, -100])]),
    ]);
    expect(print(tree)).toBe(
      'transaction.type == "TRANSFER" && transaction.fromAccountId == account("RRSP") && (transaction.payeeText.matchesGlob("*BIEDRONKA*") || transaction.amount.between(-500, -100))',
    );
  });

  it.each([
    [leaf('referenceNumber', 'eq', 'a'), 'transaction.referenceNumber == "a"'],
    [leaf('amount', 'lt', 5), 'transaction.amount < 5'],
    [leaf('amount', 'lte', 5), 'transaction.amount <= 5'],
    [leaf('amount', 'gt', -5.5), 'transaction.amount > -5.5'],
    [leaf('amount', 'gte', 0), 'transaction.amount >= 0'],
    [leaf('accountId', 'neq', 'acc-2'), 'transaction.accountId != account("RRSP")'],
    [leaf('type', 'in', ['EXPENSE', 'INCOME']), 'transaction.type in ["EXPENSE", "INCOME"]'],
    [leaf('accountId', 'notIn', ['acc-2']), '!(transaction.accountId in [account("RRSP")])'],
    [leaf('referenceNumber', 'contains', 'x'), 'transaction.referenceNumber.contains("x")'],
    [leaf('referenceNumber', 'startsWith', 'x'), 'transaction.referenceNumber.startsWith("x")'],
    [leaf('referenceNumber', 'matches', 'x*'), 'transaction.referenceNumber.matchesGlob("x*")'],
    [leaf('absAmount', 'between', [1, 2]), 'transaction.absAmount.between(1, 2)'],
    [leaf('payeeId', 'isEmpty'), 'isEmpty(transaction.payeeId)'],
    [leaf('categoryId', 'inSubtree', 'cat-1'), 'transaction.categoryId.inSubtree(category("Food"))'],
    [leaf('tagIds', 'hasAny', ['tag-1', 'tag-2']), 'transaction.tagIds.hasAny([tag("Coffee run"), tag("Work")])'],
    [leaf('tagIds', 'hasAll', ['tag-1']), 'transaction.tagIds.hasAll([tag("Coffee run")])'],
    [leaf('tagIds', 'hasNone', []), 'transaction.tagIds.hasNone([])'],
    [leaf('hasSplits', 'eq', false), 'transaction.hasSplits == false'],
    [leaf('currencyCode', 'in', ['CAD', 'USD']), 'transaction.currencyCode in ["CAD", "USD"]'],
  ])('prints a lone condition bare: %#', (condition, expected) => {
    expect(print(group('all', [condition]))).toBe(expected);
  });

  it('prints a group by its size and kind', () => {
    const a = leaf('referenceNumber', 'eq', 'a');
    const b = leaf('referenceNumber', 'eq', 'b');
    expect(print(group('all'))).toBe('true');
    expect(print(group('any'))).toBe('false');
    expect(print(group('any', [a]))).toBe('any(transaction.referenceNumber == "a")');
    expect(print(group('all', [group('any', [a, b])]))).toBe(
      'all(transaction.referenceNumber == "a" || transaction.referenceNumber == "b")',
    );
    expect(print(group('any', [a, b]))).toBe('transaction.referenceNumber == "a" || transaction.referenceNumber == "b"');
  });

  it('parenthesises a group inside another, and keeps a negated one self-delimited', () => {
    const a = leaf('referenceNumber', 'eq', 'a');
    const b = leaf('referenceNumber', 'eq', 'b');
    expect(print(group('all', [a, group('all', [a, b])]))).toBe(
      'transaction.referenceNumber == "a" && (transaction.referenceNumber == "a" && transaction.referenceNumber == "b")',
    );
    expect(print(group('any', [a, group('any', [a, b], true)]))).toBe(
      'transaction.referenceNumber == "a" || !(transaction.referenceNumber == "a" || transaction.referenceNumber == "b")',
    );
    expect(print(group('all', [a, group('all')]))).toBe('transaction.referenceNumber == "a" && true');
  });

  it('prints a negated root and never a negated bare condition', () => {
    const a = leaf('referenceNumber', 'eq', 'a');
    const inLeaf = leaf('accountId', 'in', ['acc-2']);
    expect(print(group('all', [a], true))).toBe('!(all(transaction.referenceNumber == "a"))');
    expect(print(group('all', [inLeaf], true))).toBe('!(all(transaction.accountId in [account("RRSP")]))');
    expect(print(group('any', [a, a], true))).toBe('!(transaction.referenceNumber == "a" || transaction.referenceNumber == "a")');
    expect(print(group('all', [], true))).toBe('!(true)');
  });

  it('writes a root that holds a group, and a root of one negated group, unambiguously', () => {
    const a = leaf('referenceNumber', 'eq', 'a');
    expect(print(group('all', [group('all', [a, a])]))).toBe(
      'all(transaction.referenceNumber == "a" && transaction.referenceNumber == "a")',
    );
    expect(print(group('all', [group('all', [a, a], true)]))).toBe(
      'all(!(transaction.referenceNumber == "a" && transaction.referenceNumber == "a"))',
    );
  });

  it('never shows an id, and writes a shared name with its number', () => {
    const text = print(
      group('all', [leaf('accountId', 'eq', 'acc-3'), leaf('payeeId', 'in', ['pay-2', 'pay-4']), leaf('accountId', 'eq', 'acc-2')]),
    );
    expect(text).toBe(
      'transaction.accountId == account("Chequing", 2) && transaction.payeeId in [payee("Amazon", 1), payee("Amazon", 3)] && transaction.accountId == account("RRSP")',
    );
    expect(text).not.toMatch(/acc-|pay-/);
  });

  it('escapes quotes, backslashes and control characters', () => {
    expect(print(group('all', [leaf('accountId', 'eq', 'acc-4')]))).toBe('transaction.accountId == account("Say \\"hi\\" \\\\ there")');
    expect(print(group('all', [leaf('referenceNumber', 'eq', 'a\nb\t\u0001')]))).toBe('transaction.referenceNumber == "a\\nb\\t\\u0001"');
    expect(print(group('all', [leaf('referenceNumber', 'eq', 'a\rb\u007f')]))).toBe('transaction.referenceNumber == "a\\rb\\u007f"');
  });

  it('writes an item that no longer exists as missing(), the only place an id appears', () => {
    expect(print(group('all', [leaf('tagIds', 'hasAny', ['gone'])]))).toBe('transaction.tagIds.hasAny([missing("gone")])');
  });

  it('writes a value not chosen yet as an underscore', () => {
    expect(print(group('all', [leaf('amount', 'gt', undefined)]))).toBe('transaction.amount > _');
    expect(print(group('all', [leaf('amount', 'between', [undefined, 4])]))).toBe('transaction.amount.between(_, 4)');
    expect(print(group('all', [leaf('accountId', 'eq', '')]))).toBe('transaction.accountId == _');
    expect(print(group('all', [leaf('currencyCode', 'eq', '')]))).toBe('transaction.currencyCode == _');
    expect(print(group('all', [leaf('amount', 'eq', Number.NaN)]))).toBe('transaction.amount == _');
  });

  it('keeps the sign of zero and the exponent of a large number', () => {
    expect(print(group('all', [leaf('amount', 'eq', -0)]))).toBe('transaction.amount == -0');
    expect(print(group('all', [leaf('amount', 'eq', 1e21)]))).toBe('transaction.amount == 1e+21');
  });

  it('prints without a catalog: every reference is then missing()', () => {
    expect(printCondition(group('all', [leaf('accountId', 'eq', 'x')]))).toBe('transaction.accountId == missing("x")');
    expect(new EntityIndex(CATALOG).nameOf('account', 'acc-2')?.name).toBe('RRSP');
  });
});
