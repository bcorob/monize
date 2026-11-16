import { describe, it, expect } from 'vitest';
import {
  filterNumberTyping,
  formatAmountLocalized,
  formatNumberForEdit,
  getNumberSeparators,
  normalizeExpression,
  normalizeNumeralText,
  parseLocaleNumber,
  stripGroupSeparator,
  type NumberSeparators,
} from './number-parse';
import { roundToDecimals } from '@/lib/format';

const EN: NumberSeparators = { decimal: '.', group: ',' };
// Polish groups with a no-break space; comma is the decimal.
const PL: NumberSeparators = { decimal: ',', group: ' ' };
// German groups with a dot; comma is the decimal.
const DE: NumberSeparators = { decimal: ',', group: '.' };

describe('getNumberSeparators', () => {
  it('reads the separators a locale displays with', () => {
    expect(getNumberSeparators('en-US')).toEqual({ decimal: '.', group: ',' });
    expect(getNumberSeparators('de-DE')).toEqual({ decimal: ',', group: '.' });
  });

  it('falls back to en-US separators for an unknown locale', () => {
    expect(getNumberSeparators('not-a-locale')).toEqual({ decimal: '.', group: ',' });
  });
});

describe('parseLocaleNumber', () => {
  it('parses en-US numbers (dot decimal, comma groups)', () => {
    expect(parseLocaleNumber('1,234.56', EN)).toBe(1234.56);
    expect(parseLocaleNumber('1234.56', EN)).toBe(1234.56);
    expect(parseLocaleNumber('1,234', EN)).toBe(1234); // single group comma
    expect(parseLocaleNumber('1,000,000', EN)).toBe(1000000);
    expect(parseLocaleNumber('5', EN)).toBe(5);
  });

  it('parses comma-decimal numbers a Polish user types or pastes', () => {
    expect(parseLocaleNumber('1200,99', PL)).toBe(1200.99); // the reported case
    expect(parseLocaleNumber('5,5', PL)).toBe(5.5);
    expect(parseLocaleNumber('1 234,56', PL)).toBe(1234.56); // grouped
    expect(parseLocaleNumber('1 234,56', PL)).toBe(1234.56); // plain space groups
  });

  it('still accepts a dot decimal for a comma-decimal locale', () => {
    // Robustness: a dot is not the Polish group separator, so it reads as decimal.
    expect(parseLocaleNumber('1200.99', PL)).toBe(1200.99);
  });

  it('reads a dot decimal correctly in a DOT-GROUP locale (no 100x inflation)', () => {
    // Regression: "." is the German GROUP separator, but a trailing run that is
    // not 3 digits cannot be a thousands group, so these are decimals, not 100x.
    expect(parseLocaleNumber('1200.99', DE)).toBe(1200.99);
    expect(parseLocaleNumber('5.5', DE)).toBe(5.5); // e.g. a 5.5% rate, not 55
    expect(parseLocaleNumber('0.75', DE)).toBe(0.75);
    // Valid grouping is still grouping: "1.234" and "1.234.567" are 1234 / 1234567.
    expect(parseLocaleNumber('1.234', DE)).toBe(1234);
    expect(parseLocaleNumber('1.234.567', DE)).toBe(1234567);
    // The native comma-decimal forms keep working.
    expect(parseLocaleNumber('1200,99', DE)).toBe(1200.99);
    expect(parseLocaleNumber('5,5', DE)).toBe(5.5);
  });

  it('reads a dot as the DECIMAL point in en-US, never as grouping', () => {
    // "." is the en-US decimal separator: "1.234" is one-point-two-three-four,
    // not 1234 (that would be the dot-group reading, which must not leak into en).
    expect(parseLocaleNumber('1.234', EN)).toBe(1.234);
    expect(parseLocaleNumber('1.5', EN)).toBe(1.5);
    // A European-style dot-grouped paste still resolves to the whole number.
    expect(parseLocaleNumber('1.000.000', EN)).toBe(1000000);
  });

  it('reads Indian lakh grouping (2-2-3), not a decimal', () => {
    // Repeated group separators are grouping whatever the group sizes -- this is
    // how a lakh-grouped displayed value (hi/en-IN) pastes back in.
    expect(parseLocaleNumber('12,34,567', EN)).toBe(1234567);
    expect(parseLocaleNumber('1,23,456', EN)).toBe(123456);
  });

  it('uses the LAST separator as the decimal when both appear', () => {
    expect(parseLocaleNumber('1.234,56', DE)).toBe(1234.56);
    expect(parseLocaleNumber('1,234.56', EN)).toBe(1234.56);
  });

  it('handles a leading minus and rejects non-numbers', () => {
    expect(parseLocaleNumber('-5,5', PL)).toBe(-5.5);
    expect(parseLocaleNumber('', EN)).toBeUndefined();
    expect(parseLocaleNumber('-', EN)).toBeUndefined();
    expect(parseLocaleNumber('abc', EN)).toBeUndefined();
  });
});

describe('filterNumberTyping', () => {
  it('keeps both separators (parse disambiguates) and drops junk', () => {
    // Both "." and "," survive typing so parseLocaleNumber can disambiguate them
    // -- eagerly stripping a "." destroyed a dot-decimal in a dot-group locale.
    expect(filterNumberTyping('1,234.56')).toBe('1,234.56');
    expect(filterNumberTyping('1.200,99')).toBe('1.200,99');
    expect(filterNumberTyping('abc12.3')).toBe('12.3');
  });

  it('keeps a comma decimal and drops a no-break-space group', () => {
    expect(filterNumberTyping('1 234,56')).toBe('1234,56');
    expect(filterNumberTyping('5,5')).toBe('5,5');
  });

  it('keeps a leading minus only when allowed', () => {
    expect(filterNumberTyping('-5,5', { allowNegative: true })).toBe('-5,5');
    expect(filterNumberTyping('-5,5')).toBe('5,5');
  });

  it('keeps and normalizes operators when allowed', () => {
    expect(filterNumberTyping('100*1,13', { allowOperators: true })).toBe('100*1,13');
    expect(filterNumberTyping('100×2', { allowOperators: true })).toBe('100*2');
  });

  it('keeps spaces around operators in the calculator, drops them in a plain field', () => {
    expect(filterNumberTyping('100 + 20', { allowOperators: true })).toBe('100 + 20');
    expect(filterNumberTyping('1 2')).toBe('12'); // no operators: space is a group sep
  });
});

describe('stripGroupSeparator', () => {
  it('removes a dot/comma group but keeps the decimal separator', () => {
    expect(stripGroupSeparator('1,234.56', EN)).toBe('1234.56');
    expect(stripGroupSeparator('1.234,56', DE)).toBe('1234,56');
  });

  it('removes a whitespace group (no-break/narrow spaces)', () => {
    expect(stripGroupSeparator('1 234,56', PL)).toBe('1234,56');
  });
});

describe('formatNumberForEdit', () => {
  it('formats with the locale decimal, no grouping', () => {
    expect(formatNumberForEdit(1200.99, 2, EN)).toBe('1200.99');
    expect(formatNumberForEdit(1200.99, 2, PL)).toBe('1200,99');
    expect(formatNumberForEdit(0, 2, PL)).toBe('0,00');
    expect(formatNumberForEdit(undefined, 2, PL)).toBe('');
  });
});

describe('normalizeExpression', () => {
  it('maps a comma-decimal expression to the dot-decimal evaluator form', () => {
    expect(normalizeExpression('100*1,13', PL)).toBe('100*1.13');
    expect(normalizeExpression('1.234,56+1', DE)).toBe('1234.56+1');
  });

  it('strips en-US grouping commas and keeps dots', () => {
    expect(normalizeExpression('1,234*2', EN)).toBe('1234*2');
    expect(normalizeExpression('100*1.13', EN)).toBe('100*1.13');
  });

  it('reads a dot-typed decimal in a dot-group locale, agreeing with the field', () => {
    // Regression: the calculator must not inflate "1.13" to 113 in de/fr. Each
    // number token is disambiguated by digit count, like parseLocaleNumber.
    expect(normalizeExpression('100*1.13', DE)).toBe('100*1.13'); // -> 113, not 11300
    // A valid de group "1.234" is still 1234 -- same as the field reads it.
    expect(normalizeExpression('1.234*2', DE)).toBe('1234*2');
  });
});

describe('formatAmountLocalized', () => {
  it('formats en-US through the comma formatter (grouped, fixed decimals)', () => {
    expect(formatAmountLocalized(1234.5, 2, EN, 'en-US')).toBe('1,234.50');
    expect(formatAmountLocalized(1234.5, 2, EN, undefined)).toBe('1,234.50');
    // The decimals argument is honoured (a price at 4dp).
    expect(formatAmountLocalized(1.2, 4, EN, 'en-US')).toBe('1.2000');
  });

  it('formats a comma-decimal locale with its own separators', () => {
    // pl groups with a no-break space and a comma decimal.
    const pl = formatAmountLocalized(1234.5, 2, PL, 'pl');
    expect(pl).toContain(',50');
    expect(pl).not.toContain('.'); // no dot decimal for a pl reader
    // de groups with a dot, comma decimal.
    expect(formatAmountLocalized(1234.5, 2, DE, 'de-DE')).toBe('1.234,50');
  });

  it('gives an Indian locale lakh grouping, not en-US grouping', () => {
    // hi shares "." decimal and "," group with en-US but groups by lakh, so it
    // must take the Intl branch rather than the en-US delegation.
    expect(formatAmountLocalized(1234567, 0, { decimal: '.', group: ',' }, 'hi')).toBe(
      '12,34,567',
    );
  });

  it('returns empty for a missing value and survives an invalid locale', () => {
    expect(formatAmountLocalized(undefined, 2, EN, 'en-US')).toBe('');
    expect(formatAmountLocalized(null, 2, EN, 'en-US')).toBe('');
    expect(formatAmountLocalized(NaN, 2, EN, 'en-US')).toBe('');
    // An invalid locale falls back to the en-US formatter rather than throwing.
    expect(formatAmountLocalized(1234.5, 2, EN, 'not-a-locale')).toBe('1,234.50');
  });
});

// Egyptian Arabic: native digits are Arabic-Indic and the native separators are
// U+066B / U+066C, while the latn form the input fields work in is "." / ",".
const AR: NumberSeparators = { decimal: '.', group: ',', nativeDecimal: '\u066B', nativeGroup: '\u066C' };

describe('getNumberSeparators: latn form plus native symbols', () => {
  it('reports latn separators and the differing native symbols for ar-EG', () => {
    expect(getNumberSeparators('ar-EG')).toEqual(AR);
  });

  it('omits native symbols where the latn and native forms coincide', () => {
    expect(getNumberSeparators('de-DE')).toEqual({ decimal: ',', group: '.' });
    expect(getNumberSeparators('en-US')).toEqual({ decimal: '.', group: ',' });
  });
});

describe('normalizeNumeralText', () => {
  it('maps Unicode decimal digits of any script to ASCII', () => {
    expect(normalizeNumeralText('\u0661\u0662\u0660\u0660', EN)).toBe('1200'); // Arabic-Indic
    expect(normalizeNumeralText('\u06F1\u06F2\u06F3\u06F4', EN)).toBe('1234'); // Persian
    expect(normalizeNumeralText('\u0967\u0968\u0969', EN)).toBe('123'); // Devanagari
  });

  it('maps the native decimal/group symbols to the latn ones, drops bidi marks, maps U+2212', () => {
    expect(normalizeNumeralText('\u0661\u066C\u0662\u0660\u0660\u066B\u0669\u0669', AR)).toBe('1,200.99');
    expect(normalizeNumeralText('\u061C-\u0664\u0662\u066B\u0661\u0660', AR)).toBe('-42.10');
    expect(normalizeNumeralText('\u200E\u2212\u06F4\u06F2\u066B\u06F1\u06F0', AR)).toBe('-42.10');
  });

  it('passes latn text through unchanged (the en-US path is untouched)', () => {
    expect(normalizeNumeralText('1,234.56', EN)).toBe('1,234.56');
    expect(normalizeNumeralText('100*1.13', EN)).toBe('100*1.13');
  });
});

describe('ar-EG input pipeline (browser-locale numbering system)', () => {
  it('parses native and latn text alike', () => {
    expect(parseLocaleNumber('\u0661\u066C\u0662\u0660\u0660\u066B\u0669\u0669', AR)).toBe(1200.99);
    expect(parseLocaleNumber('1200\u066B995', AR)).toBe(1200.995); // was 1200995
    expect(parseLocaleNumber('1200.99', AR)).toBe(1200.99);
  });

  it('filter keeps a native paste as a parseable latn string instead of discarding it', () => {
    // The audit scenario: focused native text plus one typed ASCII digit.
    expect(filterNumberTyping('\u0661\u0662\u0660\u0660\u066B\u0669\u06695', { separators: AR })).toBe('1200.995');
    expect(filterNumberTyping('1200\u066B995', { separators: AR })).toBe('1200.995');
  });

  it('calculator canonicalizes native digits and separators', () => {
    expect(normalizeExpression('\u0661\u0660\u0660*\u0661\u066B\u0661\u0663', AR)).toBe('100*1.13');
    expect(normalizeExpression('1200\u066B99+0.01', AR)).toBe('1200.99+0.01');
  });

  it('formats the editable field in latn digits and read-only surfaces natively', () => {
    expect(formatAmountLocalized(1200.99, 2, AR, 'ar-EG', { latnDigits: true })).toBe('1,200.99');
    expect(formatAmountLocalized(1200.99, 2, AR, 'ar-EG')).toBe('\u0661\u066C\u0662\u0660\u0660\u066B\u0669\u0669');
  });

  it('strips the group separator from a native display on focus', () => {
    expect(stripGroupSeparator('\u0661\u066C\u0662\u0660\u0660\u066B\u0669\u0669', AR)).toBe('1200.99');
  });
});

describe('round trip: what the input pipeline formats, it parses back', () => {
  // The invariant behind every locale case above: text emitted by the field's
  // own display, by a native read-only display, or by the blur edit-format must
  // parse back to the same number, for Latin and non-Latin numbering systems.
  const locales = ['en-US', 'pl', 'de-DE', 'hi', 'ar-EG', 'fa-IR'];
  const values = [0, 5.5, 1200.99, 1234567.89, -42.1];
  it.each(locales)('%s', (locale) => {
    const seps = getNumberSeparators(locale);
    for (const v of values) {
      const expected = roundToDecimals(v, 2);
      expect(parseLocaleNumber(formatAmountLocalized(v, 2, seps, locale, { latnDigits: true }), seps)).toBe(expected);
      expect(parseLocaleNumber(formatAmountLocalized(v, 2, seps, locale), seps)).toBe(expected);
      expect(parseLocaleNumber(formatNumberForEdit(v, 2, seps), seps)).toBe(expected);
      const typed = filterNumberTyping(formatAmountLocalized(v, 2, seps, locale), { allowNegative: true, separators: seps });
      expect(parseLocaleNumber(typed, seps)).toBe(expected);
    }
  });
});
