import { describe, it, expect } from 'vitest';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts a UUID in either case', () => {
    expect(isUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('rejects a synthetic key, a truncated id and a padded one', () => {
    expect(isUuid('temp-1')).toBe(false);
    expect(isUuid('override-0')).toBe(false);
    expect(isUuid('3f2504e0-4f89-11d3-9a0c-0305e82c330')).toBe(false);
    expect(isUuid(' 3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false);
  });

  it('rejects an absent value', () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
