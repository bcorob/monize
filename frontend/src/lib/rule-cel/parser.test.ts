import { describe, expect, it } from 'vitest';
import { CEL_ERROR_KEYS, MAX_EXPRESSION_LENGTH, MAX_EXPRESSION_NESTING, lineColumn, parseCondition } from '@/lib/rule-cel';
import { INDEX, group, leaf, stripUids } from '@/test/rule-cel-support';
import type { EditorGroup } from '@/lib/rule-tree';

function parse(text: string): EditorGroup {
  const result = parseCondition(text, INDEX);
  if (!result.ok) throw new Error(`${result.error.key} at ${result.error.position}`);
  return result.root;
}
const shape = (text: string) => stripUids(parse(text));
const expected = (tree: EditorGroup) => stripUids(tree);

function refusal(text: string) {
  const result = parseCondition(text, INDEX);
  if (result.ok) throw new Error(`accepted: ${text}`);
  return result.error;
}

describe('parseCondition: accepted text', () => {
  it('reads the example rule of the design', () => {
    const text =
      'transaction.type == "TRANSFER" && transaction.fromAccountId == account("RRSP") && (transaction.payeeText.matchesGlob("*BIEDRONKA*") || transaction.amount.between(-500, -100))';
    expect(shape(text)).toEqual(
      expected(
        group('all', [
          leaf('type', 'eq', 'TRANSFER'),
          leaf('fromAccountId', 'eq', 'acc-2'),
          group('any', [leaf('payeeText', 'matches', '*BIEDRONKA*'), leaf('amount', 'between', [-500, -100])]),
        ]),
      ),
    );
  });

  it('reads an empty text as a root with no conditions, and true and false as empty groups', () => {
    expect(shape('')).toEqual(expected(group('all')));
    expect(shape('  \n ')).toEqual(expected(group('all')));
    expect(shape('true')).toEqual(expected(group('all')));
    expect(shape('false')).toEqual(expected(group('any')));
    expect(shape('transaction.referenceNumber == "a" && true')).toEqual(
      expected(group('all', [leaf('referenceNumber', 'eq', 'a'), group('all')])),
    );
  });

  it('binds && tighter than ||, as CEL does', () => {
    const a = leaf('referenceNumber', 'eq', 'a');
    const b = leaf('referenceNumber', 'eq', 'b');
    const c = leaf('referenceNumber', 'eq', 'c');
    const [x, y, z] = ['a', 'b', 'c'].map((v) => `transaction.referenceNumber == "${v}"`);
    expect(shape(`${x} || ${y} && ${z}`)).toEqual(expected(group('any', [a, group('all', [b, c])])));
    expect(shape(`${x} && ${y} || ${z}`)).toEqual(expected(group('any', [group('all', [a, b]), c])));
    expect(shape(`(${x} || ${y}) && ${z}`)).toEqual(expected(group('all', [group('any', [a, b]), c])));
  });

  it('keeps a chain flat and a parenthesised group nested', () => {
    const [x, y, z] = ['a', 'b', 'c'].map((v) => `transaction.referenceNumber == "${v}"`);
    const a = leaf('referenceNumber', 'eq', 'a');
    const b = leaf('referenceNumber', 'eq', 'b');
    const c = leaf('referenceNumber', 'eq', 'c');
    expect(shape(`${x} && ${y} && ${z}`)).toEqual(expected(group('all', [a, b, c])));
    expect(shape(`${x} && (${y} && ${z})`)).toEqual(expected(group('all', [a, group('all', [b, c])])));
    expect(shape(`(${x} && ${y}) && ${z}`)).toEqual(expected(group('all', [group('all', [a, b]), c])));
  });

  it('wraps a lone condition, or a parenthesised group, in a root all-group', () => {
    const a = leaf('referenceNumber', 'eq', 'a');
    expect(shape('transaction.referenceNumber == "a"')).toEqual(expected(group('all', [a])));
    expect(shape('(transaction.referenceNumber == "a")')).toEqual(expected(group('all', [a])));
    expect(shape('(transaction.referenceNumber == "a" || transaction.referenceNumber == "a")')).toEqual(
      expected(group('all', [group('any', [a, a])])),
    );
  });

  it('reads all(), any() and negation', () => {
    const a = leaf('referenceNumber', 'eq', 'a');
    expect(shape('any(transaction.referenceNumber == "a")')).toEqual(expected(group('any', [a])));
    expect(shape('all(all(transaction.referenceNumber == "a"))')).toEqual(expected(group('all', [group('all', [a])])));
    expect(shape('!(transaction.referenceNumber == "a" || transaction.referenceNumber == "a")')).toEqual(
      expected(group('any', [a, a], true)),
    );
    expect(shape('!(true)')).toEqual(expected(group('all', [], true)));
    expect(shape('!(all(transaction.referenceNumber == "a"))')).toEqual(expected(group('all', [a], true)));
    // Sugar: a negated condition is a negated group around it.
    expect(shape('!transaction.referenceNumber == "a"')).toEqual(expected(group('all', [a], true)));
    expect(shape('!(transaction.referenceNumber.contains("a"))')).toEqual(
      expected(group('all', [leaf('referenceNumber', 'contains', 'a')], true)),
    );
    // A double negation wraps instead of cancelling.
    expect(shape('!(!(transaction.referenceNumber == "a" || transaction.referenceNumber == "a"))')).toEqual(
      expected(group('all', [group('any', [a, a], true)], true)),
    );
  });

  it('reads !(x in [..]) as the operator "is none of"', () => {
    expect(shape('!(transaction.accountId in [account("RRSP")])')).toEqual(
      expected(group('all', [leaf('accountId', 'notIn', ['acc-2'])])),
    );
    expect(shape('transaction.referenceNumber == "a" && !(transaction.payeeId in [payee("Corner Cafe")])')).toEqual(
      expected(group('all', [leaf('referenceNumber', 'eq', 'a'), leaf('payeeId', 'notIn', ['pay-1'])])),
    );
  });

  it.each([
    ['transaction.amount < 5', leaf('amount', 'lt', 5)],
    ['transaction.amount <= 5.25', leaf('amount', 'lte', 5.25)],
    ['transaction.amount > - 5', leaf('amount', 'gt', -5)],
    ['transaction.amount >= 1e3', leaf('amount', 'gte', 1000)],
    ['transaction.amount == _', leaf('amount', 'eq', undefined)],
    ['transaction.amount.between(_, 4)', leaf('amount', 'between', [undefined, 4])],
    ["transaction.referenceNumber == 'single'", leaf('referenceNumber', 'eq', 'single')],
    ['transaction.referenceNumber == "\\u00e9\\n\\t\\r\\\\\\"\\\'"', leaf('referenceNumber', 'eq', 'é\n\t\r\\"\'')],
    ['transaction.type in ["EXPENSE"]', leaf('type', 'in', ['EXPENSE'])],
    ['transaction.type != "INCOME"', leaf('type', 'neq', 'INCOME')],
    ['transaction.currencyCode == "CAD"', leaf('currencyCode', 'eq', 'CAD')],
    ['transaction.currencyCode == _', leaf('currencyCode', 'eq', '')],
    ['transaction.hasSplits == true', leaf('hasSplits', 'eq', true)],
    ['isEmpty(transaction.toAccountId)', leaf('toAccountId', 'isEmpty')],
    ['transaction.categoryId.inSubtree(category("Food: Coffee"))', leaf('categoryId', 'inSubtree', 'cat-2')],
    ['transaction.tagIds.hasNone([tag("Work"), tag("Coffee run")])', leaf('tagIds', 'hasNone', ['tag-2', 'tag-1'])],
    ['transaction.payeeId == payee("Amazon", 2)', leaf('payeeId', 'eq', 'pay-3')],
    ['transaction.payeeId == payee("Corner Cafe", 1)', leaf('payeeId', 'eq', 'pay-1')],
    ['transaction.payeeId == payee("O\'Brien\'s")', leaf('payeeId', 'eq', 'pay-5')],
    ['transaction.tagIds.hasAny([missing("gone")])', leaf('tagIds', 'hasAny', ['gone'])],
    ['transaction.accountId == account("Say \\"hi\\" \\\\ there")', leaf('accountId', 'eq', 'acc-4')],
    ['transaction.tagIds.hasAny([tag("Line\\nbreak")])', leaf('tagIds', 'hasAny', ['tag-3'])],
    ['transaction.tagIds.hasAny([])', leaf('tagIds', 'hasAny', [])],
  ])('reads %s', (text, condition) => {
    expect(shape(text)).toEqual(expected(group('all', [condition])));
  });

  it('gives every node of a new tree its own uid', () => {
    const root = parse('transaction.referenceNumber == "a" && transaction.referenceNumber == "a"');
    const uids = new Set([root.uid, ...root.children.map((c) => c.uid)]);
    expect(uids.size).toBe(3);
  });
});

describe('parseCondition: refusals with their position', () => {
  /** The refusal's key and position; `where` is the text the error points at (its `nth` occurrence). */
  const at = (text: string, key: string, where: string, args?: Record<string, string | number>, nth = 0) => {
    const error = refusal(text);
    let position = -1;
    for (let i = 0; i <= nth; i += 1) position = text.indexOf(where, position + 1);
    expect({ key: error.key, position: error.position, ...(args ? { args: error.args } : {}) }).toEqual({
      key,
      position,
      ...(args ? { args } : {}),
    });
    return error;
  };

  it('refuses a character the language does not have', () => {
    at('transaction.referenceNumber == "a" # x', 'unexpectedChar', '#', { char: '#' });
    at('transaction.referenceNumber = "a"', 'unexpectedChar', '=', { char: '=' });
    at('a & b', 'unexpectedChar', '&', { char: '&' });
  });

  it('refuses broken strings and numbers', () => {
    at('transaction.referenceNumber == "abc', 'unterminatedString', '"abc');
    at('transaction.referenceNumber == "ab\ncd"', 'unterminatedString', '"ab');
    at('transaction.referenceNumber == "a\\qb"', 'invalidEscape', '\\q');
    at('transaction.referenceNumber == "a\\u12"', 'invalidEscape', '\\u12');
    at('transaction.amount > 12abc', 'badNumber', '12abc');
    at('transaction.amount > 1.5.2', 'badNumber', '1.5.2');
  });

  it('refuses text that is too long, and too deeply parenthesised', () => {
    const error = refusal(' '.repeat(MAX_EXPRESSION_LENGTH + 1));
    expect(error).toMatchObject({ key: 'tooLong', position: MAX_EXPRESSION_LENGTH, args: { max: MAX_EXPRESSION_LENGTH } });
    expect(parseCondition(' '.repeat(MAX_EXPRESSION_LENGTH), INDEX).ok).toBe(true);
    const nest = (n: number) => `${'('.repeat(n)}transaction.referenceNumber == "a"${')'.repeat(n)}`;
    expect(parseCondition(nest(MAX_EXPRESSION_NESTING), INDEX).ok).toBe(true);
    expect(refusal(nest(MAX_EXPRESSION_NESTING + 1))).toMatchObject({ key: 'tooNested', position: MAX_EXPRESSION_NESTING });
    expect(refusal(`${'!'.repeat(MAX_EXPRESSION_NESTING + 1)}(true)`)).toMatchObject({ key: 'tooNested', position: MAX_EXPRESSION_NESTING });
    expect(refusal(`all(${'all('.repeat(MAX_EXPRESSION_NESTING)}true)`).key).toBe('tooNested');
    expect(refusal('('.repeat(5000)).key).toBe('tooNested');
  });

  it('names the part that is missing', () => {
    const end = (text: string) => text.length;
    const cases: [string, string][] = [
      ['transaction.referenceNumber == "a" &&', 'expectedExpression'],
      ['transaction.', 'expectedField'],
      ['transaction.referenceNumber', 'expectedOperator'],
      ['transaction.referenceNumber == ', 'expectedValue'],
    ];
    for (const [text, key] of cases) expect(refusal(text)).toMatchObject({ key, position: end(text) });
    at('&& transaction.referenceNumber == "a"', 'expectedExpression', '&&');
    at('transaction.referenceNumber.contains()', 'expectedValue', ')');
    at('transaction.referenceNumber == )', 'expectedValue', ')');
    expect(refusal('(transaction.referenceNumber == "a"')).toMatchObject({
      key: 'expectedSymbol',
      args: { symbol: ')' },
      position: 35,
    });
    expect(refusal('transaction.type in ["EXPENSE"')).toMatchObject({ key: 'expectedSymbol', args: { symbol: ']' } });
    at('transaction.amount.between(1 2)', 'expectedSymbol', '2', { symbol: ',' });
    at(
      'transaction.referenceNumber == "a" transaction.referenceNumber == "b"',
      'unexpectedToken',
      'transaction',
      { token: 'transaction' },
      1,
    );
    at('transaction.referenceNumber == "a")', 'unexpectedToken', ')', { token: ')' });
    at('transaction.referenceNumber.contains "a"', 'expectedSymbol', '"a"', { symbol: '(' });
  });

  it('refuses what is outside the subset', () => {
    at('transaction.amount + 1 > 2', 'expectedOperator', '+');
    at('1 == 1', 'unsupported', '1');
    at('"abc"', 'unsupported', '"abc"');
    at('foo', 'unsupported', 'foo');
    expect(refusal('transaction')).toMatchObject({ key: 'expectedSymbol', args: { symbol: '.' }, position: 11 });
    at('transaction[0]', 'expectedSymbol', '[', { symbol: '.' });
    at('size(transaction.referenceNumber) > 1', 'unknownFunction', 'size', { name: 'size' });
    at('has(transaction.referenceNumber)', 'unknownFunction', 'has', { name: 'has' });
    at('transaction.referenceNumber == "a" ? true : false', 'unexpectedToken', '?', { token: '?' });
    at('a + b', 'unsupported', 'a');
    at('+ 1', 'unsupported', '+');
    at('all()', 'expectedExpression', ')');
    at('all(true, true)', 'expectedSymbol', ',', { symbol: ')' });
    at('isEmpty(5)', 'unsupported', '5');
    at('isEmpty(other.referenceNumber)', 'unsupported', 'other');
    expect(refusal('isEmpty(transaction.referenceNumber')).toMatchObject({ key: 'expectedSymbol', position: 35 });
  });

  it('refuses an unknown field, function or method', () => {
    at('transaction.nope == 1', 'unknownField', 'nope', { name: 'nope' });
    at('transaction.referenceNumber.matches("a.*")', 'unknownFunction', 'matches', { name: 'matches' });
    at('transaction.referenceNumber.size()', 'unknownFunction', 'size', { name: 'size' });
    expect(refusal('transaction.referenceNumber.')).toMatchObject({ key: 'expectedField', position: 28 });
    at('transaction.referenceNumber.contains("a").x', 'unexpectedToken', '.x', { token: '.' });
  });

  it('refuses an operator the field does not allow, at the operator', () => {
    at('transaction.type > "EXPENSE"', 'operatorNotAllowed', '>', { field: 'type', operator: '>' });
    at('transaction.type.contains("a")', 'operatorNotAllowed', 'contains', { field: 'type', operator: 'contains' });
    at('transaction.amount.contains("a")', 'operatorNotAllowed', 'contains', { field: 'amount', operator: 'contains' });
    at('transaction.tagIds == tag("Work")', 'operatorNotAllowed', '==', { field: 'tagIds', operator: '==' });
    at('transaction.hasSplits in [true]', 'operatorNotAllowed', 'in', { field: 'hasSplits', operator: 'in' });
    at('isEmpty(transaction.amount)', 'operatorNotAllowed', 'isEmpty', { field: 'amount', operator: 'isEmpty' });
    at('transaction.absAmount == 1', 'operatorNotAllowed', '==');
    at('!(transaction.type in ["INCOME"])', 'operatorNotAllowed', 'transaction', { field: 'type', operator: '!(... in ...)' });
  });

  it('refuses a value of the wrong kind', () => {
    at('transaction.amount == "5"', 'wrongValueType', '"5"', { expected: 'number' });
    at('transaction.amount == true', 'wrongValueType', 'true', { expected: 'number' });
    at('transaction.referenceNumber == 5', 'wrongValueType', '5', { expected: 'text' });
    at('transaction.referenceNumber == _', 'wrongValueType', '_', { expected: 'text' });
    at('transaction.hasSplits == "yes"', 'wrongValueType', '"yes"', { expected: 'boolean' });
    at('transaction.accountId == "RRSP"', 'wrongValueType', '"RRSP"', { expected: 'account' });
    at('transaction.accountId == payee("Amazon")', 'wrongValueType', 'payee', { expected: 'account' });
    at('transaction.accountId == account(5)', 'wrongValueType', '5', { expected: 'text' });
    at('transaction.accountId == account("RRSP", "x")', 'entityOrdinal', '"x"');
    at('transaction.accountId in account("RRSP")', 'wrongValueType', 'account(', { expected: 'list' });
    at('transaction.accountId in [_]', 'wrongValueType', '_', { expected: 'account' });
    at('transaction.accountId == missing("")', 'wrongValueType', '""', { expected: 'text' });
    at('transaction.accountId == nope("x")', 'unknownFunction', 'nope', { name: 'nope' });
    at('transaction.amount > 1e999', 'wrongValueType', '1e999', { expected: 'number' });
  });

  it('refuses a value the field cannot hold', () => {
    at('transaction.type == "EXPENSES"', 'invalidEnum', '"EXPENSES"', { values: 'EXPENSE, INCOME, TRANSFER' });
    at('transaction.currencyCode == "CADX"', 'invalidCurrency', '"CADX"');
    at(`transaction.referenceNumber == "${'x'.repeat(501)}"`, 'valueTooLong', '"x', { max: 500 });
    expect(parseCondition(`transaction.description.contains("${'x'.repeat(500)}")`, INDEX).ok).toBe(true);
    const codes = (n: number) => Array.from({ length: n }, () => '"CAD"').join(', ');
    expect(refusal(`transaction.currencyCode in [${codes(51)}]`)).toMatchObject({ key: 'listTooLong', args: { max: 50 } });
    expect(parseCondition(`transaction.currencyCode in [${codes(50)}]`, INDEX).ok).toBe(true);
  });

  it('refuses a name that is unknown, shared without a number, or numbered out of range', () => {
    at('transaction.accountId == account("Nope")', 'unknownEntity', '"Nope"', { kind: 'account', name: '"Nope"' });
    at('transaction.accountId == account("rrsp")', 'unknownEntity', '"rrsp"');
    at('transaction.accountId == account("Chequing")', 'ambiguousEntity', '"Chequing"', {
      name: '"Chequing"',
      count: 2,
      example: 'account("Chequing", 1)',
    });
    at('transaction.payeeId == payee("Amazon", 4)', 'entityOrdinal', '4', { name: '"Amazon"', count: 3 });
    at('transaction.payeeId == payee("Amazon", 0)', 'entityOrdinal', '0', { name: '"Amazon"', count: 3 });
    at('transaction.payeeId == payee("Amazon", 1.5)', 'entityOrdinal', '1.5');
    at('transaction.payeeId == payee("Nobody", 7)', 'unknownEntity', '"Nobody"');
    at('transaction.tagIds.hasAny([tag("Nope")])', 'unknownEntity', '"Nope"', { kind: 'tag', name: '"Nope"' });
  });

  it('refuses a tree over the depth, leaf or node limits, at the part that goes over', () => {
    const a = 'transaction.referenceNumber == "a"';
    const b = 'transaction.referenceNumber == "b"';
    const deep = `${a} && (${a} || (${a} && (${a} || (${b} && ${a}))))`;
    const error = refusal(deep);
    expect(error).toMatchObject({ key: 'maxDepth', args: { max: 4 } });
    expect(error.position).toBe(deep.indexOf(b));
    expect(parseCondition(`${a} && (${a} || (${a} && (${a} || ${a})))`, INDEX).ok).toBe(true);

    const leaves = Array.from({ length: 51 }, () => a);
    const tooMany = refusal(leaves.join(' && '));
    expect(tooMany).toMatchObject({ key: 'maxLeaves', args: { max: 50 } });
    expect(tooMany.position).toBe(leaves.slice(0, 50).join(' && ').length + 4);
    expect(parseCondition(leaves.slice(0, 50).join(' && '), INDEX).ok).toBe(true);

    // 49 leaves plus 51 empty groups: 101 nodes with the root, under the leaf limit.
    const nodes = [...Array.from({ length: 49 }, () => a), ...Array.from({ length: 51 }, () => 'true')].join(' && ');
    expect(refusal(nodes)).toMatchObject({ key: 'maxNodes', args: { max: 100 } });
  });

  it('reports a line and column a person can find', () => {
    const text = 'transaction.referenceNumber == "a" &&\n  transaction.nope == 1';
    const error = refusal(text);
    expect(error.key).toBe('unknownField');
    expect(lineColumn(text, error.position)).toEqual({ line: 2, column: 15 });
    expect(lineColumn('abc', 99)).toEqual({ line: 1, column: 4 });
  });

  it('has an error kind for every refusal it can make', () => {
    expect(new Set(CEL_ERROR_KEYS).size).toBe(CEL_ERROR_KEYS.length);
  });
});
