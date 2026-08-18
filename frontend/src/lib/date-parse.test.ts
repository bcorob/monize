import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildValidatedIsoDate,
  datePatternFieldOrder,
  datePatternLiteralChars,
  expandTwoDigitYear,
  formatByPattern,
  parseByPattern,
  parseFlexibleDate,
  resolveDateFormatPattern,
  tokenizeDatePattern,
} from './date-parse';

/** The reference the field passes in: today, or the date it already holds. */
const TODAY = new Date(2026, 8, 3); // 2026-09-03

afterEach(() => {
  vi.useRealTimers();
});

describe('tokenizeDatePattern', () => {
  it('cuts a pattern into fields and literals', () => {
    expect(tokenizeDatePattern('DD-MMM-YYYY')).toEqual([
      { type: 'day', text: 'DD' },
      { type: 'literal', text: '-' },
      { type: 'month', text: 'MMM' },
      { type: 'literal', text: '-' },
      { type: 'year', text: 'YYYY' },
    ]);
  });

  it('reads a multi-character literal as one token', () => {
    // ko renders "2026. 09. 14", and the separator is two characters.
    expect(tokenizeDatePattern('YYYY. MM. DD').filter((t) => t.type === 'literal'))
      .toEqual([
        { type: 'literal', text: '. ' },
        { type: 'literal', text: '. ' },
      ]);
  });
});

describe('datePatternFieldOrder', () => {
  it.each([
    ['MM/DD/YYYY', ['month', 'day', 'year']],
    ['DD/MM/YYYY', ['day', 'month', 'year']],
    ['YYYY-MM-DD', ['year', 'month', 'day']],
    ['DD-MMM-YYYY', ['day', 'month', 'year']],
  ])('reads %s as %s', (pattern, order) => {
    expect(datePatternFieldOrder(pattern)).toEqual(order);
  });
});

describe('datePatternLiteralChars', () => {
  it('collects the characters a pattern separates with', () => {
    expect([...datePatternLiteralChars('DD.MM.YYYY')]).toEqual(['.']);
  });
});

describe('formatByPattern', () => {
  it.each([
    ['YYYY-MM-DD', '2026-09-14'],
    ['MM/DD/YYYY', '09/14/2026'],
    ['DD/MM/YYYY', '14/09/2026'],
    ['DD-MMM-YYYY', '14-Sep-2026'],
    ['DD.MM.YYYY', '14.09.2026'],
  ])('renders %s', (pattern, expected) => {
    expect(formatByPattern(2026, 9, 14, pattern)).toBe(expected);
  });
});

describe('buildValidatedIsoDate', () => {
  it('rejects a day the month does not have', () => {
    expect(buildValidatedIsoDate(2025, 2, 29)).toBeNull();
    expect(buildValidatedIsoDate(2024, 2, 29)).toBe('2024-02-29');
  });

  it('rejects month 0 and month 13', () => {
    expect(buildValidatedIsoDate(2026, 0, 5)).toBeNull();
    expect(buildValidatedIsoDate(2026, 13, 5)).toBeNull();
  });
});

describe('resolveDateFormatPattern', () => {
  it('passes a concrete preference through unchanged', () => {
    expect(resolveDateFormatPattern('DD/MM/YYYY', 'en-GB')).toBe('DD/MM/YYYY');
  });

  it.each([
    ['en-US', 'MM/DD/YYYY'],
    ['en-GB', 'DD/MM/YYYY'],
    ['de-DE', 'DD.MM.YYYY'],
    ['sv-SE', 'YYYY-MM-DD'],
  ])('resolves the browser preference for %s', (locale, expected) => {
    expect(resolveDateFormatPattern('browser', locale)).toBe(expected);
  });

  it('trims a locale trailing separator so the user is not asked to type it', () => {
    // ko-KR formats as "2026. 09. 14." -- the final dot is decoration.
    expect(resolveDateFormatPattern('browser', 'ko-KR')).toBe('YYYY. MM. DD');
  });

  it('falls back to the unambiguous pattern when the locale cannot be read', () => {
    // A guess between day-first and month-first is exactly the thing that
    // silently changes what a date means, so failure degrades to ISO.
    expect(resolveDateFormatPattern('browser', 'not-a-locale-!!')).toBe('YYYY-MM-DD');
  });
});

describe('parseByPattern (strict)', () => {
  it('accepts the canonical form and an unpadded one', () => {
    expect(parseByPattern('09/14/2026', 'MM/DD/YYYY')).toBe('2026-09-14');
    expect(parseByPattern('9/14/2026', 'MM/DD/YYYY')).toBe('2026-09-14');
  });

  it('rejects a half-typed year rather than reading it as year 202', () => {
    expect(parseByPattern('09/14/202', 'MM/DD/YYYY')).toBeNull();
  });

  it('rejects the other pattern arrangement', () => {
    expect(parseByPattern('14/09/2026', 'MM/DD/YYYY')).toBeNull();
  });

  it('reads a month name case-insensitively', () => {
    expect(parseByPattern('14-SEP-2026', 'DD-MMM-YYYY')).toBe('2026-09-14');
  });

  it('rejects an impossible date that matches the shape', () => {
    expect(parseByPattern('02/30/2026', 'MM/DD/YYYY')).toBeNull();
  });
});

describe('parseFlexibleDate', () => {
  describe('the ambiguity the pattern is there to settle', () => {
    it('reads 7/8 as 8 July when the month comes first', () => {
      expect(parseFlexibleDate('7/8', 'MM/DD/YYYY', TODAY)).toBe('2026-07-08');
    });

    it('reads 7/8 as 7 August when the day comes first', () => {
      expect(parseFlexibleDate('7/8', 'DD/MM/YYYY', TODAY)).toBe('2026-08-07');
    });

    it('reads 7/8 as 8 July in the ISO pattern, whose remaining order is month then day', () => {
      expect(parseFlexibleDate('7/8', 'YYYY-MM-DD', TODAY)).toBe('2026-07-08');
    });

    it('reads a full short date the pattern way round', () => {
      expect(parseFlexibleDate('7/8/26', 'MM/DD/YYYY', TODAY)).toBe('2026-07-08');
      expect(parseFlexibleDate('7/8/26', 'DD/MM/YYYY', TODAY)).toBe('2026-08-07');
    });
  });

  describe('partial input', () => {
    it('completes 9-14 with the current year', () => {
      expect(parseFlexibleDate('9-14', 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
    });

    it('accepts any separator a person might reach for', () => {
      for (const input of ['9-14', '9/14', '9.14', '9 14', '9,14']) {
        expect(parseFlexibleDate(input, 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
      }
    });

    it('reads a lone number as a day in the month the field already shows', () => {
      // The reference date is the value in the field, not today, so correcting
      // the day of a date in March stays in March.
      expect(parseFlexibleDate('14', 'MM/DD/YYYY', new Date(2025, 2, 2)))
        .toBe('2025-03-14');
    });

    it('reads a compact 4-digit run as day and month', () => {
      expect(parseFlexibleDate('0914', 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
      expect(parseFlexibleDate('1409', 'DD/MM/YYYY', TODAY)).toBe('2026-09-14');
    });

    it('reads a compact 6- and 8-digit run through the pattern', () => {
      expect(parseFlexibleDate('091426', 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
      expect(parseFlexibleDate('09142026', 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
      expect(parseFlexibleDate('20260914', 'YYYY-MM-DD', TODAY)).toBe('2026-09-14');
    });

    it('refuses a month and a year with no day rather than inventing the 1st', () => {
      // Which day that means is a guess about the value, not about the format.
      expect(parseFlexibleDate('9/2026', 'MM/DD/YYYY', TODAY)).toBeNull();
    });
  });

  describe('what it takes whatever the pattern is', () => {
    it('reads an ISO date in a month-first pattern', () => {
      expect(parseFlexibleDate('2026-09-14', 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
    });

    it('takes a 4-digit run as the year wherever it sits', () => {
      expect(parseFlexibleDate('14/09/2026', 'YYYY-MM-DD', TODAY)).toBe('2026-09-14');
    });

    it('reads a month name, abbreviated or in full, in either position', () => {
      expect(parseFlexibleDate('14 sep', 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
      expect(parseFlexibleDate('September 14, 2026', 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
      expect(parseFlexibleDate('14 September 2026', 'DD/MM/YYYY', TODAY)).toBe('2026-09-14');
    });

    it('does not take a word that merely starts like a month', () => {
      expect(parseFlexibleDate('marketing 14', 'MM/DD/YYYY', TODAY)).toBeNull();
    });

    it('swaps day and month only where the ordered reading names no real date', () => {
      // 14 cannot be a month, so there is one thing this can mean...
      expect(parseFlexibleDate('14/9', 'MM/DD/YYYY', TODAY)).toBe('2026-09-14');
      // ...while this is a real date both ways round, and the pattern decides.
      expect(parseFlexibleDate('7/8', 'MM/DD/YYYY', TODAY)).toBe('2026-07-08');
    });
  });

  describe('two-digit years', () => {
    it('expands within a window that leans on the past', () => {
      expect(parseFlexibleDate('4/1/26', 'MM/DD/YYYY', TODAY)).toBe('2026-04-01');
      expect(parseFlexibleDate('4/1/46', 'MM/DD/YYYY', TODAY)).toBe('2046-04-01');
      // 2050 is beyond the forward window, so a ledger date of "50" is 1950.
      expect(parseFlexibleDate('4/1/50', 'MM/DD/YYYY', TODAY)).toBe('1950-04-01');
      expect(parseFlexibleDate('4/1/99', 'MM/DD/YYYY', TODAY)).toBe('1999-04-01');
    });

    it('moves the window with the reference year', () => {
      expect(expandTwoDigitYear(5, 2026)).toBe(2005);
      expect(expandTwoDigitYear(5, 1990)).toBe(2005);
    });
  });

  describe('what it refuses', () => {
    it.each([
      ['', 'empty'],
      ['   ', 'blank'],
      ['abc', 'a word that is no month'],
      ['13/45', 'no reading of which is a real date'],
      ['2/30', 'a day February does not have'],
      ['9/14/202', 'a year typed half way'],
      ['1/2/3/4', 'four numbers'],
      ['12345', 'a five-digit run'],
      ['9 14 @', 'a character that belongs to no date'],
    ])('returns null for %s (%s)', (input) => {
      expect(parseFlexibleDate(input, 'MM/DD/YYYY', TODAY)).toBeNull();
    });

    it('is null rather than today for unreadable input', () => {
      // A field showing a date must keep it: an unreadable entry is not the
      // user asking for today, and it is not them clearing the field either.
      expect(parseFlexibleDate('??', 'MM/DD/YYYY', TODAY)).toBeNull();
    });
  });

  it('defaults its reference to now when the caller supplies none', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2031, 0, 20));
    expect(parseFlexibleDate('3-4', 'MM/DD/YYYY')).toBe('2031-03-04');
  });
});
