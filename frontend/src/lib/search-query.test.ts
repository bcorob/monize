import { describe, expect, it } from 'vitest';
import { quoteSearchValue } from './search-query';

describe('quoteSearchValue', () => {
  it.each([
    ['Costco', 'payee:="Costco"'],
    ['Costco Gas Bar', 'payee:="Costco Gas Bar"'],
    ['Joe\'s "Best" Diner', 'payee:="Joe\'s \\"Best\\" Diner"'],
    ['C:\\path', 'payee:="C:\\\\path"'],
    ['#10', 'payee:="#10"'],
    ['-refund', 'payee:="-refund"'],
    ['SQ *COFFEE', 'payee:="SQ *COFFEE"'],
  ])('quotes %j as one exact payee term', (value, expected) => {
    expect(quoteSearchValue('payee', value)).toBe(expected);
  });

  it('escapes the backslash before the quote it introduces', () => {
    // `\"` in the value must become `\\\"`, not `\\"` (which would close the quote).
    expect(quoteSearchValue('memo', 'a\\"b')).toBe('memo:="a\\\\\\"b"');
  });

  it('writes a contains term when asked', () => {
    expect(quoteSearchValue('memo', 'Wire transfer', 'contains')).toBe('memo:"Wire transfer"');
  });
});
