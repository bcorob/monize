import { describe, expect, it } from 'vitest';
import { tokenize, tokenizeLoose } from '@/lib/rule-cel/lexer';
import { CelSyntaxError } from '@/lib/rule-cel/types';

const kinds = (text: string) => tokenize(text).map((t) => `${t.kind}:${t.text}`);
const failure = (text: string) => {
  try {
    tokenize(text);
  } catch (error) {
    if (error instanceof CelSyntaxError) return error.error;
    throw error;
  }
  throw new Error('scanned');
};

describe('tokenize', () => {
  it('scans identifiers, numbers, strings and both lengths of operator', () => {
    expect(kinds('transaction.amount >= -1.5e2 && x != "a b"')).toEqual([
      'ident:transaction',
      'punct:.',
      'ident:amount',
      'punct:>=',
      'punct:-',
      'number:1.5e2',
      'punct:&&',
      'ident:x',
      'punct:!=',
      'string:"a b"',
      'eof:',
    ]);
  });

  it('decodes every escape, in both kinds of quote', () => {
    const [token] = tokenize('"\\\\ \\" \\\' \\n \\r \\t \\u0041"');
    expect(token.value).toBe('\\ " \' \n \r \t A');
    expect(tokenize("'it\\'s'")[0].value).toBe("it's");
  });

  it('gives each token its span', () => {
    const [a, b] = tokenize('  ab  "c"');
    expect([a.start, a.end, b.start, b.end]).toEqual([2, 4, 6, 9]);
  });

  it('scans a long run of numbers without slicing the text for each', () => {
    const tokens = tokenize('1 '.repeat(10000));
    expect(tokens).toHaveLength(10001);
  });

  it('refuses what is not a token, with the position', () => {
    expect(failure('a # b')).toMatchObject({ key: 'unexpectedChar', position: 2, args: { char: '#' } });
    expect(failure('"a\\q"')).toMatchObject({ key: 'invalidEscape', position: 2 });
    expect(failure('"abc')).toMatchObject({ key: 'unterminatedString', position: 0, length: 4 });
    expect(failure('1.5x')).toMatchObject({ key: 'badNumber', position: 0 });
    expect(failure('0x10')).toMatchObject({ key: 'badNumber' });
  });
});

describe('tokenizeLoose', () => {
  it('reports a string with no closing quote, decoded so far', () => {
    const { tokens, open } = tokenizeLoose('a == "b\\"c');
    expect(open).toEqual({ start: 5, value: 'b"c' });
    expect(tokens.map((t) => t.text)).toEqual(['a', '==', '']);
  });

  it('stops a half-typed string at the end of the line', () => {
    const { open } = tokenizeLoose('"abc\ndef');
    expect(open).toEqual({ start: 0, value: 'abc' });
  });

  it('skips a character or a number it cannot read instead of failing', () => {
    expect(tokenizeLoose('a # b').tokens.map((t) => t.text)).toEqual(['a', 'b', '']);
    expect(tokenizeLoose('12abc').tokens.map((t) => t.text)).toEqual(['abc', '']);
    expect(tokenizeLoose('"a\\qb"').tokens[0].value).toBe('ab');
  });
});
