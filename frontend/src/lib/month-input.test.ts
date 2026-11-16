import { describe, it, expect } from 'vitest';
import { parseMonthInput } from './month-input';
import common from '@/i18n/messages/en/common.json';

const LABELS = common.monthsShort as string[];
/** The month on screen, which supplies whatever a partial entry leaves out. */
const ON_SCREEN = '2026-06';

const parse = (text: string, fallback = ON_SCREEN) =>
  parseMonthInput(text, LABELS, fallback);

describe('parseMonthInput', () => {
  it('reads the canonical form', () => {
    expect(parse('2026-03')).toBe('2026-03');
    expect(parse('1998-12')).toBe('1998-12');
  });

  it('reads a four-digit part as the year wherever it sits', () => {
    // This is what separates 06/2026 from 2026/06 without having to know the
    // reader's date-ordering preference.
    expect(parse('03/1998')).toBe('1998-03');
    expect(parse('1998/03')).toBe('1998-03');
    expect(parse('3.1998')).toBe('1998-03');
    expect(parse('1998 3')).toBe('1998-03');
  });

  it('reads a packed six-digit month', () => {
    expect(parse('199803')).toBe('1998-03');
  });

  it('reads a bare year as that year, keeping the month on screen', () => {
    expect(parse('1998')).toBe('1998-06');
    expect(parse('1998', '2026-11')).toBe('1998-11');
  });

  it('reads a bare month number as that month of the year on screen', () => {
    expect(parse('3')).toBe('2026-03');
    expect(parse('03')).toBe('2026-03');
    expect(parse('12')).toBe('2026-12');
  });

  it('reads a month name, abbreviated or written out', () => {
    expect(parse('mar')).toBe('2026-03');
    expect(parse('March')).toBe('2026-03');
    expect(parse('  MARCH  ')).toBe('2026-03');
  });

  it('reads a month name with a year on either side of it', () => {
    expect(parse('Mar 1998')).toBe('1998-03');
    expect(parse('1998 March')).toBe('1998-03');
    expect(parse('march, 1998')).toBe('1998-03');
  });

  it('refuses a month number that is not a month', () => {
    expect(parse('13')).toBeNull();
    expect(parse('0')).toBeNull();
    expect(parse('2026-13')).toBeNull();
    expect(parse('2026-00')).toBeNull();
  });

  it('refuses a word that is not a month', () => {
    expect(parse('tuesday')).toBeNull();
    expect(parse('next')).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse('   ')).toBeNull();
  });

  it('refuses a prefix two months would answer to, rather than guessing', () => {
    // A reader who typed it gets the field's error and one more letter fixes
    // it; a guess would move the calendar somewhere they did not ask for.
    expect(parseMonthInput('ju', ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], ON_SCREEN)).toBeNull();
    expect(parse('ma')).toBeNull();
  });

  it('reads the month labels it is handed, not English ones', () => {
    const german = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

    expect(parseMonthInput('mär', german, ON_SCREEN)).toBe('2026-03');
    expect(parseMonthInput('okt 1998', german, ON_SCREEN)).toBe('1998-10');
    // A prefix of the label works too, so a reader need not type the umlaut.
    expect(parseMonthInput('dez', german, ON_SCREEN)).toBe('2026-12');
  });

  it('refuses a year outside what a calendar date can hold', () => {
    expect(parse('0000-03')).toBeNull();
  });
});
