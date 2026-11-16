import { describe, it, expect } from 'vitest';
import { textOrNull } from './form-text';

describe('textOrNull', () => {
  it('reads an empty field as no value', () => {
    expect(textOrNull('')).toBeNull();
  });

  it('reads a whitespace-only field as no value', () => {
    expect(textOrNull('  \t\n ')).toBeNull();
  });

  it('trims a value', () => {
    expect(textOrNull('  Acme Corp  ')).toBe('Acme Corp');
  });
});
